import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnFileRef } from '@gugu/session-core/session-record/contract';

const mocks = vi.hoisted(() => ({
  resolveAccountFile: vi.fn(), saveFileHandle: vi.fn(), agentOf: vi.fn(), deviceId: vi.fn(),
}));
vi.mock('@main/core/extensions/account-token', () => ({ resolveAccountFile: mocks.resolveAccountFile }));
vi.mock('@gugu/core/local/files/fileSnapshots', () => ({ saveFileHandle: mocks.saveFileHandle }));
vi.mock('@main/core/sessionpage/sessionpage-session-agent', () => ({ guguAgentUserIdForSession: mocks.agentOf }));
vi.mock('@gugu/core/cloud/deviceRuntime', () => ({ readCachedDeviceId: mocks.deviceId }));

const { turnFileText } = await import('./turn-files');

const doc: TurnFileRef = { itemId: 'item-doc', version: 2, name: 'brief.txt', mimeType: 'text/plain', sizeBytes: 12, path: '/Users/me/brief.txt' };
const png: TurnFileRef = { itemId: 'item-png', version: 1, name: 'shot.png', mimeType: 'image/png', sizeBytes: 3, path: '/Users/me/shot.png' };
const heic: TurnFileRef = { itemId: 'item-heic', version: 1, name: 'shot.heic', mimeType: 'image/heic', sizeBytes: 3, path: '/Users/me/shot.heic' };
/** A resolved, authorized handle: where the resolver says the version is kept, read by the agent of `owner`. */
const resolved = (source: 'local' | 'managed-object', host_device_id = 'this-device') => ({
  status: 'ready' as const, revision: { source, host_device_id }, reader: { accountId: 'owner', actorId: 'agent-1' },
  dispose: vi.fn(async () => {}),
});

describe('turnFileText (P3 task turn attachments)', () => {
  beforeEach(() => {
    mocks.resolveAccountFile.mockReset();
    mocks.saveFileHandle.mockReset().mockResolvedValue({ file_path: '/home/agent/.gugu/attachments/fetched' });
    mocks.agentOf.mockReset().mockResolvedValue('agent-1');
    mocks.deviceId.mockReset().mockResolvedValue('this-device');
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
    const { text } = await turnFileText('task-1', [doc], false);
    expect(mocks.saveFileHandle).toHaveBeenCalledWith(elsewhere, expect.stringMatching(/attachments$/), 'brief.txt');
    expect(text).toContain('[File saved at local path: /home/agent/.gugu/attachments/fetched]');
    expect(text).not.toContain('/Users/me/brief.txt');
  });

  it('a ref without a path (placed from the phone) is fetched even when this device keeps it', async () => {
    mocks.resolveAccountFile.mockResolvedValue(resolved('local'));
    const { text } = await turnFileText('task-1', [{ ...doc, path: undefined }], false);
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
