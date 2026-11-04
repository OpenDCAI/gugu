import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAttachmentUploads } from '@main/core/files/attachment-uploads';
import { resumeTaskAttachment, type AttachmentUploadContext, type AttachmentUploadTransport } from '@/lib/taskAttachmentUpload';
import { ATTACHMENT_UPLOAD_CHUNK_BYTES } from '@gugu/session-core/session-record/contract';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'attachment-sender-')); roots.push(root);
  let receiver = createAttachmentUploads();
  const offsets: number[] = [];
  const transport: AttachmentUploadTransport = {
    begin: spec => receiver.begin(root, spec), status: spec => receiver.status(root, spec),
    write: chunk => { offsets.push(chunk.offset); return receiver.write(root, chunk); },
    commit: spec => receiver.commit(root, spec), abort: spec => receiver.abort(root, spec),
  };
  const source = new Blob([new Uint8Array(ATTACHMENT_UPLOAD_CHUNK_BYTES * 3 + 10).fill(31)], { type: 'image/webp' });
  const input = { source, itemId: 'picture-12345', name: 'shot.webp', scope: 'device/project/workspace', context: {} as AttachmentUploadContext, transport };
  return { root, input, offsets, restart: () => { receiver = createAttachmentUploads(); } };
}
describe('task attachment sender with the real durable receiver', () => {
  it('resumes only after the confirmed prefix when a block reply is lost and the receiver restarts', async () => {
    const { input, offsets, restart, root } = await setup();
    const original = input.transport.write; let lose = true;
    input.transport.write = async chunk => { const reply = await original(chunk); if (lose && chunk.offset === 0) { lose = false; throw new Error('lost reply'); } return reply; };
    await expect(resumeTaskAttachment(input)).rejects.toThrow('lost reply');
    const firstId = input.context.spec!.uploadId;
    expect(offsets).toEqual([0, ATTACHMENT_UPLOAD_CHUNK_BYTES]);
    restart(); offsets.length = 0;
    const progress: number[] = [];
    const target = await resumeTaskAttachment({ ...input, onProgress: received => progress.push(received) });
    expect(input.context.spec!.uploadId).toBe(firstId);
    expect(offsets).toEqual([ATTACHMENT_UPLOAD_CHUNK_BYTES * 2, ATTACHMENT_UPLOAD_CHUNK_BYTES * 3]);
    expect(progress[0]).toBe(ATTACHMENT_UPLOAD_CHUNK_BYTES * 2);
    expect(await readFile(path.join(root, target))).toEqual(Buffer.from(await input.source.arrayBuffer()));
  });
  it('recovers a lost commit reply without writing any byte again', async () => {
    const { input, offsets, restart } = await setup();
    const commit = input.transport.commit; let lose = true;
    input.transport.commit = async spec => { const reply = await commit(spec); if (lose) { lose = false; throw new Error('commit reply lost'); } return reply; };
    await expect(resumeTaskAttachment(input)).rejects.toThrow('commit reply lost');
    offsets.length = 0; restart();
    await resumeTaskAttachment(input);
    expect(offsets).toEqual([]);
  });
  it('cancels an upload while waiting for its block and rejects a changed workspace', async () => {
    const { input } = await setup();
    const controller = new AbortController();
    await expect(resumeTaskAttachment({ ...input, signal: controller.signal, onProgress: value => { if (value > 0) controller.abort(); } })).rejects.toThrow();
    await expect(input.transport.status(input.context.spec!)).rejects.toMatchObject({ code: 'upload_lost' });
    await expect(resumeTaskAttachment({ ...input, scope: 'other/workspace' })).rejects.toThrow('different task workspace');
  });
});
