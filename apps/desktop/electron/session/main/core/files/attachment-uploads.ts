import { requireAgentFileTreeAccess } from '@gugu/core/local/state/agentFileBoundary';
/** Durable task-attachment uploads. Editor saves keep their separate writeChunk contract. */
import { constants } from 'node:fs';
import { mkdir, open, readdir, lstat, link, unlink, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  ATTACHMENT_UPLOAD_CHUNK_BYTES, MAX_ATTACHMENT_BYTES,
  type AttachmentUploadSpec, type AttachmentUploadChunk, type AttachmentUploadState,
} from '@gugu/session-core/session-record/contract';
import { inWorkspace, WorkspaceTransferError } from './workspace-transfer';

const MAX_AGE_MS = 24 * 60 * 60_000;
const ID = /^[a-zA-Z0-9_-]{8,96}$/;
const HASH = /^[a-f0-9]{64}$/;
type Saved = { spec: AttachmentUploadSpec; received: number; state: 'uploading' | 'committed'; expires: number };
const fail = (code: string, message: string): never => { throw new WorkspaceTransferError(code, message); };
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function digest(file: string): Promise<string> {
  const value = createHash('sha256');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { for await (const bytes of handle.createReadStream({ autoClose: false })) value.update(bytes); }
  finally { await handle.close(); }
  return value.digest('hex');
}
function validate(spec: AttachmentUploadSpec) {
  if (!spec || !ID.test(spec.uploadId) || !ID.test(spec.itemId) || !HASH.test(spec.sha256)
    || typeof spec.name !== 'string' || !spec.name || spec.name.length > 255 || /^[.]{1,2}$/.test(spec.name)
    || /[\\/\0]/.test(spec.name) || !Number.isSafeInteger(spec.size) || spec.size < 0 || spec.size > MAX_ATTACHMENT_BYTES) {
    fail('invalid_payload', 'Invalid attachment upload descriptor');
  }
}
function same(a: AttachmentUploadSpec, b: AttachmentUploadSpec) {
  return ['uploadId', 'itemId', 'name', 'size', 'sha256'].every(key => a[key as keyof AttachmentUploadSpec] === b[key as keyof AttachmentUploadSpec]);
}
async function directory(root: string, relative: string) {
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    await inWorkspace(root, current);
    await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('outside_workspace', 'Attachment directory is not a real workspace directory');
    await inWorkspace(root, current);
  }
  return current;
}
async function readSaved(file: string): Promise<Saved> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return JSON.parse(await handle.readFile('utf8')) as Saved; }
  finally { await handle.close(); }
}
async function save(file: string, saved: Saved) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(saved)); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, file);
}
function view(saved: Saved): AttachmentUploadState {
  return { state: saved.state, received: saved.received, total: saved.spec.size,
    chunkBytes: ATTACHMENT_UPLOAD_CHUNK_BYTES, workspacePath: `.gugu/attachments/${saved.spec.itemId}/${saved.spec.name}` };
}

export function createAttachmentUploads({ now = Date.now, maxAgeMs = MAX_AGE_MS } = {}) {
  const locks = new Map<string, Promise<void>>();
  const swept = new Map<string, number>();
  async function locked<T>(root: string, spec: AttachmentUploadSpec, action: () => Promise<T>): Promise<T> {
    validate(spec);
    const key = `${path.resolve(root)}\0${spec.uploadId}`;
    const running = (locks.get(key) ?? Promise.resolve()).then(async () => {
      await requireAgentFileTreeAccess(root);
      return action();
    });
    const settled = running.then(() => undefined, () => undefined);
    locks.set(key, settled);
    try { return await running; }
    finally { if (locks.get(key) === settled) locks.delete(key); }
  }
  async function paths(root: string, spec: AttachmentUploadSpec) {
    const staging = await directory(root, '.gugu/attachments/.incoming');
    const dir = await directory(root, `.gugu/attachments/.incoming/${spec.uploadId}`);
    const targetDir = await directory(root, `.gugu/attachments/${spec.itemId}`);
    return { staging, dir, meta: path.join(dir, 'upload.json'), part: path.join(dir, 'data.part'), target: path.join(targetDir, spec.name) };
  }
  async function cleanup(staging: string) {
    if (now() - (swept.get(staging) ?? -Infinity) < 10 * 60_000) return;
    swept.set(staging, now());
    for (const entry of await readdir(staging, { withFileTypes: true })) {
      if (!ID.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      const dir = path.join(staging, entry.name);
      try {
        const saved = await readSaved(path.join(dir, 'upload.json'));
        if (Number.isFinite(saved.expires) && saved.expires < now()) await rm(dir, { recursive: true, force: true });
      } catch (error) { if (!missing(error)) throw error; }
    }
  }
  async function load(p: Awaited<ReturnType<typeof paths>>, spec: AttachmentUploadSpec): Promise<Saved> {
    let saved: Saved;
    try { saved = await readSaved(p.meta); }
    catch (error) { if (missing(error)) return fail('upload_lost', 'This upload has no retained partial data'); throw error; }
    if (!same(saved.spec, spec) || !Number.isSafeInteger(saved.received) || saved.received < 0 || saved.received > spec.size
      || !['uploading', 'committed'].includes(saved.state) || !Number.isFinite(saved.expires)) fail('invalid_payload', 'Upload identity does not match this file');
    if (saved.expires < now()) fail('upload_expired', 'The retained upload expired; upload this file again');
    // A crash or lost reply after publication must not cause another upload.
    try {
      const info = await lstat(p.target);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== spec.size || await digest(p.target) !== spec.sha256) {
        fail('conflict', 'The attachment destination contains a different file');
      }
      if (saved.state !== 'committed') {
        saved = { ...saved, received: spec.size, state: 'committed', expires: now() + maxAgeMs };
        await save(p.meta, saved);
      }
    } catch (error) { if (!missing(error)) throw error; else if (saved.state === 'committed') fail('upload_lost', 'The committed attachment is no longer available'); }
    return saved;
  }
  return {
    begin: (root: string, spec: AttachmentUploadSpec) => locked(root, spec, async () => {
      const p = await paths(root, spec);
      try { return view(await load(p, spec)); }
      catch (error) { if (!(error instanceof WorkspaceTransferError) || error.code !== 'upload_lost') throw error; }
      // Never reset a known receipt whose final file disappeared.
      try { await lstat(p.meta); return fail('upload_lost', 'This upload cannot be restarted under the same identity'); }
      catch (error) { if (!missing(error)) throw error; }
      await cleanup(p.staging);
      // Without metadata, no prefix was acknowledged. Recover a begin interrupted before its receipt.
      const handle = await open(p.part, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
      await handle.close();
      const saved: Saved = { spec, received: 0, state: 'uploading', expires: now() + maxAgeMs };
      await save(p.meta, saved);
      return view(saved);
    }),
    status: (root: string, spec: AttachmentUploadSpec) => locked(root, spec, async () => view(await load(await paths(root, spec), spec))),
    write: (root: string, chunk: AttachmentUploadChunk) => locked(root, chunk, async () => {
      const p = await paths(root, chunk), saved = await load(p, chunk);
      if (typeof chunk.data !== 'string' || chunk.data.length > Math.ceil(ATTACHMENT_UPLOAD_CHUNK_BYTES / 3) * 4) fail('invalid_payload', 'Attachment block exceeds the upload limit');
      const bytes = Buffer.from(chunk.data, 'base64');
      if (!Number.isSafeInteger(chunk.offset) || chunk.offset < 0 || !bytes.length || bytes.length > ATTACHMENT_UPLOAD_CHUNK_BYTES
        || chunk.offset + bytes.length > chunk.size || hash(bytes) !== chunk.chunkSha256) fail('invalid_payload', 'Invalid attachment block');
      if (chunk.offset > saved.received) fail('upload_offset', `The next confirmed offset is ${saved.received}`);
      const handle = await open(saved.state === 'committed' ? p.target : p.part, constants.O_RDWR | constants.O_NOFOLLOW);
      try {
        if (chunk.offset < saved.received || saved.state === 'committed') {
          if (chunk.offset + bytes.length > saved.received) fail('upload_offset', 'A block overlaps an unconfirmed offset');
          const old = Buffer.alloc(bytes.length);
          const { bytesRead } = await handle.read(old, 0, old.length, chunk.offset);
          if (bytesRead !== bytes.length || !old.equals(bytes)) fail('invalid_payload', 'Repeated block content changed');
          return view(saved);
        }
        if ((await handle.stat()).size < saved.received) fail('upload_lost', 'The retained prefix is incomplete');
        await handle.truncate(saved.received);
        let written = 0;
        while (written < bytes.length) {
          const result = await handle.write(bytes, written, bytes.length - written, chunk.offset + written);
          if (!result.bytesWritten) fail('internal_error', 'Attachment block could not be written');
          written += result.bytesWritten;
        }
        await handle.sync();
      } finally { await handle.close(); }
      saved.received += bytes.length;
      saved.expires = now() + maxAgeMs;
      await save(p.meta, saved);
      return view(saved);
    }),
    commit: (root: string, spec: AttachmentUploadSpec) => locked(root, spec, async () => {
      const p = await paths(root, spec), saved = await load(p, spec);
      if (saved.state === 'committed') return view(saved);
      if (saved.received !== spec.size || (await lstat(p.part)).size !== spec.size || await digest(p.part) !== spec.sha256) {
        fail('upload_incomplete', 'The attachment length or checksum does not match');
      }
      // Atomic publication without overwriting a concurrently created target.
      try { await link(p.part, p.target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('conflict', 'The attachment destination already exists'); throw error; }
      await unlink(p.part);
      saved.state = 'committed'; saved.expires = now() + maxAgeMs;
      await save(p.meta, saved);
      return view(saved);
    }),
    abort: (root: string, spec: AttachmentUploadSpec) => locked(root, spec, async () => {
      const p = await paths(root, spec);
      try {
        const saved = await load(p, spec);
        if (saved.state === 'committed') return;
        await rm(p.dir, { recursive: true, force: true });
      } catch (error) { if (!(error instanceof WorkspaceTransferError) || error.code !== 'upload_lost') throw error; }
    }),
  };
}
