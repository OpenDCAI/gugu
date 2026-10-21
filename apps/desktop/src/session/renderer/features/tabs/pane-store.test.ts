import { makeObservable, observable, runInAction } from 'mobx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserDiagnosticsStore } from '@renderer/features/browser/browser-diagnostics-store';
import { browserSessionStore } from '@renderer/features/browser/browser-session-store';
import { events } from '@renderer/lib/ipc';
import { browserOpenInNewTabChannel } from '@shared/events/browserEvents';
import type { ExtensionTabDescriptor, TabDescriptor } from '@shared/view-state';

vi.mock('@renderer/lib/ipc', () => ({
  events: {
    on: vi.fn(() => () => {}),
  },
  rpc: {
    app: {
      readUserFile: vi.fn(),
    },
    browser: {
      unregisterSession: vi.fn(),
    },
    ssh: {
      getConnections: vi.fn(async () => []),
      getConnectionState: vi.fn(async () => ({})),
      getHealthStates: vi.fn(async () => ({})),
    },
  },
}));

vi.mock('@renderer/lib/monaco/monaco-model-registry', () => ({
  modelRegistry: {
    dirtyUris: new Set<string>(),
    isDirty: vi.fn(() => false),
    modelStatus: new Map<string, string>(),
    modelTotalSizes: new Map<string, number>(),
    toDiskUri: (uri: string) => uri,
  },
}));

vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: {
    projects: {
      projects: new Map(),
    },
    sshConnections: {
      healthFor: vi.fn(() => ({ status: 'ok' })),
    },
  },
  sidebarStore: {},
}));

// Stub out the React UI components brought in by the definitions bootstrap so
// the test can run in the node Vitest project without a real DOM.
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

import type { BrowserTabResource } from '@renderer/features/browser/browser-tab-resource';
import { terminalRegistry } from '@renderer/features/sessions/stores/terminal-registry';
import { sessionTabView } from '@renderer/features/sessions/session-tab-registry';
import type {
  TerminalManagerStore,
  TerminalStore,
} from '@renderer/features/sessions/terminals/terminal-manager';
import type { ResolvedTab } from './core/tab-provider';
import { createTabProvider, createTabRegistry } from './core/tab-provider-registry';
import { PaneStore } from './pane-store';

const testCtx = {
  viewId: 'task-1',
  projectId: 'project-1',
  workspaceId: 'workspace-1',
  sessionId: 'task-1',
  modelRootPath: 'workspace:workspace-1',
};

function createTabManager() {
  return new PaneStore(sessionTabView.registry, testCtx);
}

function browserResource(tab: ResolvedTab | undefined): BrowserTabResource | undefined {
  return tab?.resource as BrowserTabResource | undefined;
}

class FakeTerminalManagerStore {
  terminals = observable.map<string, TerminalStore>();
  sessions = observable.map();
  isLoaded: boolean;
  dispose = vi.fn();

  constructor({ terminalIds, isLoaded }: { terminalIds: string[]; isLoaded: boolean }) {
    this.isLoaded = isLoaded;
    for (const id of terminalIds) {
      this.terminals.set(id, {
        data: {
          id,
          projectId: 'project-1',
          sessionId: 'session-1',
          shellId: 'system',
          name: 'Terminal 1',
        },
      } as TerminalStore);
    }
    makeObservable(this, {
      terminals: observable,
      sessions: observable,
      isLoaded: observable,
    });
  }
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

describe('PaneStore browser tabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    browserDiagnosticsStore.clear();
    browserSessionStore.clear();
  });

  afterEach(() => {
    terminalRegistry.release('task-1');
    terminalRegistryEntries().delete('task-1');
  });

  it('opens browser tabs backed by the default browser profile session', () => {
    const manager = createTabManager();

    manager.open('browser', { initialUrl: 'localhost:5173' });

    const tab = manager.resolvedTabs[0];
    expect(tab).toMatchObject({
      kind: 'browser',
      isActive: true,
    });
    expect(browserResource(tab)?.session?.currentUrl).toBe('http://localhost:5173/');
    expect(browserResource(tab)?.session?.partition).toBe('persist:gugu-browser-profile');
  });

  it('snapshots and restores browser tabs through tab manager state', () => {
    const source = createTabManager();
    source.open('browser', { initialUrl: 'example.com' });

    const snapshot = source.snapshot;
    expect(structuredClone(snapshot)).toEqual(snapshot);
    const restored = createTabManager();
    browserSessionStore.clear();
    restored.restoreSnapshot(snapshot);

    expect(restored.snapshot).toMatchObject({
      activeTabId: snapshot.activeTabId,
      tabs: [
        {
          kind: 'browser',
          session: {
            currentUrl: 'https://example.com/',
            isLoading: false,
          },
        },
      ],
    });
    expect(restored.resolvedTabs[0]?.kind).toBe('browser');
  });

  it('opens, restores, and closes a provider registered after store construction', () => {
    const registry = createTabRegistry([] as const);
    const source = new PaneStore(registry, testCtx);
    const runtimeProvider = createTabProvider({
      kind: 'runtime-demo',
      resourceKey: (state: { selection: number }) => String(state.selection),
      initialize: (entry) => ({ state: entry.state, dispose() {} }),
      dispose: () => {},
      TabBarItem: () => null,
      TabBarItemDragPreview: () => null,
      TabContent: () => null,
    });

    registry.register(runtimeProvider);
    source.openKind(runtimeProvider.kind, { selection: 4 });

    expect(source.snapshot.tabs).toEqual([
      expect.objectContaining({
        kind: 'extension',
        extensionKind: runtimeProvider.kind,
        state: { selection: 4 },
      }),
    ]);

    const restored = new PaneStore(registry, testCtx);
    restored.restoreSnapshot(source.snapshot);

    expect(restored.resolvedTabs[0]).toMatchObject({ kind: runtimeProvider.kind, isActive: true });
    expect(restored.resolvedTabs[0]?.resource).toMatchObject({ state: { selection: 4 } });

    restored.requestCloseTab(restored.resolvedTabs[0]!.tabId);
    expect(restored.resolvedTabs).toEqual([]);

    restored.reopenClosedTab();
    expect(restored.resolvedTabs[0]).toMatchObject({ kind: runtimeProvider.kind, isActive: true });
    expect(restored.resolvedTabs[0]?.resource).toMatchObject({ state: { selection: 4 } });

    source.dispose();
    restored.dispose();
  });

  it('omits runtime-only tabs from snapshots and closed-tab history', () => {
    const registry = createTabRegistry([] as const);
    const provider = createTabProvider({
      kind: 'runtime-only-demo',
      resourceKey: (state: { id: string; transient: boolean }) => state.id,
      isPersistent: (state) => !state.transient,
      initialize: (entry) => ({ state: entry.state, dispose() {} }),
      dispose: () => {},
      TabBarItem: () => null,
      TabBarItemDragPreview: () => null,
      TabContent: () => null,
    });
    registry.register(provider);
    const store = new PaneStore(registry, testCtx);

    store.openKind(provider.kind, { id: 'persisted', transient: false });
    const persistedTabId = store.activeTabId;
    store.openKind(provider.kind, { id: 'side-chat:view-1', transient: true });
    const transientTabId = store.activeTabId;

    expect(store.snapshot).toEqual({
      tabs: [expect.objectContaining({ state: { id: 'persisted', transient: false } })],
      activeTabId: persistedTabId,
    });

    store.requestCloseTab(transientTabId!);
    store.reopenClosedTab();

    expect(store.resolvedTabs).toHaveLength(1);
    expect(store.resolvedTabs[0]?.tabId).toBe(persistedTabId);
    expect(store.resolvedTabs[0]?.resource).toMatchObject({
      state: { id: 'persisted', transient: false },
    });
    store.dispose();
  });

  it('restores, round-trips, and closes a persisted tab whose provider is unavailable', () => {
    const manager = createTabManager();
    const unavailableTab: ExtensionTabDescriptor = {
      kind: 'extension',
      extensionKind: 'runtime-demo',
      tabId: 'unavailable-tab-1',
      isPreview: false,
      state: { extensionState: { selection: 3 } },
    };

    expect(() =>
      manager.restoreSnapshot({
        tabs: [unavailableTab],
        activeTabId: unavailableTab.tabId,
      })
    ).not.toThrow();

    expect(manager.resolvedTabs).toEqual([
      expect.objectContaining({
        kind: unavailableTab.extensionKind,
        tabId: unavailableTab.tabId,
        isActive: true,
      }),
    ]);
    expect(manager.snapshot).toEqual({
      tabs: [unavailableTab],
      activeTabId: unavailableTab.tabId,
    });

    manager.requestCloseTab(unavailableTab.tabId);

    expect(manager.resolvedTabs).toEqual([]);
    expect(manager.snapshot.tabs).toEqual([]);
  });

  it('closes a kind\'s open tabs outright when asked to — a disable is not an uninstall', () => {
    // owner (#5265):「已开的标签保留但降级为『未加载』占位不合适吧,还得手动删垃圾是吧?」
    // 从面板移除(停用)是用户自己要的「别再显示」,留个占位就是垃圾;卸载那条(上一条判据)
    // 照旧保留占位。两条路都要在,且互不串。
    const registry = createTabRegistry([] as const);
    const disposed: string[] = [];
    const provider = createTabProvider({
      kind: 'closing-demo',
      resourceKey: (state: { selection: number }) => String(state.selection),
      initialize: (entry) => ({
        state: entry.state,
        dispose() {
          disposed.push(entry.tabId);
        },
      }),
      dispose: () => {},
      TabBarItem: () => null,
      TabBarItemDragPreview: () => null,
      TabContent: () => null,
    });
    registry.register(provider);
    const store = new PaneStore(registry, testCtx);
    store.restoreSnapshot({
      tabs: [
        { kind: 'extension', extensionKind: 'closing-demo', tabId: 'c-1', isPreview: false, state: { selection: 1 } },
        { kind: 'extension', extensionKind: 'closing-demo', tabId: 'c-2', isPreview: false, state: { selection: 2 } },
      ],
      activeTabId: 'c-1',
    });
    expect(store.resolvedTabs).toHaveLength(2);

    registry.closeKind('closing-demo');
    registry.unregister('closing-demo');

    // Gone, not demoted: no placeholder left to close by hand, surfaces torn down.
    expect(store.resolvedTabs).toHaveLength(0);
    expect(disposed.sort()).toEqual(['c-1', 'c-2']);
    // Re-enabling brings nothing back on its own — there is no tab to revive.
    registry.register(provider);
    expect(store.resolvedTabs).toHaveLength(0);
  });

  it('closes only the tabs of a kind whose state it is asked for', () => {
    // 摩擦单 F98: an App's tab taken out of every session closes; what it opened for a file stays.
    const registry = createTabRegistry([] as const);
    const provider = createTabProvider({
      kind: 'some-demo',
      resourceKey: (state: { filePath?: string }) => state.filePath ?? '',
      initialize: (entry) => ({ state: entry.state, dispose() {} }),
      dispose: () => {},
      TabBarItem: () => null,
      TabBarItemDragPreview: () => null,
      TabContent: () => null,
    });
    registry.register(provider);
    const store = new PaneStore(registry, testCtx);
    store.restoreSnapshot({
      tabs: [
        { kind: 'extension', extensionKind: 'some-demo', tabId: 's-1', isPreview: false, state: {} },
        { kind: 'extension', extensionKind: 'some-demo', tabId: 's-2', isPreview: false, state: { filePath: 'TODO.md' } },
      ],
      activeTabId: 's-1',
    });

    registry.closeKind('some-demo', (state) => !(state as { filePath?: string }).filePath);

    expect(store.resolvedTabs.map((tab) => tab.tabId)).toEqual(['s-2']);
  });

  it('demotes a live tab to a placeholder when its provider is withdrawn, then revives it', () => {
    // 这条来自真机:卸载一个扩展之后,它开着的 tab 仍在渲染自己的 webview —— 卸掉的东西
    // 还活着,直到下次重启。用户卸载往往正是因为不再信任它,所以「不关掉这个 tab」不等于
    // 「让它继续画」。
    const registry = createTabRegistry([] as const);
    const disposed: string[] = [];
    const provider = createTabProvider({
      kind: 'withdrawn-demo',
      resourceKey: (state: { selection: number }) => String(state.selection),
      initialize: (entry) => ({
        state: entry.state,
        dispose() {
          disposed.push(entry.tabId);
        },
      }),
      dispose: () => {},
      TabBarItem: () => null,
      TabBarItemDragPreview: () => null,
      TabContent: () => null,
    });
    registry.register(provider);

    const store = new PaneStore(registry, testCtx);
    store.restoreSnapshot({
      tabs: [
        {
          kind: 'extension',
          extensionKind: 'withdrawn-demo',
          tabId: 'withdrawn-tab-1',
          isPreview: false,
          state: { selection: 5 },
        },
      ],
      activeTabId: 'withdrawn-tab-1',
    });
    expect(store.resolvedTabs[0]?.resource).toMatchObject({ state: { selection: 5 } });

    expect(registry.unregister('withdrawn-demo')).toBe(true);

    // The tab is still there — the user did not close it — but nothing draws it now,
    // and the surface it had was torn down rather than left running.
    expect(store.resolvedTabs).toHaveLength(1);
    expect(store.resolvedTabs[0]?.tabId).toBe('withdrawn-tab-1');
    expect(disposed).toEqual(['withdrawn-tab-1']);
    expect(store.resolvedTabs[0]?.resource).not.toMatchObject({ state: { selection: 5 } });

    // Reinstalling brings that very tab back, with what it had persisted.
    registry.register(provider);
    expect(store.resolvedTabs).toHaveLength(1);
    expect(store.resolvedTabs[0]?.tabId).toBe('withdrawn-tab-1');
    expect(store.resolvedTabs[0]?.resource).toMatchObject({ state: { selection: 5 } });
  });

  it('revives an unavailable tab in place when its provider registers later', () => {
    const registry = createTabRegistry([] as const);
    const store = new PaneStore(registry, testCtx);
    store.restoreSnapshot({
      tabs: [
        {
          kind: 'extension',
          extensionKind: 'late-demo',
          tabId: 'late-tab-1',
          isPreview: false,
          state: { selection: 7 },
        },
      ],
      activeTabId: 'late-tab-1',
    });

    // Nothing provides this kind yet, so the tab is held as a placeholder.
    expect(store.resolvedTabs[0]?.resource).not.toMatchObject({ state: { selection: 7 } });

    registry.register(
      createTabProvider({
        kind: 'late-demo',
        resourceKey: (state: { selection: number }) => String(state.selection),
        initialize: (entry) => ({ state: entry.state, dispose() {} }),
        dispose: () => {},
        TabBarItem: () => null,
        TabBarItemDragPreview: () => null,
        TabContent: () => null,
      })
    );

    // Promoted in place: same tab, same persisted state, still active.
    expect(store.resolvedTabs).toHaveLength(1);
    expect(store.resolvedTabs[0]).toMatchObject({
      kind: 'late-demo',
      tabId: 'late-tab-1',
      isActive: true,
    });
    expect(store.resolvedTabs[0]?.resource).toMatchObject({ state: { selection: 7 } });
    expect(store.snapshot.tabs).toEqual([
      expect.objectContaining({ kind: 'extension', extensionKind: 'late-demo', tabId: 'late-tab-1' }),
    ]);

    store.dispose();
  });

  it('stops reviving tabs once the pane is disposed', () => {
    const registry = createTabRegistry([] as const);
    const store = new PaneStore(registry, testCtx);
    store.restoreSnapshot({
      tabs: [
        {
          kind: 'extension',
          extensionKind: 'after-dispose',
          tabId: 'gone-tab',
          isPreview: false,
          state: {},
        },
      ],
      activeTabId: 'gone-tab',
    });
    store.dispose();

    expect(() =>
      registry.register(
        createTabProvider({
          kind: 'after-dispose',
          resourceKey: () => 'k',
          initialize: () => ({ dispose() {} }),
          dispose: () => {},
          TabBarItem: () => null,
          TabBarItemDragPreview: () => null,
          TabContent: () => null,
        })
      )
    ).not.toThrow();
  });

  it('requires the state fields of a built-in descriptor', () => {
    // @ts-expect-error conversation descriptors must retain their conversation identity.
    const bad: TabDescriptor = { kind: 'session', tabId: 't', isPreview: false };

    expect(bad.kind).toBe('session');
  });

  it('cleans up browser session state on close', () => {
    const manager = createTabManager();
    manager.open('browser', {});
    const tab = manager.resolvedTabs[0];
    const browserId = browserResource(tab)?.browserId ?? '';
    browserDiagnosticsStore.append({
      browserId,
      level: 'error',
      source: 'console',
      message: 'failure',
    });

    manager.closeTab(tab?.tabId ?? '');

    expect(browserSessionStore.getSession(browserId)).toBeUndefined();
    expect(browserDiagnosticsStore.entriesForBrowser(browserId)).toEqual([]);
    expect(manager.resolvedTabs).toEqual([]);
  });

  it('cleans up replaced browser sessions on snapshot restore', () => {
    const manager = createTabManager();
    manager.open('browser', {});
    const oldTab = manager.resolvedTabs[0];
    const oldBrowserId = browserResource(oldTab)?.browserId ?? '';

    manager.restoreSnapshot({ tabs: [], activeTabId: undefined });

    expect(browserSessionStore.getSession(oldBrowserId)).toBeUndefined();
    expect(manager.resolvedTabs).toEqual([]);
  });

  it('cleans up browser sessions on dispose', () => {
    const manager = createTabManager();
    manager.open('browser', {});
    const tab = manager.resolvedTabs[0];
    const browserId = browserResource(tab)?.browserId ?? '';

    manager.dispose();

    expect(browserSessionStore.getSession(browserId)).toBeUndefined();
  });

  it('detaches browser tabs for pane moves without removing session state', () => {
    const manager = createTabManager();
    manager.open('browser', {});
    const tab = manager.resolvedTabs[0];
    const browserId = browserResource(tab)?.browserId ?? '';

    const detached = manager.detachTab(tab?.tabId ?? '');

    expect(detached?.entry?.kind).toBe('browser');
    expect(browserSessionStore.getSession(browserId)).toBeDefined();
    expect(manager.resolvedTabs).toEqual([]);
  });

  it('opens webview popup requests as sibling browser tabs', () => {
    const listeners: Array<(event: { sourceBrowserId: string; url: string }) => void> = [];
    vi.mocked(events.on).mockImplementation((channel, listener) => {
      if (channel === browserOpenInNewTabChannel) {
        listeners.push(listener as (event: { sourceBrowserId: string; url: string }) => void);
      }
      return () => {};
    });
    const manager = createTabManager();
    manager.open('browser', { initialUrl: 'https://source.example/' });
    const source = manager.resolvedTabs[0];
    const sourceBrowserId = browserResource(source)?.browserId ?? '';

    listeners[0]?.({
      sourceBrowserId,
      url: 'https://target.example/path',
    });

    expect(manager.resolvedTabs).toHaveLength(2);
    expect(manager.resolvedTabs[1]).toMatchObject({
      kind: 'browser',
      isActive: true,
    });
    expect(browserResource(manager.resolvedTabs[1])?.session?.currentUrl).toBe(
      'https://target.example/path'
    );
  });
});

describe('PaneStore terminal tabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalRegistryEntries().set(
      'task-1',
      new FakeTerminalManagerStore({
        terminalIds: ['terminal-1'],
        isLoaded: true,
      }) as unknown as TerminalManagerStore
    );
  });

  afterEach(() => {
    terminalRegistry.release('task-1');
    terminalRegistryEntries().delete('task-1');
  });

  it('opens and snapshots an existing terminal as a task tab', () => {
    const manager = createTabManager();

    manager.open('terminal', { terminalId: 'terminal-1' });

    expect(manager.resolvedTabs[0]).toMatchObject({
      kind: 'terminal',
      isActive: true,
    });
    expect(manager.snapshot.tabs[0]).toMatchObject({
      kind: 'terminal',
      terminalId: 'terminal-1',
      isPreview: false,
    });
  });

  it('restores terminal tab descriptors without creating a new terminal runtime', () => {
    const restored = createTabManager();

    restored.restoreSnapshot({
      activeTabId: 'tab-terminal-1',
      tabs: [
        {
          kind: 'terminal',
          tabId: 'tab-terminal-1',
          terminalId: 'terminal-1',
          isPreview: false,
        },
      ],
    });

    expect(restored.resolvedTabs[0]).toMatchObject({
      kind: 'terminal',
      tabId: 'tab-terminal-1',
      isActive: true,
    });
    expect(terminalRegistry.get('task-1')?.terminals.has('terminal-1')).toBe(true);
  });

  it('closing a terminal task tab only closes the tab view', () => {
    const manager = createTabManager();
    manager.open('terminal', { terminalId: 'terminal-1' });

    manager.closeTab(manager.resolvedTabs[0]?.tabId ?? '');

    expect(manager.resolvedTabs).toEqual([]);
    expect(terminalRegistry.get('task-1')?.terminals.has('terminal-1')).toBe(true);
  });

  it('stale-closes terminal tabs when the drawer-owned terminal is removed', async () => {
    const manager = createTabManager();
    manager.open('terminal', { terminalId: 'terminal-1' });

    runInAction(() => {
      terminalRegistry.get('task-1')?.terminals.delete('terminal-1');
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(manager.resolvedTabs).toEqual([]);
  });

  it('stale-closes restored terminal tabs after initialization finishes', async () => {
    const terminals = terminalRegistry.get('task-1') as unknown as FakeTerminalManagerStore;
    runInAction(() => {
      terminals.terminals.clear();
      terminals.isLoaded = true;
    });

    const restored = createTabManager();
    restored.restoreSnapshot({
      activeTabId: 'tab-terminal-1',
      tabs: [
        {
          kind: 'terminal',
          tabId: 'tab-terminal-1',
          terminalId: 'terminal-1',
          isPreview: false,
        },
      ],
    });

    expect(restored.resolvedTabs).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(restored.resolvedTabs).toEqual([]);
  });
});

// 页签右键「关闭其他 / 关闭右侧 / 关闭全部」(spec session-page「一屏几块」,#7052)。
describe('PaneStore closing a row of tabs', () => {
  function storeWithGuard(dirty: Set<string>, asked: string[], answers: Array<(ok: boolean) => void>) {
    const registry = createTabRegistry([] as const);
    const provider = createTabProvider({
      kind: 'close-demo',
      resourceKey: (state: { id: string }) => state.id,
      initialize: (entry) => ({ state: entry.state, dispose() {} }),
      // 像没存的文件:关之前问一句,答了才关。
      onBeforeClose: (entry) => {
        const id = (entry.state as { id: string }).id;
        if (!dirty.has(id)) return true;
        asked.push(id);
        return new Promise<boolean>((resolve) => answers.push(resolve));
      },
      dispose: () => {},
      TabBarItem: () => null,
      TabBarItemDragPreview: () => null,
      TabContent: () => null,
    });
    registry.register(provider);
    const store = new PaneStore(registry, testCtx);
    for (const id of ['a', 'b', 'c', 'd']) store.openKind(provider.kind, { id });
    const ids = () => store.resolvedTabs.map((t) => (store.entries.get(t.tabId)?.state as { id: string }).id);
    const tabOf = (id: string) => store.resolvedTabs.find((t) => (store.entries.get(t.tabId)?.state as { id: string }).id === id)!.tabId;
    return { store, ids, tabOf };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('关闭右侧:只关这一枚右边的', async () => {
    const { store, ids, tabOf } = storeWithGuard(new Set(), [], []);
    store.closeToRight(tabOf('b'));
    await flush();
    expect(ids()).toEqual(['a', 'b']);
  });

  it('关闭全部:一枚不剩', async () => {
    const { store, ids } = storeWithGuard(new Set(), [], []);
    store.closeAll();
    await flush();
    expect(ids()).toEqual([]);
  });

  it('一排里有没存的:一枚一枚问,答「不关」的那枚留下;❌ 悄悄强关', async () => {
    const asked: string[] = [];
    const answers: Array<(ok: boolean) => void> = [];
    const { store, ids, tabOf } = storeWithGuard(new Set(['b', 'c']), asked, answers);

    store.closeOthers(tabOf('a'));
    await flush();
    // 停在 b 上等回答,c 还没问。
    expect(asked).toEqual(['b']);
    expect(ids()).toEqual(['a', 'b', 'c', 'd']);

    answers[0](false);
    await flush();
    expect(asked).toEqual(['b', 'c']);
    answers[1](true);
    await flush();
    expect(ids()).toEqual(['a', 'b']);
  });
});

// 关会话自己那枚时要不要问「会话和页签都关 / 只关会话」(#7097):只有用户单独关这一枚才算 alone。
describe('PaneStore tells a lone close from a row', () => {
  function storeRecording(seen: Array<[string, boolean]>) {
    const registry = createTabRegistry([] as const);
    const provider = createTabProvider({
      kind: 'close-alone-demo',
      resourceKey: (state: { id: string }) => state.id,
      initialize: (entry) => ({ state: entry.state, dispose() {} }),
      onBeforeClose: (entry, _resource, _ctx, request) => {
        seen.push([(entry.state as { id: string }).id, request.alone]);
        return true;
      },
      dispose: () => {},
      TabBarItem: () => null,
      TabBarItemDragPreview: () => null,
      TabContent: () => null,
    });
    registry.register(provider);
    const store = new PaneStore(registry, testCtx);
    for (const id of ['a', 'b', 'c']) store.openKind(provider.kind, { id });
    const tabOf = (id: string) => store.resolvedTabs.find((t) => (store.entries.get(t.tabId)?.state as { id: string }).id === id)!.tabId;
    return { store, tabOf };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('×、⌘W = 单独关这一枚;关闭其他 / 全部 = 一排,不算单独', async () => {
    const seen: Array<[string, boolean]> = [];
    const { store, tabOf } = storeRecording(seen);
    store.requestCloseTab(tabOf('a'));
    await flush();
    expect(seen).toEqual([['a', true]]);
    store.closeOthers(tabOf('b'));
    await flush();
    expect(seen).toEqual([['a', true], ['c', false]]);
    store.closeActiveTab();
    await flush();
    expect(seen.at(-1)).toEqual(['b', true]);
  });

  it('替会话一次关掉几枚(requestCloseTabs)也是一排', async () => {
    const seen: Array<[string, boolean]> = [];
    const { store, tabOf } = storeRecording(seen);
    await store.requestCloseTabs([tabOf('b'), tabOf('c')]);
    expect(seen).toEqual([['b', false], ['c', false]]);
    expect(store.resolvedTabs).toHaveLength(1);
  });
});

