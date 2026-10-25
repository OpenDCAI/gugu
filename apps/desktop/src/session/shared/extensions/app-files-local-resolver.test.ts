import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createFileResolver, type FileBytes, type FileRevision } from '@gugu/core/shared/fileResolver';
import { createAppFiles, type FilesPlatform } from './app-files-core';

const bytes = new Uint8Array([0, 255, 2, 3]);
const owner = '11111111-1111-4111-8111-111111111111';
const revision: FileRevision = { source: 'local', item_id: '44444444-4444-4444-8444-444444444444', version: 1, chat_id: 'group', file_name: 'original.bin', content_type: 'application/octet-stream', size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), host_account_id: owner, host_device_id: 'device', host_project_id: 'project', relative_path: 'original.bin', workspace: { path: 'files/original.bin', parent_id: 'folder', created_at: null, updated_at: null, created_by: owner, source_message_ids: [] } };
function fixture() {
  const never = vi.fn(async () => { throw Error('A local open must not consult the cloud'); });
  const dispose = vi.fn(async () => {}), snapshot: FileBytes = { size: bytes.length, read: async (offset, length) => bytes.slice(offset, offset + length), dispose };
  const open = vi.fn(async () => snapshot);
  const resolve = createFileResolver({ local: async context => context.actor.actorId === owner && ('item_id' in context.ref && context.ref.item_id === revision.item_id) ? { revision, open } : null, metadata: never, managed: never, ssh: never, temporary: never });
  const platform: FilesPlatform = { account: never, identities: never, faces: never, hasCapability: () => true, sync: {} as never, filesUrl: () => { throw Error('No file service for a local read'); }, warn: never,
    resolveFile: async (ref, actor, options) => resolve({ item_id: 'id' in ref ? ref.id : revision.item_id!, version: options.version }, { accountId: owner, actorId: actor ?? owner }, { localOnly: true }),
  };
  return { files: createAppFiles(platform), never, open, dispose, platform };
}
const surface = { pageId: 1, extensionId: 'reader', itemId: null };
describe('App stored files enter the canonical local resolver before all cloud metadata', () => {
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
    expect(new Uint8Array(opened.bytes!)).toEqual(bytes);
    expect(opened).toMatchObject({ access: 'ro', docName: '', entry: { id: revision.item_id, chat: 'group', path: 'files/original.bin', parentId: 'folder', version: 1, createdAt: null, canDelete: false } });
    expect(opened.self.userId).toBe(`user:${owner}`);
    expect(f.never).not.toHaveBeenCalled(); expect(f.open).toHaveBeenCalledTimes(1); expect(f.dispose).toHaveBeenCalledTimes(1);
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
    expect(opened.access).toBe('ro'); expect(new Uint8Array(opened.bytes!)).toEqual(bytes); expect(f.never).not.toHaveBeenCalled();
  });
});
