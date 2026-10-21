import { makeObservable, observable, runInAction } from 'mobx';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserControlsRegistry } from '@renderer/features/browser/browser-controls-registry';
import { SessionStore } from '@renderer/features/sessions/page-sessions-store';
import { sessionRegistry } from '@renderer/features/sessions/stores/session-registry';
import { releaseSessionPtyManager } from '@renderer/features/sessions/stores/session-pty-manager';
import { events } from '@renderer/lib/ipc';
import { appState } from '@renderer/lib/stores/app-state';
import { viewStateCache } from '@renderer/lib/stores/view-state-cache';
import type { Session } from '@shared/core/sessions/sessions';
import {
  sessionChangedChannel,
  sessionDeletedChannel,
} from '@shared/core/sessions/sessionEvents';
import type { Terminal } from '@shared/core/terminals/terminals';
import type { SessionViewSnapshot } from '@shared/view-state';
import type { TerminalManagerStore, TerminalStore } from '../terminals/terminal-manager';
import type { SessionPageStore } from './session-store';
import { terminalRegistry } from './terminal-registry';
import { workspaceRegistry } from './workspace-registry';
import { WorkspaceViewModel } from './workspace-view-model';

vi.mock('@renderer/features/browser/browser-tab-item', () => ({
  BrowserTabBarItem: () => null,
  BrowserTabBarItemDragPreview: () => null,
}));
vi.mock('@renderer/features/sessions/editor/file-tab-item', () => ({
  FileTabBarItem: () => null,
  FileTabBarItemDragPreview: () => null,
}));
vi.mock('@renderer/features/sessions/session-tab-item', () => ({
  SessionTabBarItem: () => null,
  SessionTabBarItemDragPreview: () => null,
}));
vi.mock('@renderer/features/sessions/diff-view/diff-tab-item', () => ({
  DiffTabBarItem: () => null,
  DiffTabBarItemDragPreview: () => null,
  diffGroupSuffix: (group: string) => `(${group})`,
}));
vi.mock('@renderer/features/sessions/session-title-utils', () => ({
  formatSessionTitleForDisplay: (_providerId: unknown, title: unknown) =>
    (title as string) ?? 'Conversation',
}));

// ACP imports chat-ui which calls document.createElement at module load time.
// Stub out the entire chat-store chain to avoid the DOM dependency in node tests.
vi.mock('@renderer/features/sessions/acp/acp-chat-store', () => ({
  AcpChatStore: class {
    sessionId = '';
    dispose() {}
    bootstrap() {}
  },
}));
vi.mock('@renderer/features/sessions/acp/acp-chat-panel', () => ({
  AcpChatPanel: () => null,
}));

// Logger uses window.electronAPI which doesn't exist in the node test environment.
vi.mock('@renderer/utils/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: vi.fn(() => () => {}) },
  rpc: {
    ssh: {
      getConnections: async () => [],
      getConnectionState: async () => ({}),
      getHealthStates: async () => ({}),
    },
    viewState: {
      save: vi.fn(),
    },
    sessions: {
      markSessionSeen: vi.fn().mockResolvedValue(undefined),
    },
    gitRepository: {
      getDefaultBranch: vi
        .fn()
        .mockResolvedValue({ success: true, data: { defaultBranch: 'main' } }),
      resolveProviderRepository: vi.fn().mockResolvedValue({ success: false }),
    },
    workspace: {
      gitWorktree: {},
      fileTree: {
        openProjection: vi.fn().mockResolvedValue({
          success: true,
          data: { subscriptionId: 'sub-1', version: 1, scopes: [{ scopeId: null, entries: [] }] },
        }),
        registerDir: vi.fn().mockResolvedValue({ success: true, data: { version: 2 } }),
        revealPath: vi.fn().mockResolvedValue({ success: true, data: { version: 4 } }),
        closeProjection: vi.fn().mockResolvedValue({ success: true, data: undefined }),
      },
    },
  },
}));

type FakeTerminalManager = TerminalManagerStore & {
  isLoaded: boolean;
  createDefaultTerminal: ReturnType<typeof vi.fn>;
};

class FakeTerminalManagerStore {
  terminals = observable.map<string, TerminalStore>();
  isLoaded: boolean;
  createDefaultTerminal = vi.fn().mockResolvedValue(undefined);
  dispose = vi.fn();

  constructor({ terminalIds, isLoaded }: { terminalIds: string[]; isLoaded: boolean }) {
    this.isLoaded = isLoaded;
    for (const id of terminalIds) {
      this.terminals.set(id, makeTerminal(id));
    }
    makeObservable(this, {
      terminals: observable,
      isLoaded: observable,
    });
  }
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'conversation-1',
    projectId: 'project-1',
    providerId: 'codex',
    title: 'Conversation 1',
    lastInteractedAt: null,
    ...overrides,
  };
}

function addSession(
  sessions: ReturnType<typeof sessionRegistry.acquire>,
  overrides: Partial<Session> = {}
): void {
  const session = makeSession(overrides);
  sessions.sessions.set(session.id, new SessionStore(session));
}

function sessionTabIds(viewModel: WorkspaceViewModel): string[] {
  return viewModel.activePane.resolvedTabs.flatMap((tab) => {
    if (tab.kind !== 'session') return [];
    // resource is SessionTabResource which holds the store
    const id = (tab.resource as unknown as { store?: { data?: { id?: string } } })?.store?.data?.id;
    return id ? [id] : [];
  });
}

function makeViewModel(): WorkspaceViewModel {
  return new WorkspaceViewModel({ data: makeSession({ workspaceId: 'workspace-1' }) } as unknown as SessionPageStore);
}

function makeProvisionedViewModel(): WorkspaceViewModel {
  return new WorkspaceViewModel({
    data: makeSession({ workspaceId: 'workspace-1' }),
    workspaceId: 'workspace-1',
  } as unknown as SessionPageStore);
}

function makeTerminal(id: string, name = 'Terminal 1'): TerminalStore {
  return {
    data: {
      id,
      projectId: 'project-1',
      sessionId: 'conversation-1',
      shellId: 'system',
      name,
    } satisfies Terminal,
  } as TerminalStore;
}

function makeTerminalManager({
  terminalIds,
  isLoaded,
}: {
  terminalIds: string[];
  isLoaded: boolean;
}): FakeTerminalManager {
  return new FakeTerminalManagerStore({ terminalIds, isLoaded }) as unknown as FakeTerminalManager;
}

function terminalRegistryEntries(): {
  set(sessionId: string, manager: TerminalManagerStore): void;
  delete(sessionId: string): boolean;
} {
  return (
    terminalRegistry as unknown as {
      entries: {
        set(sessionId: string, manager: TerminalManagerStore): void;
        delete(sessionId: string): boolean;
      };
    }
  ).entries;
}

afterEach(() => {
  // Release the session manager first so the reconciler disposes cleanly.
  releaseSessionPtyManager('conversation-1');
  sessionRegistry.release('conversation-1');
  terminalRegistry.release('conversation-1');
  terminalRegistryEntries().delete('conversation-1');
  workspaceRegistry.release('project-1', 'workspace-1');
  // Clear cache keys written by SessionTabViewPersistor so tests don't pollute each other.
  viewStateCache.delete('session:conversation-1:tabs');
  viewStateCache.delete('session:session-persistor:tabs');
});

describe('WorkspaceViewModel terminal drawer snapshot', () => {
  /**
   * spec session-graph「归档后收拾现场与删除同一条规则」:归档也让这一行离开会话列表,它的 tab 同样不能
   * 留在聊天栏里。2026-09-11 产品面实测到的正是漏了这一条 —— 归档掉父会话后聊天栏落到空态,而同 task 里
   * 那条子会话还活着。判据:两个动词各自的事件都必须走到**同一个**收拾动作上。
   */
  it('归档事件与删除事件走同一个收拾动作,且只认这条会话自己的行', () => {
    vi.mocked(events.on).mockClear();
    const viewModel = makeViewModel();
    const pick = (channel: unknown) =>
      vi
        .mocked(events.on)
        .mock.calls.filter(([c]) => c === channel)
        .at(-1)?.[1] as ((payload: unknown) => void) | undefined;

    const deletedListener = pick(sessionDeletedChannel);
    const changedListener = pick(sessionChangedChannel);
    expect(deletedListener).toBeTypeOf('function');
    // 阳控:归档那一条监听真的注册了 —— 没注册的话下面的「不抛」什么都不证明。
    expect(changedListener).toBeTypeOf('function');

    const retire = vi.spyOn(
      viewModel as unknown as { _retireSessionTabs: (id: string) => void },
      '_retireSessionTabs'
    );

    changedListener?.({
      sessionId: 'conversation-1',
      projectId: 'project-1',
      changes: { archivedAt: '2026-09-11 01:00:00' },
    });
    expect(retire).toHaveBeenCalledWith('conversation-1');

    retire.mockClear();
    // 阴控 ①:别的字段变化不收拾现场(那一行还在列表里)。
    changedListener?.({
      sessionId: 'conversation-1',
      projectId: 'project-1',
      changes: { title: 'renamed' },
    });
    expect(retire).not.toHaveBeenCalled();

    // 阴控 ②:别的会话的归档与这个 view model 无关。
    changedListener?.({
      sessionId: 'c9',
      projectId: 'project-1',
      changes: { archivedAt: '2026-09-11 01:00:00' },
    });
    expect(retire).not.toHaveBeenCalled();

    // 删除那一条走的是同一个动作 —— 一处收拾,两个动词。
    deletedListener?.({ sessionId: 'conversation-1', projectId: 'project-1' });
    expect(retire).toHaveBeenCalledWith('conversation-1');

    retire.mockRestore();
    viewModel.dispose();
  });

  it('persists and restores the active terminal drawer item', () => {
    const source = makeViewModel();
    source.setTerminalDrawerActiveItem({ kind: 'script', id: 'script-lifecycle-run' });

    const restored = makeViewModel();
    restored.restoreSnapshot(source.snapshot);

    expect(restored.terminalDrawerActiveItem).toEqual({
      kind: 'script',
      id: 'script-lifecycle-run',
    });

    source.dispose();
    restored.dispose();
  });

  it.each([
    {
      label: 'leaves a stale empty drawer open while terminal records load',
      terminalIds: ['terminal-1'],
      loaded: false,
      restoredTabs: [],
      loadAfterRestore: true,
      removeAfterRestore: false,
      closesDrawer: false,
    },
    {
      label: 'closes a restored empty drawer after loaded state',
      terminalIds: [],
      loaded: true,
      restoredTabs: [],
      loadAfterRestore: false,
      removeAfterRestore: false,
      closesDrawer: true,
    },
    {
      label: 'closes a restored empty drawer when loading finishes',
      terminalIds: [],
      loaded: false,
      restoredTabs: [],
      loadAfterRestore: true,
      removeAfterRestore: false,
      closesDrawer: true,
    },
    {
      label: 'closes after the last terminal is removed',
      terminalIds: ['terminal-1'],
      loaded: true,
      restoredTabs: ['terminal-1'],
      loadAfterRestore: false,
      removeAfterRestore: true,
      closesDrawer: true,
    },
  ])('terminal drawer: $label', async ({
    terminalIds,
    loaded,
    restoredTabs,
    loadAfterRestore,
    removeAfterRestore,
    closesDrawer,
  }) => {
    const terminals = makeTerminalManager({ terminalIds, isLoaded: loaded });
    terminalRegistryEntries().set('conversation-1', terminals);
    workspaceRegistry.acquire(
      'project-1',
      'workspace-1',
      '/tmp/emdash-test-workspace',
      { settings: {} } as never
    );

    const viewModel = makeProvisionedViewModel();
    viewModel.restoreSnapshot({
      focusedRegion: 'bottom',
      isTerminalDrawerOpen: true,
      terminals: { tabOrder: restoredTabs, activeTabId: restoredTabs[0] },
    });
    viewModel.initialize();

    if (loadAfterRestore) {
      runInAction(() => {
        terminals.isLoaded = true;
      });
    }
    if (removeAfterRestore) {
      runInAction(() => {
        terminals.terminals.delete('terminal-1');
      });
    }
    await Promise.resolve();

    expect(terminals.createDefaultTerminal).not.toHaveBeenCalled();
    expect(viewModel.isTerminalDrawerOpen).toBe(closesDrawer ? false : true);
    if (closesDrawer) {
      expect(viewModel.focusedRegion).toBe('main');
      expect(viewModel.terminalDrawerActiveItem).toBeUndefined();
    }

    viewModel.dispose();
  });
});

describe('WorkspaceViewModel default conversation tab', () => {
  it('waits for provision before opening and hydrating the initial conversation', async () => {
    workspaceRegistry.acquire('project-1', 'workspace-1', '/tmp/emdash-test-workspace', {
      settings: {},
    } as never);
    const sessions = sessionRegistry.acquire('conversation-1', 'project-1', []);
    const hydrateSession = vi.spyOn(sessions, 'hydrateSession').mockResolvedValue();
    vi.spyOn(sessions, 'dehydrateSession').mockResolvedValue();
    const viewModel = makeProvisionedViewModel();

    runInAction(() => {
      addSession(sessions, { id: 'conversation-1' });
    });
    await Promise.resolve();

    expect(sessionTabIds(viewModel)).toEqual([]);
    expect(hydrateSession).not.toHaveBeenCalled();

    viewModel.initialize();
    await Promise.resolve();

    expect(sessionTabIds(viewModel)).toEqual(['conversation-1']);
    expect(hydrateSession).toHaveBeenCalledTimes(1);

    viewModel.dispose();
  });

  it('opens the initial conversation when it arrives after provision', async () => {
    workspaceRegistry.acquire('project-1', 'workspace-1', '/tmp/emdash-test-workspace', {
      settings: {},
    } as never);
    const sessions = sessionRegistry.acquire('conversation-1', 'project-1', []);
    const hydrateSession = vi.spyOn(sessions, 'hydrateSession').mockResolvedValue();
    vi.spyOn(sessions, 'dehydrateSession').mockResolvedValue();
    const viewModel = makeProvisionedViewModel();

    viewModel.initialize();
    runInAction(() => {
      addSession(sessions, { id: 'conversation-1' });
    });
    await Promise.resolve();

    expect(sessionTabIds(viewModel)).toEqual(['conversation-1']);
    expect(hydrateSession).toHaveBeenCalledTimes(1);

    viewModel.dispose();
  });

  it('waits to open a conversation that arrives while suspended until reinitialized', async () => {
    workspaceRegistry.acquire('project-1', 'workspace-1', '/tmp/emdash-test-workspace', {
      settings: {},
    } as never);
    const sessions = sessionRegistry.acquire('conversation-1', 'project-1', []);
    const hydrateSession = vi.spyOn(sessions, 'hydrateSession').mockResolvedValue();
    vi.spyOn(sessions, 'dehydrateSession').mockResolvedValue();
    const viewModel = makeProvisionedViewModel();

    viewModel.initialize();
    viewModel.suspend();
    runInAction(() => {
      addSession(sessions, { id: 'conversation-1' });
    });
    await Promise.resolve();

    expect(sessionTabIds(viewModel)).toEqual([]);
    expect(hydrateSession).not.toHaveBeenCalled();

    viewModel.initialize();
    await Promise.resolve();

    expect(sessionTabIds(viewModel)).toEqual(['conversation-1']);
    expect(hydrateSession).toHaveBeenCalledTimes(1);

    viewModel.dispose();
  });

  it('does not reopen a closed initial conversation when its row changes later', async () => {
    const sessions = sessionRegistry.acquire('conversation-1', 'project-1', []);
    const viewModel = makeViewModel();

    runInAction(() => {
      addSession(sessions, { id: 'conversation-1' });
      viewModel.activePane.open(
        'session',
        { sessionId: 'conversation-1' },
        { preview: false }
      );
    });
    await Promise.resolve();

    viewModel.activePane.closeTab(viewModel.activePane.resolvedActiveTabId!);
    expect(viewModel.activePane.resolvedTabs).toHaveLength(0);

    runInAction(() => {
      addSession(sessions, { id: 'conversation-1', title: 'Renamed' });
    });
    await Promise.resolve();

    expect(viewModel.activePane.resolvedTabs).toHaveLength(0);

    viewModel.dispose();
  });

  it('preserves a restored empty tab state instead of opening the initial conversation', async () => {
    const sessions = sessionRegistry.acquire('conversation-1', 'project-1', [
      makeSession({ id: 'conversation-1' }),
    ]);
    const viewModel = makeViewModel();
    viewModel.restoreSnapshot({
      focusedRegion: 'main',
      tabGroups: {
        groups: [
          {
            groupId: 'group-1',
            tabManager: {
              tabs: [],
              activeTabId: undefined,
            },
          },
        ],
        activeGroupId: 'group-1',
        paneSizes: [100],
      },
    });
    await Promise.resolve();

    expect(viewModel.activePane.resolvedTabs).toHaveLength(0);

    runInAction(() => {
      addSession(sessions, { id: 'conversation-2', title: 'Conversation 2' });
    });
    await Promise.resolve();

    expect(viewModel.activePane.resolvedTabs).toHaveLength(0);

    viewModel.dispose();
  });

  // #6799 页签布局只在专用键 session:<id>:tabs 里、聚合键 session:<id> 从没写过(新会话上常见):照样恢复,
  // 而且恢复出来的就是存下的那份 —— 不另开初始会话、不丢工作区那一组。
  // 存档是以前分成两格的:一条会话一条页签条(spec session-page「并排」),合成一格,两格各自屏上那页并排着回来。
  it('restores the tab layout from session:<id>:tabs without an aggregate snapshot', async () => {
    sessionRegistry.acquire('conversation-1', 'project-1', [
      makeSession({ id: 'conversation-1' }),
    ]);
    viewStateCache.set('session:conversation-1:tabs', {
      groups: [
        {
          groupId: 'chat',
          tabManager: {
            tabs: [{ kind: 'session', tabId: 'tab-chat', sessionId: 'conversation-1', isPreview: false }],
            activeTabId: 'tab-chat',
          },
        },
        {
          groupId: 'tools',
          tabManager: {
            tabs: [
              { kind: 'review', tabId: 'tab-review', sessionId: 'conversation-1', isPreview: false },
              { kind: 'file-browser', tabId: 'tab-files', isPreview: false },
            ],
            activeTabId: 'tab-files',
          },
        },
      ],
      activeGroupId: 'chat',
      paneSizes: [50, 50],
    });
    const viewModel = makeViewModel();

    viewModel.restoreTabs();
    await Promise.resolve();

    const panes = viewModel.paneLayout.groups.map(({ pane }) =>
      pane.resolvedTabs.map((tab) => `${tab.isActive ? '*' : ''}${tab.kind}`)
    );
    expect(panes).toEqual([['*session', '*file-browser', 'review']]);
    expect(viewModel.paneLayout.groups[0].pane.livePair).toMatchObject({ anchor: 'tab-chat', side: 'tab-files', sideAt: 'right' });

    viewModel.dispose();
  });

  it('does not reopen a closed initial conversation when provision finishes afterwards', async () => {
    workspaceRegistry.acquire('project-1', 'workspace-1', '/tmp/emdash-test-workspace', {
      settings: {},
    } as never);
    const sessions = sessionRegistry.acquire('conversation-1', 'project-1', []);
    vi.spyOn(sessions, 'hydrateSession').mockResolvedValue();
    vi.spyOn(sessions, 'dehydrateSession').mockResolvedValue();
    const viewModel = makeProvisionedViewModel();

    runInAction(() => {
      addSession(sessions, { id: 'conversation-1' });
      viewModel.activePane.open(
        'session',
        { sessionId: 'conversation-1' },
        { preview: false }
      );
    });
    await Promise.resolve();

    viewModel.activePane.closeTab(viewModel.activePane.resolvedActiveTabId!);

    viewModel.initialize();
    await Promise.resolve();

    expect(viewModel.activePane.resolvedTabs).toHaveLength(0);

    viewModel.dispose();
  });
});

describe('WorkspaceViewModel conversation hydration', () => {
  it('hydrates an opened conversation exactly once', async () => {
    const viewModel = makeViewModel();
    const sessions = sessionRegistry.acquire('conversation-1', 'project-1', [makeSession()]);
    const hydrateSession = vi.spyOn(sessions, 'hydrateSession').mockResolvedValue();
    vi.spyOn(sessions, 'dehydrateSession').mockResolvedValue();

    // Hydration happens automatically when the tab is opened (via initialize → acquire).
    viewModel.activePane.open(
      'session',
      { sessionId: 'conversation-1' },
      { preview: false }
    );

    expect(hydrateSession).toHaveBeenCalledTimes(1);
    expect(hydrateSession).toHaveBeenCalledWith('conversation-1');

    // Opening the same tab again (no-op due to single-mount dedup in the pane) should not
    // hydrate a second time.
    viewModel.activePane.open(
      'session',
      { sessionId: 'conversation-1' },
      { preview: false }
    );
    expect(hydrateSession).toHaveBeenCalledTimes(1);

    await Promise.resolve();
    viewModel.dispose();
  });

  it('dehydrates the last closed conversation and preview replacement', async () => {
    const viewModel = makeViewModel();
    const sessions = sessionRegistry.acquire('conversation-1', 'project-1', [
      makeSession({ id: 'conversation-1', title: 'Conversation 1' }),
      makeSession({ id: 'conversation-2', title: 'Conversation 2' }),
    ]);
    vi.spyOn(sessions, 'hydrateSession').mockResolvedValue();
    const dehydrateSession = vi
      .spyOn(sessions, 'dehydrateSession')
      .mockResolvedValue();

    // Open conv-1 as preview; initialize() hydrates it.
    viewModel.paneLayout.open(
      'session',
      { sessionId: 'conversation-1' },
      { preview: true }
    );
    await Promise.resolve();

    // Open conv-2 as preview; this retargets the preview slot, disposing conv-1 (dehydrate)
    // and initializing conv-2 (hydrate).
    viewModel.paneLayout.open(
      'session',
      { sessionId: 'conversation-2' },
      { preview: true }
    );
    await Promise.resolve();

    expect(dehydrateSession).toHaveBeenCalledTimes(1);
    expect(dehydrateSession).toHaveBeenCalledWith('conversation-1');

    // Close conv-2; dispose() dehydrates it.
    viewModel.activePane.closeTab(viewModel.activePane.resolvedActiveTabId!);

    expect(dehydrateSession).toHaveBeenCalledTimes(2);
    expect(dehydrateSession).toHaveBeenLastCalledWith('conversation-2');

    viewModel.dispose();
  });

  it('keeps a conversation hydrated while it remains open in another pane', async () => {
    const viewModel = makeViewModel();
    const sessions = sessionRegistry.acquire('conversation-1', 'project-1', [makeSession()]);
    const hydrateSession = vi.spyOn(sessions, 'hydrateSession').mockResolvedValue();
    const dehydrateSession = vi
      .spyOn(sessions, 'dehydrateSession')
      .mockResolvedValue();

    // Restore two panes each with the same conversation (bypasses single-mount dedup).
    // initialize() is called for each pane's tab, but SessionPtyManager ref-counts
    // so hydrateSession is only called once.
    viewModel.restoreSnapshot({
      tabGroups: {
        activeGroupId: 'group-1',
        paneSizes: [50, 50],
        groups: [
          {
            groupId: 'group-1',
            tabManager: {
              activeTabId: 'tab-1',
              tabs: [
                {
                  kind: 'session',
                  tabId: 'tab-1',
                  sessionId: 'conversation-1',
                  isPreview: false,
                },
              ],
            },
          },
          {
            groupId: 'group-2',
            tabManager: {
              activeTabId: 'tab-2',
              tabs: [
                {
                  kind: 'session',
                  tabId: 'tab-2',
                  sessionId: 'conversation-1',
                  isPreview: false,
                },
              ],
            },
          },
        ],
      },
    } as SessionViewSnapshot);

    await Promise.resolve();

    expect(hydrateSession).toHaveBeenCalledTimes(1);

    // 两格合成了一条页签条(spec session-page「并排」),两枚都还在。
    const [group] = viewModel.paneLayout.groups;
    // Closing one tab does NOT dehydrate because the other still holds a ref.
    group.pane.closeTab('tab-1');
    expect(dehydrateSession).not.toHaveBeenCalled();

    // Closing the last tab triggers dehydration.
    group.pane.closeTab('tab-2');
    expect(dehydrateSession).toHaveBeenCalledTimes(1);
    expect(dehydrateSession).toHaveBeenCalledWith('conversation-1');

    viewModel.dispose();
  });

  it('dehydrates all hydrated conversations on suspend', async () => {
    const viewModel = makeViewModel();
    const sessions = sessionRegistry.acquire('conversation-1', 'project-1', [
      makeSession({ id: 'conversation-1', title: 'Conversation 1' }),
      makeSession({ id: 'conversation-2', title: 'Conversation 2' }),
    ]);
    vi.spyOn(sessions, 'hydrateSession').mockResolvedValue();
    const dehydrateSession = vi
      .spyOn(sessions, 'dehydrateSession')
      .mockResolvedValue();

    // Open two conversations; each initialize() acquires the session.
    viewModel.activePane.open(
      'session',
      { sessionId: 'conversation-1' },
      { preview: false }
    );
    viewModel.activePane.open(
      'session',
      { sessionId: 'conversation-2' },
      { preview: false }
    );
    // Both hydrate() continuations are scheduled as microtasks (mock resolves immediately).
    // Two awaits drain both, bringing each to 'running' state before dispose().
    await Promise.resolve();
    await Promise.resolve();

    // dispose() calls paneLayout.dispose() which _disposeEntry()s all tabs.
    // Each entry's provider.dispose() triggers release() → reconciler.sync({}) →
    // dehydrate (since state='running').
    viewModel.dispose();

    expect(dehydrateSession).toHaveBeenCalledTimes(2);
    expect(dehydrateSession).toHaveBeenCalledWith('conversation-1');
    expect(dehydrateSession).toHaveBeenCalledWith('conversation-2');
  });

  it('dehydrates a stale conversation when its hydrate finishes after the tab closed', async () => {
    const viewModel = makeViewModel();
    const sessions = sessionRegistry.acquire('conversation-1', 'project-1', [makeSession()]);
    const hydrate = deferred();
    vi.spyOn(sessions, 'hydrateSession').mockReturnValue(hydrate.promise);
    const dehydrateSession = vi
      .spyOn(sessions, 'dehydrateSession')
      .mockResolvedValue();

    // Open tab; hydrateSession starts but is still pending.
    viewModel.activePane.open(
      'session',
      { sessionId: 'conversation-1' },
      { preview: false }
    );

    // Close tab while hydration is still in-flight; release() removes from desired set.
    viewModel.activePane.closeTab(viewModel.activePane.resolvedActiveTabId!);

    // Dehydration hasn't happened yet because hydration hasn't resolved.
    expect(dehydrateSession).not.toHaveBeenCalled();

    // When the hydrate promise resolves, the reconciler sees the conversation is no longer
    // desired and dehydrates it. Two extra microtask drains let the reconciler's hydrate()
    // continuation run and then the dehydrate() body run.
    hydrate.resolve();
    await hydrate.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(dehydrateSession).toHaveBeenCalledTimes(1);
    expect(dehydrateSession).toHaveBeenCalledWith('conversation-1');

    viewModel.dispose();
  });

  it('does not mark failed hydrations as hydrated and can retry', async () => {
    const viewModel = makeViewModel();
    const sessions = sessionRegistry.acquire('conversation-1', 'project-1', [makeSession()]);
    const hydrateSession = vi
      .spyOn(sessions, 'hydrateSession')
      .mockRejectedValueOnce(new Error('hydrate failed'))
      .mockResolvedValueOnce(undefined);
    const dehydrateSession = vi
      .spyOn(sessions, 'dehydrateSession')
      .mockResolvedValue();

    // First open: hydration fails.
    viewModel.activePane.open(
      'session',
      { sessionId: 'conversation-1' },
      { preview: false }
    );
    await Promise.resolve();

    // Closing and reopening triggers a second initialize() → acquire() → retry.
    viewModel.activePane.closeTab(viewModel.activePane.resolvedActiveTabId!);
    viewModel.activePane.open(
      'session',
      { sessionId: 'conversation-1' },
      { preview: false }
    );
    await Promise.resolve();

    expect(hydrateSession).toHaveBeenCalledTimes(2);

    // Close again to dehydrate.
    viewModel.activePane.closeTab(viewModel.activePane.resolvedActiveTabId!);

    expect(dehydrateSession).toHaveBeenCalledTimes(1);
    expect(dehydrateSession).toHaveBeenCalledWith('conversation-1');

    viewModel.dispose();
  });
});

describe('WorkspaceViewModel tab persistence adapter', () => {
  const PERSISTOR_SESSION_ID = 'session-persistor';

  function makePersistorViewModel(): WorkspaceViewModel {
    return new WorkspaceViewModel({
      data: makeSession({ id: PERSISTOR_SESSION_ID, workspaceId: 'workspace-1' }),
    } as unknown as SessionPageStore);
  }

  it('restores tabs from legacy aggregate tabGroups via the persistor', () => {
    const viewModel = makePersistorViewModel();
    viewModel.restoreSnapshot({
      focusedRegion: 'main',
      tabGroups: {
        groups: [
          {
            groupId: 'group-1',
            tabManager: { tabs: [], activeTabId: undefined },
          },
        ],
        activeGroupId: 'group-1',
        paneSizes: [100],
      },
    });

    expect(viewModel.paneLayout.groups).toHaveLength(1);
    expect(viewModel.paneLayout.groups[0].paneId).toBe('group-1');
    viewModel.dispose();
  });

  it('round-trips an unavailable provider tab through the task persistor', () => {
    const legacyUnavailableTab = {
      kind: 'runtime-demo',
      tabId: 'runtime-demo-tab',
      isPreview: false,
      extensionState: { selectedRow: 7 },
    };
    const unavailableTab = {
      kind: 'extension' as const,
      extensionKind: legacyUnavailableTab.kind,
      tabId: legacyUnavailableTab.tabId,
      isPreview: legacyUnavailableTab.isPreview,
      state: { extensionState: legacyUnavailableTab.extensionState },
    };
    const viewModel = makePersistorViewModel();

    viewModel.restoreSnapshot({
      focusedRegion: 'main',
      tabGroups: {
        groups: [
          {
            groupId: 'group-unknown',
            tabManager: {
              tabs: [legacyUnavailableTab as never],
              activeTabId: legacyUnavailableTab.tabId,
            },
          },
        ],
        activeGroupId: 'group-unknown',
        paneSizes: [100],
      },
    });

    expect(viewModel.paneLayout.snapshot.groups[0]?.tabManager).toEqual({
      tabs: [unavailableTab],
      activeTabId: unavailableTab.tabId,
    });
    viewModel.dispose();
  });

  it('gates default-conversation auto-open when tab state is restored', () => {
    const sessions = sessionRegistry.acquire(PERSISTOR_SESSION_ID, 'project-1', [
      makeSession({
        id: 'conversation-1',
      }),
    ]);
    const viewModel = makePersistorViewModel();

    viewModel.restoreSnapshot({
      focusedRegion: 'main',
      tabGroups: {
        groups: [
          {
            groupId: 'group-1',
            tabManager: { tabs: [], activeTabId: undefined },
          },
        ],
        activeGroupId: 'group-1',
        paneSizes: [100],
      },
    });

    // Conversation list changes should not open a default conversation when tabs were restored.
    runInAction(() => {
      const conv = makeSession({
        id: 'conversation-2',
        title: 'Conversation 2',
      });
      sessions.sessions.set(conv.id, new SessionStore(conv));
    });

    expect(sessionTabIds(viewModel)).toHaveLength(0);
    viewModel.dispose();
    sessionRegistry.release(PERSISTOR_SESSION_ID);
  });

});

describe('WorkspaceViewModel outputs', () => {
  it('最近开的在前、同一个只留一条,存盘往返后还在', () => {
    const source = makeViewModel();
    source.recordOutput({ kind: 'file', path: '/repo/report.md' });
    source.recordOutput({ kind: 'page', url: 'http://localhost:5173/' });
    source.recordOutput({ kind: 'file', path: '/repo/report.md' });

    const restored = makeViewModel();
    restored.restoreSnapshot(source.snapshot);

    expect(restored.outputs).toEqual([
      { kind: 'file', path: '/repo/report.md' },
      { kind: 'page', url: 'http://localhost:5173/' },
    ]);
    source.dispose();
    restored.dispose();
  });

  it('只留最近 50 条', () => {
    const viewModel = makeViewModel();
    for (let i = 0; i <= 50; i++) viewModel.recordOutput({ kind: 'file', path: `/repo/${i}.md` });

    expect(viewModel.outputs).toHaveLength(50);
    expect(viewModel.outputs[0]).toEqual({ kind: 'file', path: '/repo/50.md' });
    expect(viewModel.outputs[49]).toEqual({ kind: 'file', path: '/repo/1.md' });
    viewModel.dispose();
  });
});

// owner 10-06: agents opening the same page again stacked a row of identical tabs.
describe('WorkspaceViewModel showPage', () => {
  function browserTab(tabId: string, currentUrl: string) {
    return { tabId, kind: 'browser', isPreview: true, isActive: false, resource: { browserId: `b-${tabId}`, session: { currentUrl } } };
  }
  function fakeView(
    groups: Array<{ paneId: string; tabs: ReturnType<typeof browserTab>[] }>,
    opts?: { besideConversation?: boolean }
  ) {
    const open = vi.fn();
    const setActiveGroup = vi.fn();
    // 有没有对话可并排(spec session-page「并排」):showBeside 认出那一枚 = true。
    const showBeside = vi.fn(() => opts?.besideConversation ?? false);
    const layoutOpen = vi.fn();
    const panes = groups.map((g) => ({ paneId: g.paneId, pane: { resolvedTabs: g.tabs, pin: vi.fn(), setActiveTab: vi.fn() } }));
    const view = {
      paneLayout: { groups: panes, setActiveGroup, showBeside, open: layoutOpen },
      activePane: { open },
      setWorkspacePanelCollapsed: vi.fn(),
      showPage: WorkspaceViewModel.prototype.showPage,
      openFile: vi.fn(),
    } as unknown as WorkspaceViewModel;
    return { view, open, setActiveGroup, panes, showBeside, layoutOpen };
  }
  function watchReload(browserId: string) {
    const reload = vi.fn();
    browserControlsRegistry.register(browserId, { adapter: { reload } as never, focusUrl: () => {} });
    return reload;
  }
  afterEach(() => browserControlsRegistry.clear());

  it('an agent re-opening an address switches to the tab already showing it and reloads it, instead of stacking a new tab', () => {
    const { view, open, setActiveGroup, panes } = fakeView([{ paneId: 'left', tabs: [browserTab('t1', 'http://localhost:5173/app/')] }]);
    const reload = watchReload('b-t1');

    // Scheme / host casing and the trailing slash are the same address.
    WorkspaceViewModel.prototype.showPage.call(view, 'HTTP://LocalHost:5173/app', { preview: false, reload: true });

    expect(open).not.toHaveBeenCalled();
    expect(setActiveGroup).toHaveBeenCalledWith('left');
    expect(panes[0].pane.setActiveTab).toHaveBeenCalledWith('t1');
    expect(panes[0].pane.pin).toHaveBeenCalledWith('t1');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a person or an App opening it again only switches to it — nothing on the page is thrown away', () => {
    const { view, open, panes } = fakeView([{ paneId: 'left', tabs: [browserTab('t1', 'http://localhost:5173/app/')] }]);
    const reload = watchReload('b-t1');
    WorkspaceViewModel.prototype.showPage.call(view, 'http://localhost:5173/app/', { preview: false, reload: false });

    expect(open).not.toHaveBeenCalled();
    expect(panes[0].pane.setActiveTab).toHaveBeenCalledWith('t1');
    expect(reload).not.toHaveBeenCalled();
  });

  it('finds the tab in whichever pane holds it, and leaves a preview a preview', () => {
    const { view, open, setActiveGroup, panes } = fakeView([
      { paneId: 'left', tabs: [browserTab('t1', 'https://example.com/a')] },
      { paneId: 'right', tabs: [browserTab('t2', 'file:///C:/r/index.html')] },
    ]);
    WorkspaceViewModel.prototype.showPage.call(view, 'file:///C:/r/index.html', { preview: true, reload: true });

    expect(open).not.toHaveBeenCalled();
    expect(setActiveGroup).toHaveBeenCalledWith('right');
    expect(panes[1].pane.setActiveTab).toHaveBeenCalledWith('t2');
    expect(panes[1].pane.pin).not.toHaveBeenCalled();
  });

  it('opens a new tab when only the query or the hash differs — those are part of the page', () => {
    for (const [shown, url] of [
      ['https://example.com/a?v=1', 'https://example.com/a?v=2'],
      ['https://example.com/a', 'https://example.com/a#section'],
    ]) {
      const { view, open } = fakeView([{ paneId: 'left', tabs: [browserTab('t1', shown)] }]);
      WorkspaceViewModel.prototype.showPage.call(view, url, { preview: false, reload: true });
      expect(open).toHaveBeenCalledWith('browser', { initialUrl: url }, { preview: false });
    }
  });

  it('re-opening a page from Outputs brings the tab showing it beside the conversation, without reloading it', () => {
    const { view, open, panes, showBeside } = fakeView(
      [{ paneId: 'left', tabs: [browserTab('t1', 'http://localhost:5173/')] }],
      { besideConversation: true }
    );
    const reload = watchReload('b-t1');
    WorkspaceViewModel.prototype.reopenOutput.call(view, { kind: 'page', url: 'http://localhost:5173/' });

    expect(open).not.toHaveBeenCalled();
    // 同一页已经开着 = 请到对话右边,❌ 新开一枚(spec session-page「并排」)。
    // 人点「输出」= 要看它:并排亮到屏上(reveal)。
    expect(showBeside).toHaveBeenCalledWith('t1', { reveal: true });
    expect(panes[0].pane.setActiveTab).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('with no conversation to sit beside, re-opening from Outputs switches to the tab as before', () => {
    const { view, panes } = fakeView([{ paneId: 'left', tabs: [browserTab('t1', 'http://localhost:5173/')] }]);
    WorkspaceViewModel.prototype.reopenOutput.call(view, { kind: 'page', url: 'http://localhost:5173/' });
    expect(panes[0].pane.setActiveTab).toHaveBeenCalledWith('t1');
  });

  it('re-opening a page from Outputs that is no longer open opens it beside the conversation', () => {
    const { view, open, layoutOpen } = fakeView([{ paneId: 'left', tabs: [] }], { besideConversation: true });
    WorkspaceViewModel.prototype.reopenOutput.call(view, { kind: 'page', url: 'https://example.com/' });
    expect(open).not.toHaveBeenCalled();
    expect(layoutOpen).toHaveBeenCalledWith('browser', { initialUrl: 'https://example.com/' }, { preview: false, beside: true, activate: true });
  });

  it('opens a new tab when nothing shows that address', () => {
    const { view, open } = fakeView([{ paneId: 'left', tabs: [] }]);
    WorkspaceViewModel.prototype.showPage.call(view, 'https://example.com/', { preview: true, reload: true });
    expect(open).toHaveBeenCalledWith('browser', { initialUrl: 'https://example.com/' }, { preview: true });
  });
});

describe('WorkspaceViewModel view activation', () => {
  /**
   * 页签只在真正渲染出来时激活:主栏只在会话 provisioned 时画页签。从没打开过、被闲置回收过的会话(回收把它放回
   * unprovisioned,页签照留)一点开,只看路由就会先激活聊天页签,开场读不到工作区 ⇒「No workspace found for session」。
   */
  afterEach(() => {
    runInAction(() => {
      appState.navigation.currentViewId = 'home';
      appState.navigation.viewParamsStore = {};
    });
  });

  it('路由切到这条会话时,没 provisioned 不激活;provisioned 之后才激活', () => {
    const page = observable({
      data: makeSession({ workspaceId: 'workspace-1' }),
      state: 'unprovisioned' as SessionPageStore['state'],
      workspaceId: null as string | null,
    });
    const viewModel = new WorkspaceViewModel(page as unknown as SessionPageStore);

    runInAction(() => {
      appState.navigation.currentViewId = 'session';
      appState.navigation.viewParamsStore = { session: { projectId: 'project-1', sessionId: 'conversation-1' } };
    });
    expect(viewModel.paneLayout.isViewActive).toBe(false);

    runInAction(() => {
      page.state = 'provisioned';
      page.workspaceId = 'workspace-1';
    });
    expect(viewModel.paneLayout.isViewActive).toBe(true);

    // 阴控:provisioned 但路由不是它 ⇒ 不激活(判据没有退化成只看挂载)。
    runInAction(() => {
      appState.navigation.currentViewId = 'home';
    });
    expect(viewModel.paneLayout.isViewActive).toBe(false);
    viewModel.dispose();
  });
});
