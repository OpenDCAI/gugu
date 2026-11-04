import { execFile } from '@gugu/core/local/childProcess';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { promisify } from 'node:util';
import { app, clipboard, nativeImage } from 'electron';
import { MAX_ATTACHMENT_BYTES } from '@gugu/session-core/session-record/contract';

export const MAX_DROPPED_BLOB_BYTES = MAX_ATTACHMENT_BYTES;
export const DROPPED_BLOB_FILENAME_PREFIX = 'gugu-drop-';
export const DROPPED_BLOB_DIRECTORY_NAME = 'gugu-dropped-blobs';
export const DROPPED_BLOB_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const execFileAsync = promisify(execFile);
const persistedDroppedBlobPaths = new Set<string>();
let cleanupRegistered = false;

const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'image/heic': '.heic',
  'image/heif': '.heif',
};

export function sanitizeDroppedBlobName(name: string | undefined): string {
  if (!name) return '';
  const base = basename(name).replace(/[^A-Za-z0-9._-]/g, '_');
  return base.slice(0, 64);
}

export function inferDroppedBlobExtension(
  name: string | undefined,
  mimeType: string | undefined
): string {
  const fromName = name ? extname(name).toLowerCase() : '';
  if (fromName) return fromName;
  if (mimeType && MIME_TO_EXT[mimeType.toLowerCase()]) return MIME_TO_EXT[mimeType.toLowerCase()];
  return '.bin';
}

export function isHeicLike(args: { name?: string; mimeType?: string; ext?: string }): boolean {
  const ext = args.ext ?? inferDroppedBlobExtension(args.name, args.mimeType);
  if (ext === '.heic' || ext === '.heif') return true;
  const mime = args.mimeType?.toLowerCase() ?? '';
  return mime.includes('heic') || mime.includes('heif');
}

/**
 * Claude Code and most vision models cannot read HEIC directly. macOS clipboard
 * and drag sources often supply HEIC — convert to PNG before persisting.
 */
export async function normalizeDroppedImageBytes(
  bytes: Uint8Array,
  args: { name?: string; mimeType?: string }
): Promise<{ bytes: Uint8Array; ext: string }> {
  const ext = inferDroppedBlobExtension(args.name, args.mimeType);
  if (!isHeicLike({ ...args, ext })) {
    return { bytes, ext };
  }

  const image = nativeImage.createFromBuffer(Buffer.from(bytes));
  if (!image.isEmpty()) {
    const png = image.toPNG();
    if (png.byteLength > 0) return { bytes: new Uint8Array(png), ext: '.png' };
  }

  return { bytes: await convertHeicLikeBytesToPng(bytes, ext), ext: '.png' };
}

async function convertHeicLikeBytesToPng(bytes: Uint8Array, ext: string): Promise<Uint8Array> {
  if (process.platform !== 'darwin') {
    throw new Error('HEIC/HEIF image conversion is only supported on macOS');
  }

  const tempDir = await mkdtemp(join(app.getPath('temp'), 'gugu-heic-'));
  const inputPath = join(tempDir, `input${ext === '.heif' ? '.heif' : '.heic'}`);
  const outputPath = join(tempDir, 'output.png');

  try {
    await writeFile(inputPath, bytes);
    await execFileAsync('/usr/bin/sips', ['-s', 'format', 'png', inputPath, '--out', outputPath]);
    const png = await readFile(outputPath);
    if (png.byteLength === 0) throw new Error('sips produced an empty PNG');
    return new Uint8Array(png);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to convert HEIC/HEIF image to PNG: ${message}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function persistDroppedBlobBytes(args: {
  bytes: Uint8Array;
  name?: string;
  mimeType?: string;
}): Promise<string> {
  if (args.bytes.byteLength > MAX_DROPPED_BLOB_BYTES) {
    throw new Error(`Dropped file is too large (${args.bytes.byteLength} bytes)`);
  }

  const normalized = await normalizeDroppedImageBytes(args.bytes, {
    name: args.name,
    mimeType: args.mimeType,
  });
  if (normalized.bytes.byteLength > MAX_DROPPED_BLOB_BYTES) {
    throw new Error(`Dropped file is too large (${normalized.bytes.byteLength} bytes)`);
  }

  const safe = sanitizeDroppedBlobName(args.name?.replace(/\.[^.]+$/, ''));
  const filename = `${DROPPED_BLOB_FILENAME_PREFIX}${randomUUID()}${safe ? `-${safe}` : ''}${normalized.ext}`;
  const directory = join(app.getPath('temp'), DROPPED_BLOB_DIRECTORY_NAME);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const fullPath = join(directory, filename);
  await writeFile(fullPath, normalized.bytes);
  trackPersistedDroppedBlob(fullPath);
  return fullPath;
}

function trackPersistedDroppedBlob(path: string): void {
  persistedDroppedBlobPaths.add(path);
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  app.once('will-quit', () => {
    cleanupPersistedDroppedBlobsSync();
  });
}

function cleanupPersistedDroppedBlobsSync(): void {
  for (const path of persistedDroppedBlobPaths) {
    rmSync(path, { force: true });
    persistedDroppedBlobPaths.delete(path);
  }
}

export async function cleanupExpiredDroppedBlobs(
  now = Date.now(),
  tempRoot = app.getPath('temp')
): Promise<void> {
  const directory = join(tempRoot, DROPPED_BLOB_DIRECTORY_NAME);
  const entries = await readdir(directory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });

  for (const entry of entries) {
    const path = join(directory, entry);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) continue;
    if (now - info.mtimeMs < DROPPED_BLOB_MAX_AGE_MS) continue;
    await rm(path, { force: true });
  }
}

/** Read a raster image from the OS clipboard and persist it as PNG. */
export async function persistClipboardImagePath(): Promise<string | null> {
  // @@@electron44-clipboard (#4394) — electron 44 删掉了 clipboard.readImage(),换成 W3C 的
  // clipboard.read() → ClipboardItem[]。旧 readImage() 吃任意位图格式、并且 .toPNG() 顺带转码;
  // 新 API 只按 MIME 给原始字节,两件事都不再免费。
  //
  // 实测(macOS 26.5.2 + electron 44,原生 `as TIFF picture` 复制一张图):read() 给出的是
  //   image/png, electron application/osclipboard;format="NeXT TIFF v4.0 pasteboard type"
  // —— **electron 已经替我们归一化成了 image/png**,原始 TIFF 只在 electron 私有命名空间里露出,
  // 并不会以 image/tiff 的形式出现。所以 mac 上走的就是下面 PNG 优先那一支。
  //
  // 那为什么还要「认所有 image/*、非 PNG 再转码」这一层:归一化是 electron 的实现细节而非契约,
  // 且 Windows/Linux 与未来版本未必照做。这层兜底不为救 mac(mac 本来就给 png),
  // 是为了别在别的平台上因为「只认 png」而静默拿不到图。
  const items = await clipboard.read();
  const imageTypes = items.flatMap((item) =>
    item.types.filter((type) => type.startsWith('image/')).map((type) => ({ item, type })),
  );
  const picked = imageTypes.find((t) => t.type === 'image/png') ?? imageTypes[0];
  if (!picked) return null;

  const blob = (await picked.item.getType(picked.type)) as Blob;
  const raw = Buffer.from(await blob.arrayBuffer());
  if (raw.byteLength === 0) return null;

  const png =
    picked.type === 'image/png' ? raw : Buffer.from(nativeImage.createFromBuffer(raw).toPNG());
  if (png.byteLength === 0) return null;

  return persistDroppedBlobBytes({
    bytes: new Uint8Array(png),
    name: 'paste.png',
    mimeType: 'image/png',
  });
}
