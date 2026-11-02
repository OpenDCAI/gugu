import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createAttachmentUploads } from './attachment-uploads';
import type { AttachmentUploadSpec } from '@gugu/session-core/session-record/contract';

const roots: string[] = [];
async function root() { const dir = await mkdtemp(path.join(tmpdir(), 'attachment-resume-')); roots.push(dir); return dir; }
afterEach(async () => { await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function spec(bytes: Buffer, uploadId = 'upload-123456'): AttachmentUploadSpec {
  return { uploadId, itemId: 'item-12345678', name: 'shot.webp', size: bytes.length, sha256: sha(bytes) };
}
const block = (file: AttachmentUploadSpec, bytes: Buffer, offset = 0) => ({ ...file, offset, data: bytes.toString('base64'), chunkSha256: sha(bytes) });

describe('durable task attachment uploads', () => {
  it('resumes a confirmed prefix after a receiver restart and publishes exact bytes', async () => {
    const dir = await root(), bytes = Buffer.from('abcdef'), file = spec(bytes);
    const first = createAttachmentUploads();
    await first.begin(dir, file);
    expect((await first.write(dir, block(file, bytes.subarray(0, 3)))).received).toBe(3);
    await expect(stat(path.join(dir, '.gugu/attachments/item-12345678/shot.webp'))).rejects.toMatchObject({ code: 'ENOENT' });
    const restarted = createAttachmentUploads();
    expect((await restarted.status(dir, file)).received).toBe(3);
    await restarted.write(dir, block(file, bytes.subarray(3), 3));
    expect(await restarted.commit(dir, file)).toMatchObject({ state: 'committed', received: 6 });
    expect(await readFile(path.join(dir, '.gugu/attachments/item-12345678/shot.webp'))).toEqual(bytes);
  });
  it('accepts a repeated block after its acknowledgement is lost without counting it twice', async () => {
    const dir = await root(), bytes = Buffer.from('abcdef'), file = spec(bytes), receiver = createAttachmentUploads();
    await receiver.begin(dir, file);
    const first = block(file, bytes.subarray(0, 3));
    await receiver.write(dir, first);
    expect((await receiver.write(dir, first)).received).toBe(3);
    await expect(receiver.write(dir, block(file, Buffer.from('xyz')))).rejects.toMatchObject({ code: 'invalid_payload' });
  });
  it('returns the same committed receipt after a lost commit reply or a publication/metadata crash', async () => {
    const dir = await root(), bytes = Buffer.from('image'), file = spec(bytes), receiver = createAttachmentUploads();
    await receiver.begin(dir, file); await receiver.write(dir, block(file, bytes)); await receiver.commit(dir, file);
    const restarted = createAttachmentUploads();
    expect(await restarted.begin(dir, file)).toMatchObject({ state: 'committed', received: bytes.length });
    expect(await restarted.commit(dir, file)).toMatchObject({ state: 'committed' });
    const meta = path.join(dir, '.gugu/attachments/.incoming', file.uploadId, 'upload.json');
    const saved = JSON.parse(await readFile(meta, 'utf8')); saved.state = 'uploading'; await writeFile(meta, JSON.stringify(saved));
    expect(await createAttachmentUploads().status(dir, file)).toMatchObject({ state: 'committed' });
  });
  it('serializes two in-flight blocks and drops an unconfirmed disk tail before continuing', async () => {
    const dir = await root(), bytes = Buffer.from('abcdef'), file = spec(bytes), receiver = createAttachmentUploads();
    await receiver.begin(dir, file);
    await Promise.all([receiver.write(dir, block(file, bytes.subarray(0, 3))), receiver.write(dir, block(file, bytes.subarray(3), 3))]);
    expect((await receiver.status(dir, file)).received).toBe(6);
    const part = path.join(dir, '.gugu/attachments/.incoming', file.uploadId, 'data.part');
    await writeFile(part, Buffer.from('abcdefunconfirmed'));
    // Commit cannot certify a file with an unconfirmed tail.
    await expect(receiver.commit(dir, file)).rejects.toMatchObject({ code: 'upload_incomplete' });
  });
  it('rejects gaps, a wrong block checksum and a changed upload descriptor', async () => {
    const dir = await root(), bytes = Buffer.from('abcdef'), file = spec(bytes), receiver = createAttachmentUploads();
    await receiver.begin(dir, file);
    await expect(receiver.write(dir, block(file, bytes.subarray(3), 3))).rejects.toMatchObject({ code: 'upload_offset' });
    await expect(receiver.write(dir, { ...block(file, bytes), chunkSha256: '0'.repeat(64) })).rejects.toMatchObject({ code: 'invalid_payload' });
    await expect(receiver.begin(dir, { ...file, name: 'other.webp' })).rejects.toMatchObject({ code: 'invalid_payload' });
  });
  it('does not resume another workspace or accept path components in a filename', async () => {
    const dir = await root(), other = await root(), bytes = Buffer.from('image'), file = spec(bytes), receiver = createAttachmentUploads();
    await receiver.begin(dir, file); await receiver.write(dir, block(file, bytes));
    await expect(receiver.status(other, file)).rejects.toMatchObject({ code: 'upload_lost' });
    await expect(receiver.begin(dir, { ...file, name: '../outside' })).rejects.toMatchObject({ code: 'invalid_payload' });
  });
  it('rejects symlinked staging and never overwrites an existing different target', async () => {
    const dir = await root(), outside = await root(), file = spec(Buffer.from('image')), receiver = createAttachmentUploads();
    await mkdir(path.join(dir, '.gugu/attachments'), { recursive: true });
    await symlink(outside, path.join(dir, '.gugu/attachments/.incoming'));
    await expect(receiver.begin(dir, file)).rejects.toMatchObject({ code: 'outside_workspace' });
    await rm(path.join(dir, '.gugu/attachments/.incoming'));
    await receiver.begin(dir, file);
    const target = path.join(dir, '.gugu/attachments/item-12345678/shot.webp'); await writeFile(target, 'existing');
    await expect(receiver.write(dir, block(file, Buffer.from('image')))).rejects.toMatchObject({ code: 'conflict' });
    expect(await readFile(target, 'utf8')).toBe('existing');
  });
  it('expires retained data explicitly and cancels only the unfinished upload', async () => {
    let time = 0;
    const dir = await root(), bytes = Buffer.from('image'), file = spec(bytes), receiver = createAttachmentUploads({ now: () => time, maxAgeMs: 100 });
    await receiver.begin(dir, file); await receiver.write(dir, block(file, bytes.subarray(0, 2)));
    time = 101;
    await expect(receiver.status(dir, file)).rejects.toMatchObject({ code: 'upload_expired' });
    const next = spec(bytes, 'upload-next12'); await receiver.begin(dir, next); await receiver.abort(dir, next);
    await expect(receiver.status(dir, next)).rejects.toMatchObject({ code: 'upload_lost' });
  });
  it('commits an empty file and rejects missing or corrupt confirmed bytes', async () => {
    const dir = await root(), file = spec(Buffer.alloc(0)), receiver = createAttachmentUploads();
    await receiver.begin(dir, file); expect(await receiver.commit(dir, file)).toMatchObject({ state: 'committed', received: 0 });
    const bytes = Buffer.from('abcdef'), other = { ...spec(bytes, 'upload-corrupt1'), itemId: 'other-12345678' };
    await receiver.begin(dir, other); await receiver.write(dir, block(other, bytes));
    await writeFile(path.join(dir, '.gugu/attachments/.incoming', other.uploadId, 'data.part'), 'xxxxxx');
    await expect(receiver.commit(dir, other)).rejects.toMatchObject({ code: 'upload_incomplete' });
  });
});
