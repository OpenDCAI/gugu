import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createFileResolver, type FileBytes, type FileRevision } from '@gugu/core/shared/fileResolver';
import { createAppFiles, type FilesPlatform } from './app-files-core';

const bytes = new Uint8Array([0, 255, 2, 3]);
const owner = '11111111-1111-4111-8111-111111111111';
const revision: FileRevision = { source: 'local', item_id: '44444444-4444-4444-8444-444444444444', version: 1, chat_id: 'group', file_name: 'original.bin', content_type: 'application/octet-stream', size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), host_account_id: owner, host_device_id: 'device', host_project_id: 'project', relative_path: 'original.bin', workspace: { path: 'files/original.bin', parent_id: 'folder', created_at: null, updated_at: null, created_by: owner, source_message_ids: [] } };
function fixture(overrides: Partial<FileRevision> = {}) {
  const localRevision = { ...revision, ...overrides };
  const never = vi.fn(async () => { throw Error('A local open must not consult the cloud'); });
  const dispose = vi.fn(async () => {}), snapshot: FileBytes = { size: bytes.length, read: async (offset, length) => bytes.slice(offset, offset + length), dispose };
  const open = vi.fn(async () => snapshot);
  const resolve = createFileResolver({ local: async context => context.actor.actorId === owner && ('item_id' in context.ref && context.ref.item_id === localRevision.item_id) ? { revision: localRevision, open } : null, metadata: never, managed: never, ssh: never, temporary: never });
  const platform: FilesPlatform = { account: never, identities: never, faces: never, hasCapability: () => true, sync: { ensureFor: () => undefined, pageFor: () => ({}) } as never, filesUrl: () => { throw Error('No file service for a local read'); }, warn: never,
    resolveFile: async (ref, actor, options) => resolve({ item_id: 'id' in ref ? ref.id : revision.item_id!, version: options.version }, { accountId: owner, actorId: actor ?? owner }, { localOnly: true, ...(options.signal ? { signal: options.signal } : {}) }),
  };
  return { files: createAppFiles(platform), never, open, dispose, platform };
}
const surface = { pageId: 1, extensionId: 'reader', itemId: null };
describe('App stored files enter the canonical local resolver before all cloud metadata', () => {
  it('uses the same saved name for local bytes and App entry metadata without opening the file', async () => {
    const f = fixture({ file_name: '报告', content_type: 'application/pdf' });
    const source = await f.files.downloadSource(surface, { ref: { id: revision.item_id! } });
    expect(source).toMatchObject({ name: '报告.pdf', kind: 'file' });
    expect(f.never).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
    if (source.kind === 'file') await source.file.dispose();
    const opened = await f.files.open(surface, { ref: { id: revision.item_id! } });
    expect(opened.entry).toMatchObject({ name: '报告', savedName: '报告.pdf', suffix: '' });
  });

  it('locates the App shell group without refreshing an account, querying the workspace or reading bytes', async () => {
    const f = fixture(), resolve = f.platform.resolveFile!, closed = vi.fn();
    f.platform.resolveFile = async (...args) => {
      const file = await resolve(...args);
      if (file?.status === 'ready') { const dispose = file.dispose; file.dispose = async () => { closed(); await dispose(); }; }
      return file;
    };
    await expect(f.files.chatOf(revision.item_id!)).resolves.toBe('group');
    await expect(f.files.groupFile('group', revision.item_id!)).resolves.toMatchObject({ chatId: 'group', itemId: revision.item_id, file: { document: false, version: 1, size: bytes.length } });
    await expect(f.files.groupFile('another-group', revision.item_id!)).rejects.toMatchObject({ code: 'not-found' });
    expect(f.never).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled(); expect(f.dispose).not.toHaveBeenCalled(); expect(closed).toHaveBeenCalledTimes(3);
  });
  it('opens the actual cached publication read-only without account refresh, workspace lookup or identities', async () => {
    const f = fixture(), opened = await f.files.open(surface, { ref: { id: revision.item_id! } });
    expect(opened).toMatchObject({ chunked: true });
    expect(f.open).not.toHaveBeenCalled();
    expect(opened).toMatchObject({ access: 'ro', docName: '', entry: { id: revision.item_id, chat: 'group', path: 'files/original.bin', parentId: 'folder', version: 1, createdAt: null } });
    expect(opened.self.userId).toBe(`user:${owner}`);
    expect(f.never).not.toHaveBeenCalled();
    f.platform.account = async () => ({ token: "synthetic", userId: owner });
    const ref = { id: revision.item_id!, version: 1 };
    const range = await f.files.read(surface, { ref, offset: 0, length: bytes.length });
    expect(range.data).toEqual(bytes);
    expect(f.open).toHaveBeenCalledTimes(1);
    await f.files.close(surface, { ref });
    expect(f.dispose).toHaveBeenCalledTimes(1);
  });
  it('a download returns only the lazy original handle; a kept version uses the same local entry', async () => {
    const f = fixture(), source = await f.files.downloadSource(surface, { ref: { chat: 'group', name: 'files/original.bin' } });
    expect(source).toMatchObject({ kind: 'file', name: 'original.bin', file: { purpose: 'file' } });
    expect(source).not.toHaveProperty('url'); expect(f.open).not.toHaveBeenCalled();
    if (source.kind === 'file') await source.file.dispose();
    const version = await f.files.readVersion(surface, { ref: { id: revision.item_id! }, n: 1 });
    expect(version).toMatchObject({ n: 1, contentType: revision.content_type }); expect(new Uint8Array(('bytes' in version ? version.bytes : undefined)!)).toEqual(bytes);
    expect(f.never).not.toHaveBeenCalled();
  });
  it('a reference naming the wrong chat cannot borrow an indexed local file', async () => {
    const f = fixture();
    await expect(f.files.open(surface, { ref: { chat: 'another', id: revision.item_id! } })).rejects.toMatchObject({ code: 'invalid' });
    expect(f.open).not.toHaveBeenCalled(); expect(f.never).not.toHaveBeenCalled();
  });
  it('denied App capabilities cannot open a local byte snapshot, and a handed file remains read-only', async () => {
    const f = fixture(); f.platform.hasCapability = () => false;
    await expect(f.files.open(surface, { ref: { id: revision.item_id! } })).rejects.toMatchObject({ code: 'denied' });
    expect(f.open).not.toHaveBeenCalled();
    const opened = await f.files.open({ ...surface, itemId: revision.item_id! }, { ref: { id: revision.item_id! } });
    expect(opened.access).toBe('ro'); expect(opened).toMatchObject({ chunked: true });
    expect(f.open).not.toHaveBeenCalled(); expect(f.never).not.toHaveBeenCalled();
  });
});

describe('R3 App file read cancellation', () => {
  it('k2 forwards the exact surface signal to the file resolver', async () => {
    const f = fixture(), controller = new AbortController();
    const resolve = vi.fn(f.platform.resolveFile!);
    f.platform.resolveFile = resolve;
    await f.files.open({ ...surface, signal: controller.signal }, { ref: { id: revision.item_id! } });
    expect(resolve).toHaveBeenCalledExactlyOnceWith({ id: revision.item_id! }, null, {
      version: undefined, localOnly: true, signal: controller.signal,
    });
  });
});

// A program can run two calls of the same actor against the same version.
describe('program-call stored read ownership', () => {
  it('does not publish a snapshot when cancellation wins the metadata lookup', async () => {
    const f = fixture(), controller = new AbortController(), resolve = f.platform.resolveFile!;
    f.platform.resolveFile = async (...args) => { const file = await resolve(...args); controller.abort(); return file; };
    await expect(f.files.open({ ...surface, callId: 'metadata', signal: controller.signal }, { ref: { id: revision.item_id! } })).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.files.readHandleCount()).toBe(0);
    expect(f.open).not.toHaveBeenCalled();
  });

  it('ending a call releases its own idle snapshot while another call keeps reading', async () => {
    const f = fixture(), first = new AbortController(), second = new AbortController();
    f.platform.account = async () => ({ token: 'synthetic', userId: owner });
    const a = { ...surface, callId: 'idle-a', signal: first.signal };
    const b = { ...surface, callId: 'live-b', signal: second.signal };
    const ref = { id: revision.item_id!, version: 1 };
    await f.files.open(a, { ref });
    await f.files.open(b, { ref });
    try {
      expect(f.files.readHandleCount()).toBe(2);
      first.abort();
      expect(f.files.readHandleCount()).toBe(1);
      await expect(f.files.read(b, { ref, offset: 0, length: bytes.length })).resolves.toMatchObject({ data: bytes });
    } finally { first.abort(); second.abort(); await f.files.close(a, { ref }); await f.files.close(b, { ref }); }
    expect(f.files.readHandleCount()).toBe(0);
  });

  it('closing and cancelling A preserves B on the same actor, file and version', async () => {
    const f = fixture(), first = new AbortController(), second = new AbortController();
    const finish = Promise.withResolvers<Uint8Array>(), started = Promise.withResolvers<void>();
    let reads = 0;
    f.open.mockImplementation(async () => ({ size: bytes.length, dispose: f.dispose, read: async () => {
      if (++reads === 2) started.resolve();
      return finish.promise;
    } }));
    f.platform.account = async () => ({ token: 'synthetic', userId: owner });
    const a = { ...surface, callId: 'call-a', signal: first.signal };
    const b = { ...surface, callId: 'call-b', signal: second.signal };
    const ref = { id: revision.item_id!, version: 1 };
    await f.files.open(a, { ref });
    await f.files.open(b, { ref });
    const outcomeA = f.files.read(a, { ref, offset: 0, length: bytes.length }).then(value => ({ value }), error => ({ error }));
    const outcomeB = f.files.read(b, { ref, offset: 0, length: bytes.length }).then(value => ({ value }), error => ({ error }));
    await started.promise;
    await f.files.close(a, { ref });
    first.abort();
    finish.resolve(bytes);
    try {
      expect(await outcomeA).toHaveProperty('error');
      expect(await outcomeB).toMatchObject({ value: { data: bytes } });
      expect(second.signal.aborted).toBe(false);
    } finally { await f.files.close(b, { ref }); }
  });
});
