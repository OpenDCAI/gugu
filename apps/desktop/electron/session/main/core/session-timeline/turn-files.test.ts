import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnFileRef } from '@gugu/session-core/session-record/contract';
import { openRuntimeFork, forkStore } from '../sessions/session-life-forks';

const mocks = vi.hoisted(() => ({
  resolveAccountFile: vi.fn(), saveFileHandle: vi.fn(), agentOf: vi.fn(), deviceId: vi.fn(), stat: vi.fn(), warn: vi.fn(),
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: mocks.warn } }));
vi.mock('node:fs/promises', () => ({ stat: mocks.stat }));
vi.mock('@main/core/extensions/account-token', () => ({ resolveAccountFile: mocks.resolveAccountFile }));
vi.mock('@gugu/core/local/files/fileSnapshots', () => ({ saveFileHandle: mocks.saveFileHandle }));
vi.mock('@main/core/sessionpage/sessionpage-session-agent', () => ({ guguAgentUserIdForSession: mocks.agentOf }));
vi.mock('@gugu/core/cloud/deviceRuntime', () => ({ readCachedDeviceId: mocks.deviceId }));

const { turnFileText, prefetchFiles } = await import('./turn-files');

const doc: TurnFileRef = { itemId: 'item-doc', version: 2, name: 'brief.txt', mimeType: 'text/plain', sizeBytes: 12, path: '/Users/me/brief.txt' };
const png: TurnFileRef = { itemId: 'item-png', version: 1, name: 'shot.png', mimeType: 'image/png', sizeBytes: 3, path: '/Users/me/shot.png' };
const heic: TurnFileRef = { itemId: 'item-heic', version: 1, name: 'shot.heic', mimeType: 'image/heic', sizeBytes: 3, path: '/Users/me/shot.heic' };
/** A resolved, authorized handle: where the resolver says the version is kept, read by the agent of `owner`. */
const resolved = (source: 'local' | 'managed-object', host_device_id = 'this-device') => ({
  status: 'ready' as const, revision: { source, host_device_id }, reader: { accountId: 'owner', actorId: 'agent-1' },
  dispose: vi.fn(async () => {}),
});

beforeEach(() => {
  mocks.stat.mockReset().mockResolvedValue({ isFile: () => true });
  mocks.resolveAccountFile.mockReset();
  mocks.saveFileHandle.mockReset().mockResolvedValue({ file_path: '/home/agent/.gugu/attachments/fetched' });
  mocks.agentOf.mockReset().mockResolvedValue('agent-1');
  mocks.deviceId.mockReset().mockResolvedValue('this-device');
});

describe('turnFileText (P3 task turn attachments)', () => {


  it('prefetches as the agent and reuses the saved path for the same session, item and version', async () => {
    mocks.resolveAccountFile.mockResolvedValue(resolved('managed-object'));
    expect(await prefetchFiles({ conversationId: 'prefetched-task', files: [doc] })).toEqual([{ itemId: doc.itemId, ok: true }]);
    mocks.resolveAccountFile.mockClear();
    mocks.saveFileHandle.mockClear();
    const turn = await turnFileText('prefetched-task', [doc], false);
    expect(turn.files?.[0]?.promptText).toBe(turn.text);
    expect(turn.text).toContain('/home/agent/.gugu/attachments/fetched');
    expect(mocks.resolveAccountFile).not.toHaveBeenCalled();
    expect(mocks.saveFileHandle).not.toHaveBeenCalled();
    await turnFileText('another-task', [doc], false);
    expect(mocks.resolveAccountFile).toHaveBeenCalledTimes(1);
  });

  it('keeps remote working copies in distinct session directories', async () => {
    mocks.resolveAccountFile.mockImplementation(async () => resolved('managed-object'));
    await turnFileText('copy-session-a', [doc], false);
    await turnFileText('copy-session-b', [doc], false);
    expect(mocks.saveFileHandle.mock.calls.map(call => call[1])).toEqual([
      expect.stringContaining(join('attachments', 'copy-session-a')), expect.stringContaining(join('attachments', 'copy-session-b')),
    ]);
  });

  it('refetches a deleted prefetched path and emits a failure line if the version is gone', async () => {
    mocks.resolveAccountFile.mockResolvedValue(resolved('managed-object'));
    await prefetchFiles({ conversationId: 'deleted-cache', files: [doc] });
    mocks.stat.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENOENT' }));
    mocks.resolveAccountFile.mockResolvedValue({ status: 'gone' });
    const turn = await turnFileText('deleted-cache', [doc], false);
    expect(mocks.warn).toHaveBeenCalledWith('Task attachment could not be saved', { sessionId: 'deleted-cache', itemId: doc.itemId, reason: 'File is no longer available' });
    expect(turn.text).toContain('[File not saved: File is no longer available]');
  });

  it('reports a disabled transfer and does not cache its failed prefetch', async () => {
    mocks.resolveAccountFile.mockRejectedValueOnce(Object.assign(new Error('Cloud transfer is disabled for this file'), { code: 'transfer_disabled' }));
    expect(await prefetchFiles({ conversationId: 'retry-prefetch', files: [doc] })).toEqual([
      { itemId: doc.itemId, ok: false, error: 'Cloud transfer is disabled for this file (transfer_disabled)', code: 'transfer_disabled' },
    ]);
    mocks.resolveAccountFile.mockResolvedValue(resolved('managed-object'));
    expect((await turnFileText('retry-prefetch', [doc], false)).text).not.toContain('not saved');
  });

  it("reads as the session's agent; kept on this device: the placed file itself, in the inbox line format", async () => {
    const here = resolved('local');
    mocks.resolveAccountFile.mockResolvedValue(here);
    const { text, images } = await turnFileText('task-1', [doc], true);
    expect(mocks.agentOf).toHaveBeenCalledWith('task-1', expect.anything());
    expect(mocks.resolveAccountFile).toHaveBeenCalledWith({ id: 'item-doc' }, 'agent-1', { version: 2 });
    expect(mocks.deviceId).toHaveBeenCalledWith(expect.anything(), 'owner');
    expect(here.dispose).toHaveBeenCalled();
    expect(mocks.saveFileHandle).not.toHaveBeenCalled();
    expect(text.split('\n')[0]).toContain('brief.txt');
    expect(text).toContain('gugu-file://item-doc?v=2');
    expect(text).toContain('[File saved at local path: /Users/me/brief.txt]');
    expect(images).toEqual([]);
  });

  it.each([
    ['another device of the account', resolved('local', 'other-device')],
    ['a cloud object', resolved('managed-object')],
  ])('kept on %s: fetched once into the downloads directory, the placed path is not handed over', async (_label, elsewhere) => {
    mocks.resolveAccountFile.mockResolvedValue(elsewhere);
    const session = `kept-${_label}`;
    const { text } = await turnFileText(session, [doc], false);
    expect(mocks.saveFileHandle).toHaveBeenCalledWith(elsewhere, expect.stringContaining(session), 'brief.txt');
    expect(text).toContain('[File saved at local path: /home/agent/.gugu/attachments/fetched]');
    expect(text).not.toContain('/Users/me/brief.txt');
  });

  it('a ref without a path (placed from the phone) is fetched even when this device keeps it', async () => {
    mocks.resolveAccountFile.mockResolvedValue(resolved('local'));
    const { text } = await turnFileText('phone-file-task', [{ ...doc, path: undefined }], false);
    expect(mocks.saveFileHandle).toHaveBeenCalledTimes(1);
    expect(text).toContain('/home/agent/.gugu/attachments/fetched');
  });

  it('not readable by the agent: a failure line, still with the folder file to open', async () => {
    mocks.resolveAccountFile.mockResolvedValue({ status: 'gone', sha256: null });
    const { text, images } = await turnFileText('task-1', [png], true);
    expect(text.split('\n')[0]).toBe('[Image attached: shot.png]');
    expect(text).toContain('gugu-file://item-png?v=1');
    expect(text).toContain('[Image not saved: File is no longer available]');
    expect(images).toEqual([]);
  });

  it('a task with no agent identity: every file gets a failure line, nothing is resolved', async () => {
    mocks.agentOf.mockResolvedValue(null);
    const { text } = await turnFileText('task-1', [doc], true);
    expect(mocks.resolveAccountFile).not.toHaveBeenCalled();
    expect(text).toContain('[File not saved: This task has no agent identity to read its attachments as]');
  });

  it('inlines an image only for an ACP turn and only a supported image type', async () => {
    mocks.resolveAccountFile.mockImplementation(async () => resolved('local'));
    const acp = await turnFileText('task-1', [png, heic, doc], true);
    expect(acp.images).toEqual([{ type: 'local-file', originalPath: '/Users/me/shot.png', mimeType: 'image/png', name: 'shot.png' }]);
    expect(acp.text.split('\n\n')).toHaveLength(3);
    expect(acp.text).toContain('[Image attached at local path: /Users/me/shot.heic]');
    const pty = await turnFileText('task-1', [png], false);
    expect(pty.images).toEqual([]);
    expect(pty.text).toContain('[Image attached at local path: /Users/me/shot.png]');
  });
});

it('replays an existing runtime image once while retaining its file context', async () => {
  mocks.resolveAccountFile.mockResolvedValue(resolved('local'));
  const turn = await turnFileText('image-replay', [png], true, [{ type: 'attachment', id: 'runtime-image', name: png.name, mimeType: 'image/png' }]);
  expect(turn.images).toEqual([]);
  expect(turn.files?.[0]).toMatchObject({ itemId: png.itemId, promptText: expect.stringContaining('shot.png') });
});

it('a side chat reads as its parent agent while keeping its own download directory', async () => {
  openRuntimeFork({ forkId: 'file-fork', parentId: 'parent-task', forkFromProviderSessionId: 'provider-parent' });
  mocks.resolveAccountFile.mockResolvedValue(resolved('managed-object'));
  try {
    await turnFileText('file-fork', [doc], false);
    expect(mocks.agentOf).toHaveBeenLastCalledWith('parent-task', expect.anything());
    expect(mocks.saveFileHandle).toHaveBeenLastCalledWith(expect.anything(), expect.stringContaining(join('attachments', 'file-fork')), doc.name);
  } finally { forkStore.remove('file-fork'); }
});
