import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { events } from '@renderer/lib/ipc';
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents';
import type { Session } from '@shared/core/sessions/sessions';
import { sessionReclaimedChannel } from '@shared/core/sessions/provisionEvents';
import { ProjectSessionsStore } from './project-sessions-store';
import { createUnprovisionedSession } from './session-store';

type MockViewModel = {
  initialize: ReturnType<typeof vi.fn>;
  suspend: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  restoreSnapshot: ReturnType<typeof vi.fn>;
  restoreTabs: ReturnType<typeof vi.fn>;
};

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  sessionAcquire: vi.fn(),
  sessionRelease: vi.fn(),
  getSessionsForProject: vi.fn(),
  getProjectManagerStore: vi.fn(),
  getPullRequestsForSession: vi.fn(),
  getSessionGitWorktreeStore: vi.fn(),
  mountProject: vi.fn(),
  provisionWorkspace: vi.fn(),
  terminalAcquire: vi.fn(),
  terminalRelease: vi.fn(),
  viewModels: [] as MockViewModel[],
  viewStateGet: vi.fn(),
  workspaceActivate: vi.fn(),
  workspaceAcquire: vi.fn(),
  workspaceRelease: vi.fn(),
  workspaceSetBootstrapState: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: {
    on: vi.fn(() => () => {}),
  },
  rpc: {
    // project-sessions-store 建任务时读这份清单拿 hooks kind(#6206 状态源判据的输入)。
    agents: {
      list: vi.fn(async () => [{ id: 'claude', capabilities: { hooks: { kind: 'config' } } }]),
    },
    sessions: {
      getSessionsForProject: mocks.getSessionsForProject,
    },
    pullRequests: {
      getPullRequestsForSession: mocks.getPullRequestsForSession,
    },
    sessionCreate: {
      createSession: mocks.createSession,
      provisionWorkspace: mocks.provisionWorkspace,
    },
  },
}));

vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectManagerStore: mocks.getProjectManagerStore,
}));

vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({
  getSessionGitWorktreeStore: mocks.getSessionGitWorktreeStore,
}));

vi.mock('@renderer/lib/stores/view-state-cache', () => ({
  viewStateCache: {
    get: mocks.viewStateGet,
    set: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}));

vi.mock('./workspace-view-model', () => ({
  WorkspaceViewModel: class {
    initialize = vi.fn();
    suspend = vi.fn();
    dispose = vi.fn();
    restoreSnapshot = vi.fn();
    restoreTabs = vi.fn();

    constructor() {
      mocks.viewModels.push(this);
    }
  },
}));

vi.mock('./workspace-registry', () => ({
  workspaceRegistry: {
    activate: mocks.workspaceActivate,
    acquire: mocks.workspaceAcquire,
    release: mocks.workspaceRelease,
    setBootstrapState: mocks.workspaceSetBootstrapState,
  },
}));

vi.mock('@renderer/features/sessions/stores/session-registry', () => ({
  sessionRegistry: {
    acquire: mocks.sessionAcquire,
    get: vi.fn(),
    release: mocks.sessionRelease,
  },
}));

vi.mock('./terminal-registry', () => ({
  terminalRegistry: {
    acquire: mocks.terminalAcquire,
    get: vi.fn(),
    release: mocks.terminalRelease,
  },
}));

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    projectId: 'project-1',
    providerId: 'claude',
    title: 'Session 1',
    lastInteractedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    isPinned: false,
    workspaceId: 'workspace-1',
    ...overrides,
  };
}

function makeSessionManager(): ProjectSessionsStore {
  return new ProjectSessionsStore(
    'project-1',
    { pullRequestRepositoryUrl: null } as never,
    { pageData: { invalidate: vi.fn() } } as never
  );
}

describe('ProjectSessionsStore session lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.viewModels.length = 0;
    mocks.getSessionsForProject.mockResolvedValue([]);
    mocks.getProjectManagerStore.mockReturnValue({ mountProject: mocks.mountProject });
    mocks.getPullRequestsForSession.mockResolvedValue({ success: true, data: { prs: [] } });
    mocks.mountProject.mockResolvedValue(undefined);
    mocks.provisionWorkspace.mockResolvedValue({
      success: true,
      data: {
        path: '/tmp/workspace-1',
        workspaceId: 'workspace-1',
      },
    });
    mocks.viewStateGet.mockResolvedValue(undefined);
  });

  // @@@5173 引擎此刻起不来 ⇒ 这一轮**什么都没落库**(闸在事务之前就返回了)。于是这条失败
  // 既没有可留的侧栏行,也不该在 composer 下面挂一条常驻红字 —— owner 定的形态是右下角一条
  // 瞬时通知(和「脚本失败」同一条 toast 通道)。这里守两件事:话说出来了,行没留下。
  // ⚠️ 断言只比骨架:文案 owner 要雕琢,钉死原文这条用例会跟着文案红;判的是它成了句人话 ——
  //    ❌ 不是 i18n 键名(缺键时 i18next 原样吐键),❌ 也不是 `harness-unavailable` 这种诊断串。
  it('speaks an engine-unavailable failure through the toast channel and leaves no session row', async () => {
    const manager = makeSessionManager();
    mocks.createSession.mockResolvedValue({
      success: false,
      error: {
        type: 'harness-unavailable',
        reason: 'updating',
        providerId: 'claude',
        harnessName: 'claude',
        detail: 'harness "claude" is being replaced',
      },
    });

    await expect(
      manager.createSession({
        projectId: 'project-1',
        sessionConfig: {
          version: '1',
          name: 'blocked',
          initialSession: { id: 'session-blocked', provider: 'claude' },
        },
        workspaceConfig: { workspace: { kind: 'worktree' } },
      } as never)
    ).rejects.toThrow(/harness-unavailable/);

    expect(toast.error).toHaveBeenCalledTimes(1);
    const said = vi.mocked(toast.error).mock.calls[0]?.[0];
    expect(typeof said).toBe('string');
    expect(said as string).not.toContain('taskError.');
    expect(said as string).not.toContain('harness-unavailable');
    // 侧栏那条乐观行必须被收回 —— 留着它就是本 issue 要消灭的「还得用户自己去删的东西」。
    expect(manager.sessions.has('session-blocked')).toBe(false);

    manager.dispose();
  });

  it('accepts a main-process session creation exactly once', () => {
    const manager = makeSessionManager();
    const session = makeSession();

    manager.acceptCreatedSession(session);
    manager.acceptCreatedSession(session);

    expect(manager.sessions.get(session.id)?.data).toEqual(session);
    expect(mocks.sessionAcquire).toHaveBeenCalledTimes(1);
    expect(mocks.sessionAcquire).toHaveBeenCalledWith(session.id, session.projectId, [session]);
    expect(mocks.terminalAcquire).toHaveBeenCalledTimes(1);

    manager.dispose();
  });

  it('keeps the composer effort on the optimistic conversation used to start ACP', async () => {
    const manager = makeSessionManager();
    mocks.createSession.mockResolvedValue({
      success: true,
      data: { session: makeSession({ id: 'conversation-effort' }) },
    });

    await manager.createSession({
      projectId: 'project-1',
      sessionConfig: {
        version: '1',
        name: 'Effort session',
        initialSession: {
          id: 'conversation-effort',
          provider: 'claude',
          type: 'acp',
          effort: 'high',
          initialQueue: [{ text: 'Keep this setting' }],
        },
      },
      workspaceConfig: { workspace: { kind: 'worktree' } },
    } as never);

    const optimistic = mocks.sessionAcquire.mock.calls[0]?.[2]?.[0];
    expect(optimistic).toEqual(expect.objectContaining({ effort: 'high' }));

    manager.dispose();
  });

  // 归档 = 这条会话离开列表:收起它在会话页的那一份,❌ 另走一条「软拆」。
  it('drops an archived session from the page when the archive arrives', () => {
    const manager = makeSessionManager();
    const session = makeSession();
    const store = createUnprovisionedSession(session);
    store.transitionToProvisioned('/tmp/workspace-1', 'workspace-1', {} as never);
    const viewModel = mocks.viewModels[0];
    manager.sessions.set(session.id, store);
    const subscriptions = vi.mocked(events.on).mock.calls as unknown as Array<
      [unknown, (payload: { sessionId: string; projectId: string; changes: { archivedAt?: string | null } }) => void]
    >;
    const onChanged = subscriptions.find(([channel]) => channel === sessionChangedChannel)?.[1];
    expect(onChanged).toBeDefined();

    // 对照:别的字段变了不算归档。
    onChanged!({ sessionId: 'session-1', projectId: 'project-1', changes: {} });
    expect(manager.sessions.has('session-1')).toBe(true);

    onChanged!({ sessionId: 'session-1', projectId: 'project-1', changes: { archivedAt: '2026-01-02 00:00:00' } });

    expect(manager.sessions.has('session-1')).toBe(false);
    expect(mocks.sessionRelease).toHaveBeenCalledWith('session-1');
    expect(mocks.terminalRelease).toHaveBeenCalledWith('session-1');
    expect(viewModel.dispose).toHaveBeenCalledOnce();

    manager.dispose();
  });

  // spec idle-reclaim:回收停的是进程 ⇒ 会话挂起成「没准备」,视图模型原样留着(#6950:从前 dispose 掉换新的,
  // 切回去贴底、多出页签);下次 provision 还是这一个视图模型。
  // ❌ 释放会话表 / 终端表:没准备的会话也靠它们给侧栏出行,表不计引用,一放就整张没了。
  it('suspends a reclaimed session, keeps its view model and registries, and provisions the same view model again', async () => {
    const manager = makeSessionManager();
    const session = makeSession();
    const store = createUnprovisionedSession(session);
    store.transitionToProvisioned('/tmp/workspace-1', 'workspace-1', {} as never);
    const viewModel = mocks.viewModels[0];
    manager.sessions.set(session.id, store);
    const subscriptions = vi.mocked(events.on).mock.calls as unknown as Array<
      [unknown, (payload: { projectId: string; sessionId: string }) => void]
    >;
    const onReclaimed = subscriptions.find(([channel]) => channel === sessionReclaimedChannel)?.[1];
    expect(onReclaimed).toBeDefined();

    // 对照:别的项目的回收不动这条会话。
    onReclaimed!({ projectId: 'project-2', sessionId: 'session-1' });
    expect(store.state).toBe('provisioned');

    onReclaimed!({ projectId: 'project-1', sessionId: 'session-1' });

    expect(viewModel.suspend).toHaveBeenCalledOnce();
    expect(viewModel.dispose).not.toHaveBeenCalled();
    expect(mocks.sessionRelease).not.toHaveBeenCalled();
    expect(mocks.terminalRelease).not.toHaveBeenCalled();
    expect(store.state).toBe('unprovisioned');
    expect(store.phase).toBe('idle');
    expect(store.workspaceId).toBeNull();
    expect(store.viewModel).toBe(viewModel);
    expect(mocks.viewModels).toHaveLength(1);

    // shown again: provisioned through the very same view model
    await manager.provisionSession(session.id);
    expect(store.state).toBe('provisioned');
    expect(store.viewModel).toBe(viewModel);
    expect(mocks.viewModels).toHaveLength(1);
    expect(viewModel.initialize).toHaveBeenCalledTimes(2);

    manager.dispose();
  });

  it('reacquires frontend managers before provisioning a restored session', async () => {
    const manager = makeSessionManager();
    const session = makeSession();
    const store = createUnprovisionedSession(session);
    manager.sessions.set(session.id, store);
    const snapshot = { sidebarTab: 'conversations' };
    mocks.viewStateGet.mockResolvedValue(snapshot);

    await manager.provisionSession(session.id);

    expect(mocks.sessionAcquire).toHaveBeenCalledWith('session-1', 'project-1');
    expect(mocks.terminalAcquire).toHaveBeenCalledWith('session-1', 'project-1');
    expect(store.state).toBe('provisioned');
    expect(store.viewModel).toBe(mocks.viewModels[0]);
    expect(mocks.viewModels[0].restoreSnapshot).toHaveBeenCalledWith(snapshot);
    expect(mocks.viewModels[0].restoreTabs).not.toHaveBeenCalled();
    expect(mocks.viewModels[0].initialize).toHaveBeenCalledOnce();

    manager.dispose();
  });

  // #6799 聚合键 session:<id> 从没写过时,页签布局(session:<id>:tabs)照样要恢复;有聚合键时只走 restoreSnapshot,
  // ❌ 两条都走(会恢复两遍)。
  it('restores the tab layout on provision even when no aggregate snapshot was ever saved', async () => {
    const manager = makeSessionManager();
    const session = makeSession();
    const store = createUnprovisionedSession(session);
    manager.sessions.set(session.id, store);
    mocks.viewStateGet.mockResolvedValue(undefined);

    await manager.provisionSession(session.id);

    expect(store.state).toBe('provisioned');
    // 页签布局的键也经主进程取:挂起时它已从渲染侧缓存清掉,hydrate 只同步读缓存。
    expect(mocks.viewStateGet).toHaveBeenCalledWith('session:session-1:tabs');
    const viewModel = mocks.viewModels[0];
    expect(viewModel.restoreTabs).toHaveBeenCalledOnce();
    expect(viewModel.restoreSnapshot).not.toHaveBeenCalled();
    expect(viewModel.restoreTabs.mock.invocationCallOrder[0]).toBeLessThan(
      viewModel.initialize.mock.invocationCallOrder[0]
    );

    manager.dispose();
  });

  // #6264 别的机器上的会话:打开时连接正好断着,准备那一问没答回来。❌ 停在「正在准备文件…」一直转
  // (会话视图的自动准备吞掉异常,没人再试)—— 落成可重试的失败态,话是连接那一层给的人话。
  it('turns an unanswered provision into a retryable failure instead of spinning forever', async () => {
    const manager = makeSessionManager();
    const session = makeSession();
    const store = createUnprovisionedSession(session);
    store.transitionToUnprovisioned();
    manager.sessions.set(session.id, store);
    mocks.provisionWorkspace.mockRejectedValueOnce(new Error('此刻连不上 Linux 2'));

    await manager.provisionSession(session.id);

    expect(store.phase).toBe('provision-error');
    expect(store.failure).toEqual({ kind: 'raw', detail: '此刻连不上 Linux 2' });

    // 「重试」= 再跑一次准备,这次答回来了。
    await manager.provisionSession(session.id);
    expect(store.state).toBe('provisioned');
    manager.dispose();
  });

  it('marks the session failed when the project cannot be mounted (the machine is unreachable)', async () => {
    const manager = makeSessionManager();
    const session = makeSession();
    const store = createUnprovisionedSession(session);
    store.transitionToUnprovisioned();
    manager.sessions.set(session.id, store);
    mocks.mountProject.mockRejectedValueOnce(new Error('此刻连不上 Linux 2'));

    await expect(manager.provisionSession(session.id)).rejects.toThrow('此刻连不上 Linux 2');
    expect(store.phase).toBe('provision-error');
    manager.dispose();
  });
});
