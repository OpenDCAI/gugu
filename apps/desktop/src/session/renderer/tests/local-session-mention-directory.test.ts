// @vitest-environment jsdom
/**
 * #7016 @ 弹层:本机的名册问本机宿主,别的机器上的从会话目录读(❌ 逐台去问 —— 掉线又回来的那台客户端停在 open,
 * 问它要等到 frame 超时,弹层一直空着)。在线却还没读到会话列表的机器,弹层为它说一行「没读到」:
 * 点不了、不插进消息,❌ 拿空列表冒充「那台机器上没有」。把远端会话拖进输入框走的是同一份候选。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionShellPort } from '@shared/lib/ipc/shell-port';

const LOCAL = { sessionId: 'local-1', identity: { users: { id: 'agent-local', display_name: 'Claude 3', gugu_number: 103 } }, engine: 'claude' };
const REMOTE = { sessionId: 'remote-1', identity: { users: { id: 'agent-remote', display_name: 'Codex 8', gugu_number: null } }, engine: 'codex' };
const directory = vi.fn(() => ({ peers: [REMOTE], notRead: [{ id: 'dev-c', label: 'ThinkPad' }] }));
const sessionPeers = vi.fn(async (_sessionId?: string) => [LOCAL]);

vi.mock('@renderer/features/projects/stores/project-selectors', () => ({ getProjectManagerStore: () => ({ projects: new Map() }) }));
vi.mock('@renderer/features/sessions/stores/session-registry', () => ({ sessionRegistry: { get: () => undefined } }));
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({
  remoteHostsStore: { directoryPeers: () => directory(), findListedSession: () => null },
}));
vi.mock('@renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: () => null } }));
vi.mock('@renderer/lib/electron-api', () => ({ electronApi: vi.fn(), findSessionHostBridge: vi.fn() }));
vi.mock('@renderer/lib/ipc', () => ({ invokeOnMachine: vi.fn(), onMachineEvent: vi.fn() }));
vi.mock('@renderer/lib/machine-clients', () => ({ onEachMachine: vi.fn() }));
vi.mock('@renderer/lib/shell-port', async (importOriginal) => {
  const { machineAwareShellPort } = await importOriginal<typeof import('@renderer/lib/shell-port')>();
  return { shellPort: () => machineAwareShellPort(createSessionShellPort((_channel, ...args) =>
    sessionPeers(typeof args[0] === 'string' ? args[0] : undefined))) };
});
vi.mock('@renderer/localization/locale-store', async () => {
  const { enUSMessages } = await import('@renderer/localization/messages');
  return {
    translateSessionMessage: (key: string, values: { device?: string } = {}) =>
      key === 'chat.mentionDropPrivateAgent' ? enUSMessages[key] : `${key}:${values.device}`,
  };
});

const { createLocalSessionMentionProvider } = await import('@renderer/lib/chat/local-session-mention-provider');

beforeEach(() => {
  // 渲染层日志经桥的 eventSend 写出(没有图标的引擎会记一条 warn)。
  (window as unknown as { electronAPI: unknown }).electronAPI = { eventSend: () => undefined };
});
afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('@ 弹层读会话目录', () => {
  it('本机 + 别的机器上的会话都在;没读到的那台说一行「没读到」,点不了', async () => {
    const items = await createLocalSessionMentionProvider().search('');
    expect(items.filter((item) => !item.disabled).map((item) => item.id)).toEqual(['aid:agent-local', 'aid:agent-remote']);
    expect(items.filter((item) => item.disabled)).toEqual([
      { id: 'not-read:dev-c', label: '', name: 'remoteHost.mention.notRead:ThinkPad', kind: 'custom', disabled: true },
    ]);
    expect(sessionPeers).toHaveBeenCalledTimes(1);
  });

  it('按名字或咕咕号筛:「没读到」那一行照样在(那台机器上可能就有要找的)', async () => {
    const items = await createLocalSessionMentionProvider().search('103');
    expect(items.map((item) => item.id)).toEqual(['aid:agent-local', 'not-read:dev-c']);
  });

  it('全都读到了:只有会话,没有说明行', async () => {
    directory.mockReturnValueOnce({ peers: [REMOTE], notRead: [] });
    const items = await createLocalSessionMentionProvider().search('');
    expect(items.some((item) => item.disabled)).toBe(false);
  });

  it('把别的机器上的会话拖进输入框:从目录那一行解析,与 @ 里同一枚', async () => {
    const pill = await createLocalSessionMentionProvider().resolveSession('remote-1');
    expect(pill).toMatchObject({ id: 'aid:agent-remote', label: 'aid:agent-remote', name: 'Codex 8', role: 'agent' });
  });

  it('uses the shared host bridge for a web or phone task drop too', async () => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    const pill = await createLocalSessionMentionProvider().resolveSession('remote-1');
    expect(pill).toMatchObject({ label: 'aid:agent-remote', name: 'Codex 8' });
    expect(sessionPeers).toHaveBeenCalled();
  });

  it('explains a private external Agent refusal without treating an uncreated identity as private', async () => {
    sessionPeers.mockImplementationOnce(async (sessionId?: string) => {
      if (sessionId === 'private-task') throw new Error('Error invoking remote method: SESSION_PRIVATE_EXTERNAL_AGENT');
      return [];
    });
    const provider = createLocalSessionMentionProvider();
    expect(await provider.resolveSession('private-task')).toMatchObject({
      label: '', disabled: true,
      description: 'This Agent is private to another user and cannot be added.',
    });
    expect(sessionPeers).toHaveBeenLastCalledWith('private-task');
    sessionPeers.mockResolvedValueOnce([]);
    expect(await provider.resolveSession('unstarted-task')).toBeNull();
  });

});
