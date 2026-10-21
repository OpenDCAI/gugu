import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/lib/modal/modal-store', () => ({
  modalStore: { closeModal: vi.fn() },
}));

vi.mock('./app-state', () => ({
  appState: {
    history: { push: vi.fn() },
    sidebar: { revealActiveSession: vi.fn() },
  },
}));

const { NavigationStore } = await import('./navigation-store');
const { appState } = await import('./app-state');

function buildStore() {
  const store = new NavigationStore();
  store.registerView('home');
  store.registerView('project');
  // 与 view-registry 里 libraryView 的声明同形:`agentId` 是一次性意图,`tab` 是位置。
  // ⚠️ 这里是手抄的一份,它**证明不了**真实声明没拼错 —— 那一层绑定在 library-view.tsx 的
  // `satisfies ViewDefinition<LibraryViewParams>` 上(类型级),本文件只测 store 的行为。
  store.registerView('library', { transientParams: ['agentId'] });
  return store;
}

describe('NavigationStore.restoreSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('restores a snapshot whose view is registered', () => {
    const store = buildStore();
    store.restoreSnapshot({
      currentViewId: 'project',
      viewParams: { project: { projectId: 'p1' } },
    });
    expect(store.currentViewId).toBe('project');
    expect(store.viewParamsStore.project).toEqual({ projectId: 'p1' });
    expect(store.lastNonLibraryView).toBe('project');
  });

  it('falls back to home when the persisted view is not in the registry', () => {
    const store = buildStore();
    store.restoreSnapshot({
      currentViewId: 'phantom-view-from-old-build',
      viewParams: { project: { projectId: 'p1' } },
    });
    expect(store.currentViewId).toBe('home');
  });

  it('strips viewParams entries whose key is not a registered view', () => {
    const store = buildStore();
    store.restoreSnapshot({
      currentViewId: 'home',
      viewParams: {
        project: { projectId: 'p1' },
        ghostView: { stale: true },
      },
    });
    expect(store.viewParamsStore.project).toEqual({ projectId: 'p1' });
    expect((store.viewParamsStore as Record<string, unknown>).ghostView).toBeUndefined();
  });

  // 设置从前是本页的一个视图,现在是壳的弹窗(product spec):旧快照里停在它上面的,与任何认不出来的视图一样回首页。
  it('a snapshot left on the old settings view boots into home', () => {
    const store = buildStore();
    store.restoreSnapshot({ currentViewId: 'settings', viewParams: { settings: { tab: 'storage' } } });
    expect(store.currentViewId).toBe('home');
    expect((store.viewParamsStore as Record<string, unknown>).settings).toBeUndefined();
  });

  it('honors a guard redirect after a valid view is restored', () => {
    const store = buildStore();
    store.registerGuard('project', () => ({ ok: false, redirect: 'home' }));
    store.restoreSnapshot({
      currentViewId: 'project',
      viewParams: { project: { projectId: 'gone' } },
    });
    expect(store.currentViewId).toBe('home');
  });

  it('keeps the last non-library view while the library is open', () => {
    const store = buildStore();
    store.navigate('project', { projectId: 'p1' });
    store.navigate('library');
    expect(store.currentViewId).toBe('library');
    expect(store.lastNonLibraryView).toBe('project');
    // 阴控:再走一个非资源库视图,这一格必须跟着变 —— 否则「停在 project」与
    // 「这个字段根本不更新」同形。
    store.navigate('home');
    expect(store.lastNonLibraryView).toBe('home');
  });
});

describe('NavigationStore transient view params', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('drops a transient param when the view is left, and keeps the remembered one', () => {
    const store = buildStore();
    store.navigate('library', { tab: 'agents', agentId: 'codex' });
    expect(store.viewParamsStore.library).toEqual({ tab: 'agents', agentId: 'codex' });

    store.navigate('home');
    expect(store.viewParamsStore.library).toEqual({ tab: 'agents' });
  });

  it('does not re-open the detail on the next visit — the bug, stated as a test', () => {
    const store = buildStore();
    // 聊天页的「配置 Codex」:带着意图进资源库。
    store.navigate('library', { tab: 'agents', agentId: 'codex' });
    store.navigate('home');
    // 侧栏点「资源库」:不带参数 ⇒ 继承记住的那一份。
    store.navigate('library');
    expect(store.viewParamsStore.library).toEqual({ tab: 'agents' });
    expect((store.viewParamsStore.library as { agentId?: string }).agentId).toBeUndefined();
  });

  it('never restores a transient param from a snapshot', () => {
    const store = buildStore();
    store.restoreSnapshot({
      currentViewId: 'library',
      viewParams: {
        library: { tab: 'agents', agentId: 'codex' },
        project: { projectId: 'p1' },
      },
    });
    expect(store.viewParamsStore.library).toEqual({ tab: 'agents' });
    // 阴控:没声明为转瞬的参数一个都不许被顺手丢掉。
    expect(store.viewParamsStore.project).toEqual({ projectId: 'p1' });
  });

  it('leaves views that declared no transient params untouched', () => {
    const store = buildStore();
    store.navigate('project', { projectId: 'p1' });
    store.navigate('home');
    expect(store.viewParamsStore.project).toEqual({ projectId: 'p1' });
  });
});

describe('NavigationStore transient params vs. history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('never records a transient param into the back stack', () => {
    const store = buildStore();
    store.navigate('library', { tab: 'agents', agentId: 'codex' });
    const pushed = (appState.history.push as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((call) => call[0] as { viewId: string; params: Record<string, unknown> })
      .filter((entry) => entry.viewId === 'library');
    expect(pushed).toHaveLength(1);
    // 后退回到的是位置,不是当时那次意图 —— 否则用户关掉的抽屉会被后退键请回来。
    expect(pushed[0].params).toEqual({ tab: 'agents' });
  });

  it('replaying that history entry cannot resurrect the drawer', () => {
    const store = buildStore();
    store.navigate('library', { tab: 'agents', agentId: 'codex' });
    store.navigate('home');
    const entry = (appState.history.push as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((call) => call[0] as { viewId: string; params: Record<string, unknown> })
      .find((e) => e.viewId === 'library');
    // 这就是 nav-buttons 的后退所做的事。
    store._applyNavigation('library', entry!.params as never);
    expect(store.viewParamsStore.library).toEqual({ tab: 'agents' });
  });
});

// 侧栏只在「导航到了一条会话」时展开它所在的项目:开机恢复不是导航。
describe('NavigationStore tells the sidebar about session arrivals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function storeWithSession() {
    const store = buildStore();
    store.registerView('session');
    return store;
  }

  it('reports navigating to a session, and leaving for a real view', () => {
    const store = storeWithSession();
    store.navigate('session', { projectId: 'p1', sessionId: 's1' });
    expect(appState.sidebar.revealActiveSession).toHaveBeenLastCalledWith({ projectId: 'p1', sessionId: 's1' });

    store.navigate('home');
    expect(appState.sidebar.revealActiveSession).toHaveBeenLastCalledWith(null);
  });

  it('does not report the view restored at boot', () => {
    const store = storeWithSession();
    store.restoreSnapshot({
      currentViewId: 'session',
      viewParams: { session: { projectId: 'p1', sessionId: 's1' } },
    });
    expect(appState.sidebar.revealActiveSession).not.toHaveBeenCalled();
  });
});
