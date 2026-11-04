import { expect, it, vi } from 'vitest';
import { APP_FILE_MAX_BYTES } from '@shared/extensions/app-runtime-protocol';
import { taskPageFileRefs } from '@shared/extensions/task-page-files';
import type { BridgeCaller } from './extension-bridge';
import { readTaskFilePayloads, type TaskFileSource, type TaskFileMetadata } from './task-file-payloads';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const CHAT = '33333333-3333-4333-8333-333333333333', AGENT = '44444444-4444-4444-8444-444444444444';
function setup() {
  const controller = new AbortController(), granted = new Set([A, B]);
  let versions: readonly number[] | undefined;
  const caller = { kind: 'program', pageId: -430, extensionId: 'upload-app', callingSession: 'task-a', callingAgent: AGENT,
    signal: controller.signal, filePage: vi.fn((args: Record<string, unknown>) => {
      const id = (args.ref as { id: string }).id;
      return { pageId: -430, extensionId: 'upload-app', callId: 'host-call-a', signal: controller.signal, asAgent: AGENT,
        handed: granted.has(id) ? { id, chat: CHAT } : null, ...(versions ? { handedVersions: versions } : {}) };
    }) } as unknown as BridgeCaller;
  const metadata: TaskFileMetadata = { id: A, chat: CHAT, name: 'fixture.bin', contentType: 'application/octet-stream', version: 2, size: 3 };
  const source = { metadata: vi.fn(async (_page, ref) => ({ ...metadata, id: ref.id })),
    version: vi.fn(async (_page, _ref, n) => ({ n, bytes: new Uint8Array([1, 2, 3]).buffer, contentType: metadata.contentType })) } satisfies TaskFileSource;
  const read = (refs: unknown = [{ file: A }]) => readTaskFilePayloads(caller, refs, controller.signal, source);
  return { caller, controller, granted, metadata, source, read, versions: (value: readonly number[]) => { versions = value; } };
}

it('returns only bounded versioned content, using the host-held call actor/ref and owning the returned buffers', async () => {
  const { read, source } = setup();
  const payloads = await read([{ file: `gugu-file://${A}?v=2`, expectedVersion: 2 }]);
  expect(payloads).toEqual([{ name: 'fixture.bin', mimeType: 'application/octet-stream', bytes: new Uint8Array([1, 2, 3]).buffer, version: 2 }]);
  expect(source.version).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ asAgent: AGENT, callId: 'host-call-a' }), { id: A, chat: CHAT }, 2);
  expect(source.metadata).toHaveBeenCalledTimes(2);
  expect(Object.keys(payloads[0]!).sort()).toEqual(['bytes', 'mimeType', 'name', 'version']);
});

it.each([
  [{ file: '/etc/passwd' }], [{ file: 'C:\\Users\\fixture.txt' }], [{ file: 'file:///private/fixture.txt' }],
  [{ file: A, sessionId: 'other-task' }], [{ file: A, actor: 'other-agent' }], [{ workspace: 'session:task-a', path: 'fixture.txt' }],
  [{ file: A, expectedVersion: 0 }], [{ file: A, expectedVersion: null }], [{ file: `gugu-file://${A}?v=2`, expectedVersion: 1 }],
  [{ file: `gugu-file://${A}?v=invalid` }], [{ file: `gugu-file://${A}?v=1&v=2` }],
  [], [{ file: A }, { file: A }], Array.from({ length: 9 }, () => ({ file: A })),
].map(refs => ({ refs })))('rejects paths, forged authority, invalid versions and invalid batches before requesting metadata ($refs)', async ({ refs }) => {
  const { source, read } = setup();
  await expect(read(refs)).rejects.toMatchObject({ code: 'invalid' });
  expect(source.metadata).not.toHaveBeenCalled(); expect(source.version).not.toHaveBeenCalled();
});

it('checks every call grant before any file read; a broad file capability or another call cannot substitute', async () => {
  const { read, granted, source } = setup(); granted.delete(B);
  await expect(read([{ file: A }, { file: B }])).rejects.toMatchObject({ code: 'denied' });
  expect(source.metadata).not.toHaveBeenCalled(); expect(source.version).not.toHaveBeenCalled();
});

it('requires a current agent task call and the exact per-call file page proof', async () => {
  const { caller, source, controller } = setup();
  for (const patch of [{ kind: 'page' }, { kind: 'background' }, { callingSession: undefined }, { callingAgent: null }, { signal: undefined }]) {
    await expect(readTaskFilePayloads({ ...caller, ...patch } as BridgeCaller, [{ file: A }], controller.signal, source)).rejects.toMatchObject({ code: 'denied' });
  }
  for (const patch of [{ handed: null }, { asAgent: 'other-agent' }, { pageId: -431 }, { extensionId: 'other-app' }, { callId: undefined }, { signal: new AbortController().signal }]) {
    const real = await caller.filePage({ ref: { id: A } });
    const forged = { ...caller, filePage: () => ({ ...real, ...patch }) } as BridgeCaller;
    await expect(readTaskFilePayloads(forged, [{ file: A }], controller.signal, source)).rejects.toMatchObject({ code: 'denied' });
  }
  expect(source.metadata).not.toHaveBeenCalled();
});

it('preserves a file-card version even after F16 normalized its link to an ID', async () => {
  const { read, source, versions } = setup(); versions([1]);
  await expect(read()).rejects.toMatchObject({ code: 'content-changed' });
  await expect(read([{ file: A, expectedVersion: 2 }])).rejects.toMatchObject({ code: 'invalid' });
  expect(source.version).not.toHaveBeenCalled();
});

it('requires an explicit choice when the same call handed several file-card versions', async () => {
  const { read, versions } = setup(); versions([1, 2]);
  await expect(read()).rejects.toMatchObject({ code: 'invalid' });
  await expect(read([{ file: A, expectedVersion: 2 }])).resolves.toHaveLength(1);
});

it.each([null, -1, APP_FILE_MAX_BYTES + 1])('does not read contents with unavailable/invalid/over-limit metadata size %s', async size => {
  const { metadata, source, read } = setup(); metadata.size = size;
  await expect(read()).rejects.toHaveProperty('code'); expect(source.version).not.toHaveBeenCalled();
});

it('checks the combined size of all files before reading any content', async () => {
  const { metadata, source, read } = setup(); metadata.size = APP_FILE_MAX_BYTES;
  await expect(read([{ file: A }, { file: B }])).rejects.toMatchObject({ code: 'too-large' });
  expect(source.version).not.toHaveBeenCalled();
});

it('rejects changed scope, snapshot size or version, and loss of file access before returning the batch', async () => {
  for (const patch of [{ chat: 'other-chat' }, { id: B }]) {
    const { source, read, metadata } = setup(); source.metadata.mockResolvedValue({ ...metadata, ...patch });
    await expect(read()).rejects.toMatchObject({ code: 'denied' }); expect(source.version).not.toHaveBeenCalled();
  }
  for (const patch of [{ n: 3 }, { bytes: new Uint8Array([1]).buffer }]) {
    const { source, read } = setup(); source.version.mockResolvedValue({ n: 2, bytes: new Uint8Array([1, 2, 3]).buffer, contentType: '', ...patch });
    await expect(read()).rejects.toMatchObject({ code: 'content-changed' });
  }
  const { source, read, metadata } = setup();
  source.metadata.mockResolvedValueOnce(metadata).mockRejectedValueOnce(Object.assign(new Error('file access revoked'), { code: 'denied' }));
  await expect(read()).rejects.toMatchObject({ code: 'denied' }); expect(source.version).toHaveBeenCalledTimes(1);
});

it('cancels a pending lookup promptly and ignores its late result', async () => {
  const { source, read, controller, metadata } = setup(), pending = Promise.withResolvers<TaskFileMetadata>();
  source.metadata.mockImplementationOnce(() => pending.promise);
  const work = read(); await vi.waitFor(() => expect(source.metadata).toHaveBeenCalled());
  controller.abort(new Error('only A cancelled'));
  await expect(work).rejects.toThrow('only A cancelled');
  pending.resolve(metadata); await Promise.resolve(); expect(source.version).not.toHaveBeenCalled();
});

it('parses only a card UUID/link, with a safe explicit version', () => {
  expect(taskPageFileRefs([{ file: `gugu-file://${A}?v=2#page=3` }])).toEqual([{ itemId: A, expectedVersion: 2 }]);
});

it('encodes a document snapshot as UTF-8 and checks its byte count rather than character count', async () => {
  const { metadata, source, read } = setup(); metadata.size = 6;
  source.version.mockResolvedValue({ n: 2, text: '上传' } as never);
  expect(new TextDecoder().decode((await read())[0]!.bytes)).toBe('上传');
  metadata.size = 2; await expect(read()).rejects.toMatchObject({ code: 'content-changed' });
});

it('rejects a new version or renamed card discovered by its final metadata check', async () => {
  for (const patch of [{ version: 3 }, { name: 'changed.bin' }]) {
    const { metadata, source, read } = setup();
    source.metadata.mockResolvedValueOnce({ ...metadata }).mockResolvedValueOnce({ ...metadata, ...patch });
    await expect(read()).rejects.toMatchObject({ code: 'content-changed' });
  }
});
