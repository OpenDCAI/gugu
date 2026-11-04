import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import JSZip from 'jszip';
import { EXTENSION_ARCHIVE_MIME } from '@gugu/core/shared/imageMime.mjs';
import type { ExtensionManifest } from '@shared/extensions/manifest';
import { BUNDLE_SKIP_NAMES } from '@shared/extensions/market';
import { STORE_DIR } from '@shared/extensions/app-listing';
import { validateExtensionBundle, type ExtensionBundleReport } from './extension-validate';
import type { ExtensionsService } from './extensions-service';
import { unpackBundle } from './market-catalog';

/**
 * `.guguext`: an extension bundle as one file, to send in chat (#6646).
 *
 * Invariants:
 * - Only a bundle that passes the package checks (`validateExtensionBundle`, the ones install runs) is packed,
 *   and packing is deterministic: the same files give the same bytes, so the same fingerprint.
 * - Unpacking goes through the market's own unpacker (entry count, unpacked size, paths; an archived
 *   link lands as a plain file), then the same checks again — nothing unchecked reaches an install.
 */

export { EXTENSION_ARCHIVE_MIME };
export const EXTENSION_ARCHIVE_SUFFIX = '.guguext';

type Inspector = Pick<ExtensionsService, 'inspectDirectory'>;

export async function packExtensionArchive(
  service: Inspector,
  sourceDir: string
): Promise<{ bytes: Buffer; sha256: string; manifest: ExtensionManifest }> {
  const report = validateExtensionBundle(service, sourceDir);
  if (!report.ok || !report.inspected) throw new Error(`not packed, the bundle has problems:\n- ${report.problems.join('\n- ')}`);
  const root = path.resolve(sourceDir);
  const zip = new JSZip();
  for (const file of bundleFiles(root)) {
    // Match the market's packDir bytes, including its epoch date and absence of directory entries.
    zip.file(path.relative(root, file).split(path.sep).join('/'), fs.readFileSync(file), { date: new Date(0), createFolders: false });
  }
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  return { bytes, sha256: sha256(bytes), manifest: report.inspected.manifest };
}

/**
 * #6646 Packs an installed extension as a `.guguext`, from a copy: a bundle is only checked outside the extensions
 * root, and links are copied as links so the check sees them. The Apps page's 「转发」 and an agent sending a market
 * App into a chat (`app_install { market, chat_id }`) both pack what is installed this way.
 */
export async function packInstalledExtension(
  service: Pick<ExtensionsService, 'inspectDirectory' | 'get'>,
  extensionId: string
): Promise<{ bytes: Buffer; sha256: string; fileName: string; manifest: ExtensionManifest }> {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-export-'));
  try {
    const installed = service.get(extensionId);
    const copy = path.join(staging, installed.manifest.id);
    fs.cpSync(installed.rootDir, copy, { recursive: true, dereference: false, verbatimSymlinks: true });
    const { bytes, sha256, manifest } = await packExtensionArchive(service, copy);
    return { bytes, sha256, fileName: `${manifest.id}-${manifest.version}${EXTENSION_ARCHIVE_SUFFIX}`, manifest };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Unpacks into a new folder under `stagingRoot`; the folder is removed again if anything fails. */
export async function unpackExtensionArchive(
  service: Inspector,
  bytes: Uint8Array,
  stagingRoot: string
): Promise<{ dir: string; sha256: string; report: ExtensionBundleReport }> {
  const dir = path.join(stagingRoot, `.guguext-${randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    await unpackBundle(bytes, dir);
    const report = validateExtensionBundle(service, dir);
    if (!report.ok) throw new Error(`this App package has problems:\n- ${report.problems.join('\n- ')}`);
    return { dir, sha256: sha256(bytes), report };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Every file to pack, in the market publisher's recursive en-US order, skipping the same names and the top-level `store/` (the market listing, never part of the App). */
function bundleFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en-US'));
    for (const entry of entries) {
      if (BUNDLE_SKIP_NAMES.has(entry.name) || (dir === root && entry.name === STORE_DIR)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(root);
  return files;
}
