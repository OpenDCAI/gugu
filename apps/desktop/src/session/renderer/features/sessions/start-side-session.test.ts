import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentPayload } from '@shared/core/agents/agent-payload';

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  setActiveGroup: vi.fn(),
  setFocusedRegion: vi.fn(),
  getAgent: vi.fn(),
  /** 每次问 agent 能不能分叉时问的是哪台机器(null = 本机)。 */
  askedMachines: [] as Array<string | null>,
  toast: vi.fn(),
  logError: vi.fn(),
  source: {
    id: 'source-conversation',
    providerId: 'codex',
    runtime: 'acp' as 'acp' | 'pty',
    providerSessionId: 'source-provider-session' as string | null,
  },
  groups: [{ paneId: 'chat-pane' }] as Array<{ paneId: string }>,
}));

vi.mock('@renderer/features/sessions/stores/session-registry', () => ({
  sessionRegistry: {
    get: () => ({ sessions: new Map([['source-conversation', { data: mocks.source }]]) }),
  },
}));
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectStore: () => ({ data: { type: 'local' } }),
}));
vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({
  getSessionView: () => ({
    paneLayout: {
      activePaneId: 'chat-pane',
      groups: mocks.groups,
      open: mocks.open,
      setActiveGroup: mocks.setActiveGroup,
    },
    setFocusedRegion: mocks.setFocusedRegion,
  }),
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: mocks.toast }));
vi.mock('@renderer/lib/ipc', () => ({
  rpc: { agents: { get: mocks.getAgent } },
  // #6264 能不能分叉问来源会话所在的那台机器。
  rpcOn: (machine: string | null) => {
    mocks.askedMachines.push(machine ?? null);
    return { agents: { get: mocks.getAgent } };
  },
}));
vi.mock('@renderer/utils/logger', () => ({ log: { error: mocks.logError } }));
vi.mock('./view/session-pane-policy', () => ({
  activeChatSessionId: () => 'source-conversation',
  findChatPaneId: () => 'chat-pane',
}));

import { machineRegistry } from '@renderer/lib/machine-routing';
import { canStartSideSession, startSideSession } from './start-side-session';

/** 这个替身下一次被调用时 resolve:startSideSession 先异步问能不能分叉,之后才打开 / 报错。 */
function nextCall(mock: ReturnType<typeof vi.fn>): Promise<void> {
  const called = Promise.withResolvers<void>();
  mock.mockImplementationOnce(() => called.resolve());
  return called.promise;
}

function agent(fork: 'supported' | 'none'): AgentPayload {
  return {
    id: 'codex',
    name: 'Codex',
    capabilities: { sessions: { fork } },
  } as unknown as AgentPayload;
}

describe('runtime-only side chat entry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.source.runtime = 'acp';
    mocks.source.providerSessionId = 'source-provider-session';
    mocks.groups.splice(0, mocks.groups.length, { paneId: 'chat-pane' });
    mocks.askedMachines.length = 0;
    vi.stubGlobal('crypto', { randomUUID: () => 'view-uuid' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    machineRegistry.forgetMachine('dev-d22');
  });

  it('#6264 来源会话在别的机器上:能不能分叉问那台机器(agent 装在那台机器上),本机一路都在本机', async () => {
    mocks.getAgent.mockResolvedValue(agent('supported'));
    const openedLocally = nextCall(mocks.open);
    startSideSession('project-1', 'task-1');
    await openedLocally;
    expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(mocks.askedMachines).toEqual([null]);

    machineRegistry.register('dev-d22', ['source-conversation']);
    const openedRemotely = nextCall(mocks.open);
    startSideSession('project-1', 'task-1');
    await openedRemotely;
    expect(mocks.open).toHaveBeenCalledTimes(2);
    expect(mocks.askedMachines).toEqual([null, 'dev-d22']);
  });

  it('gates the entry on the provider sessions.fork capability', () => {
    expect(canStartSideSession('project-1', 'task-1', [agent('supported')])).toBe(true);
    expect(canStartSideSession('project-1', 'task-1', [agent('none')])).toBe(false);
  });

  it('does not treat unresolved agent metadata as unsupported', () => {
    expect(canStartSideSession('project-1', 'task-1')).toBe(true);
  });

  it('keeps the entry disabled until an ACP source has a provider session id', () => {
    mocks.source.providerSessionId = null;

    expect(canStartSideSession('project-1', 'task-1', [agent('supported')])).toBe(false);
  });

  it('uses the conversation id for a legacy PTY provider session', async () => {
    mocks.source.runtime = 'pty';
    mocks.source.providerSessionId = null;
    mocks.getAgent.mockResolvedValueOnce(agent('supported'));

    expect(canStartSideSession('project-1', 'task-1', [agent('supported')])).toBe(true);
    const opened = nextCall(mocks.open);
    startSideSession('project-1', 'task-1');
    await opened;
    expect(mocks.open).toHaveBeenCalledTimes(1);

    expect(mocks.open).toHaveBeenCalledWith(
      'side-chat',
      expect.objectContaining({
        runtimeView: expect.objectContaining({ forkFromProviderSessionId: 'source-conversation' }),
      }),
      { preview: false }
    );
  });

  it('opens a runtime-only ACP tab without invoking a conversation creation RPC', async () => {
    mocks.getAgent.mockResolvedValueOnce(agent('supported'));

    const opened = nextCall(mocks.open);
    startSideSession('project-1', 'task-1');
    await opened;
    expect(mocks.open).toHaveBeenCalledTimes(1);

    expect(mocks.open).toHaveBeenCalledWith(
      'side-chat',
      {
        sessionId: 'source-conversation',
        runtimeView: {
          id: 'side-chat:view-uuid',
          forkFromProviderSessionId: 'source-provider-session',
          forkedFromSessionId: 'source-conversation',
        },
      },
      { preview: false }
    );
    expect(mocks.setActiveGroup).toHaveBeenCalledWith('chat-pane');
    expect(mocks.setFocusedRegion).toHaveBeenCalledWith('main');
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  // #7052 侧边聊天是会话的一枚附页:开在正显示着这条会话的那一格,❌ 另一格(从前的「工作区面板」)。
  it('opens next to the conversation it forks, even when another pane exists', async () => {
    mocks.groups.push({ paneId: 'workspace-pane' });
    mocks.getAgent.mockResolvedValueOnce(agent('supported'));

    const opened = nextCall(mocks.open);
    startSideSession('project-1', 'task-1');
    await opened;
    expect(mocks.open).toHaveBeenCalledTimes(1);

    expect(mocks.open).toHaveBeenCalledWith('side-chat', expect.any(Object), { preview: false });
    expect(mocks.setActiveGroup).toHaveBeenCalledWith('chat-pane');
    expect(mocks.setActiveGroup).not.toHaveBeenCalledWith('workspace-pane');
    expect(mocks.setActiveGroup.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.open.mock.invocationCallOrder[0]!
    );
  });

  it('fails visibly when the capability changes before the action runs', async () => {
    mocks.getAgent.mockResolvedValueOnce(agent('none'));

    const toasted = nextCall(mocks.toast);
    startSideSession('project-1', 'task-1');
    await toasted;
    expect(mocks.toast).toHaveBeenCalledTimes(1);

    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      // 文案 2026-09-05 起走词表(en-US = 测试环境默认语言)。判的是「失败要响亮」,
      // 顺带钉住那句话确实进了 description —— 不然只剩一个没有原因的标题。
      expect.objectContaining({
        title: 'The side chat could not be opened',
        description: 'Codex does not support forking a task',
        variant: 'destructive',
      })
    );
  });
});
