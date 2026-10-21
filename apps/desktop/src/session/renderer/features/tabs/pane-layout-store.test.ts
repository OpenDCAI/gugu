import { intercept, makeObservable, observable, runInAction } from 'mobx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/lib/ipc', () => ({
  events: {
    on: vi.fn(() => () => {}),
  },
  rpc: {
    app: { readUserFile: vi.fn() },
    browser: { unregisterSession: vi.fn() },
    ssh: {
      getConnections: vi.fn(async () => []),
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
vi.mock('@renderer/utils/logger', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { browserSessionStore } from '@renderer/features/browser/browser-session-store';
import { terminalRegistry } from '@renderer/features/sessions/stores/terminal-registry';
import { sessionTabView } from '@renderer/features/sessions/session-tab-registry';
import { createTabProvider, createTabRegistry } from './core/tab-provider-registry';
import type {
  TerminalManagerStore,
  TerminalStore,
} from '@renderer/features/sessions/terminals/terminal-manager';
import { PaneLayoutStore, paneEdgeDropId } from './pane-layout-store';
import type { PaneLayoutNode } from './pane-layout-tree';

const testCtx = {
  viewId: 'task-1',
  projectId: 'project-1',
  workspaceId: 'workspace-1',
  sessionId: 'task-1',
  modelRootPath: 'workspace:workspace-1',
};

function createLayout(opts?: { onActiveTabChange?: (tabId: string | undefined) => void }) {
  return new PaneLayoutStore(sessionTabView.registry, testCtx, undefined, opts);
}

function createRuntimeProjectionLayout(onActiveTabChange = vi.fn()) {
  const persistentDispose = vi.fn();
  const runtimeDispose = vi.fn();
  const persistentProvider = createTabProvider({
    kind: 'persistent-test',
    resourceKey: (state: { id: string }) => state.id,
    initialize: () => ({ dispose: persistentDispose }),
    dispose: () => {},
    TabBarItem: () => null,
    TabBarItemDragPreview: () => null,
    TabContent: () => null,
  });
  const runtimeProvider = createTabProvider({
    kind: 'runtime-test',
    resourceKey: (state: { id: string }) => state.id,
    isPersistent: () => false,
    initialize: () => ({ dispose: runtimeDispose }),
    dispose: () => {},
    TabBarItem: () => null,
    TabBarItemDragPreview: () => null,
    TabContent: () => null,
  });
  const registry = createTabRegistry([persistentProvider, runtimeProvider] as const);
  return {
    layout: new PaneLayoutStore(registry, testCtx, undefined, { onActiveTabChange }),
    onActiveTabChange,
    runtimeDispose,
  };
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

describe('PaneLayoutStore: isViewActive and onActivate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    browserSessionStore.clear();
  });

  it('isVisible is false for all panes when isViewActive is false (default)', () => {
    const layout = createLayout();
    expect(layout.focusedPane.isVisible).toBe(false);
    layout.dispose();
  });

  it('isVisible becomes true for all panes after setViewActive(true)', () => {
    const layout = createLayout();
    runInAction(() => layout.setViewActive(true));
    expect(layout.focusedPane.isVisible).toBe(true);
    layout.dispose();
  });

  it('fires onActivate on the active tab when the view becomes active', () => {
    const layout = createLayout();
    layout.open('browser', {});
    const resource = layout.focusedPane.resolvedTabs[0]?.resource;
    const onActivate = vi.fn();
    // Inject a spy onto the resource.
    (resource as { onActivate?: () => void }).onActivate = onActivate;

    runInAction(() => layout.setViewActive(true));

    expect(onActivate).toHaveBeenCalledTimes(1);
    layout.dispose();
  });

  it('fires onActivate on the newly active tab when the active tab changes while view is active', () => {
    const layout = createLayout();
    layout.open('browser', {});
    layout.open('browser', {});

    const tabs = layout.focusedPane.resolvedTabs;
    const firstResource = tabs[0]?.resource;
    const secondResource = tabs[1]?.resource;
    const firstSpy = vi.fn();
    const secondSpy = vi.fn();
    (firstResource as { onActivate?: () => void }).onActivate = firstSpy;
    (secondResource as { onActivate?: () => void }).onActivate = secondSpy;

    runInAction(() => layout.setViewActive(true));
    // Second tab is active (opened last).
    expect(secondSpy).toHaveBeenCalledTimes(1);

    // Switch to first tab.
    runInAction(() => layout.focusedPane.setActiveTab(tabs[0]!.tabId));
    expect(firstSpy).toHaveBeenCalledTimes(1);

    layout.dispose();
  });

  it('does not fire onActivate when the view is inactive', () => {
    const layout = createLayout();
    layout.open('browser', {});
    const resource = layout.focusedPane.resolvedTabs[0]?.resource;
    const onActivate = vi.fn();
    (resource as { onActivate?: () => void }).onActivate = onActivate;

    // View stays inactive — no onActivate.
    expect(onActivate).not.toHaveBeenCalled();
    layout.dispose();
  });

  it('fires onActivate for each pane on setViewActive when split panes exist', () => {
    const layout = createLayout();
    // Open two browser tabs so splitRight() has something to split.
    layout.open('browser', {});
    layout.open('browser', {});
    layout.splitRight();

    expect(layout.groups).toHaveLength(2);

    const leftResource = layout.groups[0]!.pane.resolvedTabs.at(-1)?.resource;
    const rightResource = layout.groups[1]!.pane.resolvedTabs[0]?.resource;
    const leftSpy = vi.fn();
    const rightSpy = vi.fn();
    if (leftResource) (leftResource as { onActivate?: () => void }).onActivate = leftSpy;
    if (rightResource) (rightResource as { onActivate?: () => void }).onActivate = rightSpy;

    runInAction(() => layout.setViewActive(true));

    expect(leftSpy).toHaveBeenCalledTimes(1);
    expect(rightSpy).toHaveBeenCalledTimes(1);
    layout.dispose();
  });

  it('fires onActivate on the new resource when a preview tab is retargeted while the pane is visible', () => {
    const layout = createLayout();
    runInAction(() => layout.setViewActive(true));

    // Open the first preview tab — resource A created and activated.
    layout.open('browser', {}, { preview: true });
    const tabId = layout.focusedPane.resolvedActiveTabId;

    // Set up an intercept so the next resource written into _resources gets a
    // spy as its onActivate. This fires synchronously before the value is stored,
    // so the spy is installed before the reaction can call onActivate().
    const spy = vi.fn();
    const disposer = intercept(layout.focusedPane._resources, (change) => {
      if (change.type === 'add' || change.type === 'update') {
        (change.newValue as { onActivate?: () => void }).onActivate = spy;
      }
      return change;
    });

    // Open a second preview tab — retargets the same slot (same tabId, new resource B).
    layout.open('browser', {}, { preview: true });
    disposer();

    // Confirm this actually took the retarget path (tabId must not have changed).
    expect(layout.focusedPane.resolvedActiveTabId).toBe(tabId);

    // With the fix: the reaction detected the new resource instance at the
    // unchanged tabId and fired onActivate() on it. Without the fix the reaction
    // does not re-fire because the tracked tabId is unchanged.
    expect(spy).toHaveBeenCalledTimes(1);

    layout.dispose();
  });
});

describe('PaneLayoutStore: single-mount explicit target opens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    browserSessionStore.clear();
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

  it('moves an existing single-mount tab to an explicit target pane', () => {
    const layout = createLayout();

    layout.open('terminal', { terminalId: 'terminal-1' });
    const sourcePaneId = layout.activePaneId;
    const sourcePane = layout.focusedPane;
    const terminalTab = sourcePane.resolvedTabs[0]!;
    const terminalResource = terminalTab.resource;

    layout.open('browser', {});
    layout.splitRight();
    const targetPaneId = layout.activePaneId;
    const targetPane = layout.focusedPane;

    expect(targetPaneId).not.toBe(sourcePaneId);
    expect(sourcePane.resolvedTabs.some((tab) => tab.kind === 'terminal')).toBe(true);
    expect(targetPane.resolvedTabs.some((tab) => tab.kind === 'terminal')).toBe(false);

    layout.open('terminal', { terminalId: 'terminal-1' }, { target: { paneId: targetPaneId } });

    expect(sourcePane.resolvedTabs.some((tab) => tab.kind === 'terminal')).toBe(false);
    const movedTerminalTab = targetPane.resolvedTabs.find((tab) => tab.kind === 'terminal');
    expect(movedTerminalTab?.tabId).toBe(terminalTab.tabId);
    expect(movedTerminalTab?.resource).toBe(terminalResource);
    expect(targetPane.resolvedActiveTabId).toBe(terminalTab.tabId);

    layout.dispose();
  });
});

describe('PaneLayoutStore: runtime-only persistence projection', () => {
  it('omits a pure runtime pane without changing snapshot, sizes, or active history', () => {
    const { layout, onActiveTabChange, runtimeDispose } = createRuntimeProjectionLayout();
    layout.open('persistent-test', { id: 'source' });
    const sourcePaneId = layout.activePaneId;
    const baseline = structuredClone(layout.snapshot);
    onActiveTabChange.mockClear();

    layout.open('runtime-test', { id: 'side-chat:view-1' }, { target: 'right' });

    expect(layout.groups).toHaveLength(2);
    expect(layout.activePaneId).not.toBe(sourcePaneId);
    expect(layout.focusedPane.resolvedTabs).toEqual([
      expect.objectContaining({ kind: 'runtime-test', isActive: true }),
    ]);
    expect(layout.snapshot).toEqual(baseline);
    expect(onActiveTabChange).not.toHaveBeenCalled();

    layout.focusedPane.requestCloseTab(layout.focusedPane.resolvedActiveTabId!);

    expect(runtimeDispose).toHaveBeenCalledTimes(1);
    expect(layout.groups).toHaveLength(1);
    expect(layout.snapshot).toEqual(baseline);
    layout.dispose();
  });

  it('keeps the persisted active group when runtime focus enters a mixed workspace pane', () => {
    const { layout, onActiveTabChange } = createRuntimeProjectionLayout();
    layout.open('persistent-test', { id: 'source' });
    const sourcePaneId = layout.activePaneId;
    layout.open('persistent-test', { id: 'tool' }, { target: 'right' });
    const workspacePaneId = layout.activePaneId;
    layout.setActiveGroup(sourcePaneId);
    const baseline = structuredClone(layout.snapshot);
    onActiveTabChange.mockClear();

    layout.open(
      'runtime-test',
      { id: 'side-chat:view-2' },
      { target: { paneId: workspacePaneId } }
    );
    layout.setActiveGroup(workspacePaneId);

    expect(layout.activePaneId).toBe(workspacePaneId);
    expect(layout.focusedPane.resolvedTabs.find((tab) => tab.isActive)?.kind).toBe('runtime-test');
    expect(layout.snapshot).toEqual(baseline);
    expect(layout.snapshot.activeGroupId).toBe(sourcePaneId);
    expect(onActiveTabChange).not.toHaveBeenCalled();
    layout.dispose();
  });
});

describe('PaneLayoutStore: onActiveTabChange callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    browserSessionStore.clear();
  });

  it('calls onActiveTabChange with the focused pane active tab id when a tab opens', () => {
    const onChange = vi.fn();
    const layout = createLayout({ onActiveTabChange: onChange });

    layout.open('browser', {});
    const tabId = layout.focusedPane.resolvedActiveTabId;

    expect(onChange).toHaveBeenCalledWith(tabId);
    layout.dispose();
  });

  it('calls onActiveTabChange when the focused pane active tab changes', () => {
    const onChange = vi.fn();
    const layout = createLayout({ onActiveTabChange: onChange });

    layout.open('browser', {});
    layout.open('browser', {});
    const tabs = layout.focusedPane.resolvedTabs;

    onChange.mockClear();
    runInAction(() => layout.focusedPane.setActiveTab(tabs[0]!.tabId));

    expect(onChange).toHaveBeenCalledWith(tabs[0]!.tabId);
    layout.dispose();
  });

  it('does not call onActiveTabChange after dispose', () => {
    const onChange = vi.fn();
    const layout = createLayout({ onActiveTabChange: onChange });
    layout.open('browser', {});
    onChange.mockClear();

    layout.dispose();
    // Open on the already-disposed pane shouldn't trigger (reactions are stopped).
    expect(onChange).not.toHaveBeenCalled();
  });
});

// #7052 会话里的格子:拖页签到一格的边上 = 在那边分出一格;形状存下来、读回来还是那个形状。
describe('PaneLayoutStore: cells cut on an edge (#7052)', () => {
  const tabIdOf = (layout: ReturnType<typeof createRuntimeProjectionLayout>['layout'], id: string): string => {
    for (const { pane } of layout.groups) {
      for (const [tabId, entry] of pane.entries) if ((entry.state as { id?: string })?.id === id) return tabId;
    }
    throw new Error(`no tab ${id}`);
  };

  it('拖到一格的下边 = 上下叠两格,拖过去的那枚在下面那格', () => {
    const { layout } = createRuntimeProjectionLayout();
    layout.open('persistent-test', { id: 'a' });
    layout.open('persistent-test', { id: 'b' });
    const paneId = layout.activePaneId;
    const b = tabIdOf(layout, 'b');

    layout.handleDragEnd(b, paneEdgeDropId('bottom', paneId));

    expect(layout.groups).toHaveLength(2);
    expect(layout.layout).toMatchObject({ type: 'split', orientation: 'vertical', sizes: [50, 50] });
    const [top, bottom] = layout.groups;
    expect(top.paneId).toBe(paneId);
    expect(bottom.pane.resolvedTabs.map((t) => t.tabId)).toEqual([b]);
    layout.dispose();
  });

  it('一格只剩一枚页签时拖到自己的边上:没有可分的,什么都不变', () => {
    const { layout } = createRuntimeProjectionLayout();
    layout.open('persistent-test', { id: 'a' });
    const paneId = layout.activePaneId;
    const a = tabIdOf(layout, 'a');

    expect(layout.canSplit(paneId, a)).toBe(false);
    layout.handleDragEnd(a, paneEdgeDropId('right', paneId));

    expect(layout.groups).toHaveLength(1);
    expect(layout.layout).toEqual({ type: 'pane', paneId });
    layout.dispose();
  });

  it('页签右键「移到另一栏」:挪到后一格(没有就前一格);只有一格时没有这一项', () => {
    const { layout } = createRuntimeProjectionLayout();
    layout.open('persistent-test', { id: 'a' });
    layout.open('persistent-test', { id: 'b' });
    layout.open('persistent-test', { id: 'c' });
    const first = layout.activePaneId;
    const [a, b, c] = ['a', 'b', 'c'].map((id) => tabIdOf(layout, id));
    const paneOf = (paneId: string) => layout.groups.find((g) => g.paneId === paneId)!.pane;
    expect(paneOf(first).inSplitLayout).toBe(true);
    expect(paneOf(first).tabMoveToOtherPane(a)).toBeNull();

    layout.handleDragEnd(c, paneEdgeDropId('right', first));
    const second = layout.groups[1].paneId;
    paneOf(first).tabMoveToOtherPane(a)!();
    const tabs = () => layout.groups.map((g) => g.pane.resolvedTabs.map((t) => t.tabId));
    expect(tabs()).toEqual([[b], [c, a]]);

    // 最后一格里的往前挪。
    paneOf(second).tabMoveToOtherPane(c)!();
    expect(tabs()).toEqual([[b, c], [a]]);
    layout.dispose();
  });

  it('一格太窄(装不下两格 220px)就不往左右分,说「太窄」;高度够照样能上下分 (#7052 窄格子)', () => {
    const { layout } = createRuntimeProjectionLayout();
    layout.open('persistent-test', { id: 'a' });
    layout.open('persistent-test', { id: 'b' });
    const paneId = layout.activePaneId;
    const b = tabIdOf(layout, 'b');
    layout.setPaneSizer(() => ({ width: 400, height: 600 }));
    expect(layout.splitBlocked(paneId, b, 'right')).toBe('too-small');
    expect(layout.canSplit(paneId, b, 'bottom')).toBe(true);
    layout.handleDragEnd(b, paneEdgeDropId('right', paneId));
    expect(layout.groups).toHaveLength(1);
    // 量不到(还没画出来、测试里)= 不拦。
    layout.setPaneSizer(() => null);
    expect(layout.splitBlocked(paneId, b, 'right')).toBeNull();
    layout.dispose();
  });

  it('套着分的形状与份额存下来、读回来不变', () => {
    const { layout } = createRuntimeProjectionLayout();
    layout.open('persistent-test', { id: 'a' });
    layout.open('persistent-test', { id: 'b' });
    layout.open('persistent-test', { id: 'c' });
    const first = layout.activePaneId;
    layout.handleDragEnd(tabIdOf(layout, 'c'), paneEdgeDropId('right', first));
    const right = layout.groups[1].paneId;
    layout.handleDragEnd(tabIdOf(layout, 'b'), paneEdgeDropId('bottom', right));
    if (layout.layout.type !== 'split') throw new Error('expected a cut');
    layout.setSplitSizes(layout.layout.id, [70, 30]);
    const saved = structuredClone(layout.snapshot);

    const { layout: restored } = createRuntimeProjectionLayout();
    restored.restoreSnapshot(saved);

    const shape = (node: PaneLayoutNode): unknown =>
      node.type === 'pane' ? node.paneId : { o: node.orientation, sizes: node.sizes, children: node.children.map(shape) };
    expect(shape(restored.layout)).toEqual(shape(layout.layout));
    expect(shape(restored.layout)).toEqual({
      o: 'horizontal',
      sizes: [70, 30],
      children: [first, { o: 'vertical', sizes: [50, 50], children: [right, expect.any(String)] }],
    });
    layout.dispose();
    restored.dispose();
  });
});

describe('PaneLayoutStore: 一枚页签单独成窗 (#7052)', () => {
  function windowLayout() {
    const dispose = vi.fn();
    const provider = createTabProvider({
      kind: 'single-test',
      mount: 'single',
      resourceKey: (state: { id: string }) => state.id,
      initialize: () => ({ dispose }),
      dispose: () => {},
      TabBarItem: () => null,
      TabBarItemDragPreview: () => null,
      TabContent: () => null,
    });
    const registry = createTabRegistry([provider] as const);
    return { layout: new PaneLayoutStore(registry, testCtx), dispose };
  }
  const tabOf = (layout: PaneLayoutStore, id: string): string => {
    for (const { pane } of [...layout.groups, ...layout.windowPanes.values()]) {
      for (const [tabId, entry] of pane.entries) if ((entry.state as { id?: string })?.id === id) return tabId;
    }
    throw new Error(`no tab ${id}`);
  };
  const idsIn = (pane: { resolvedTabs: { tabId: string }[] }) => pane.resolvedTabs.map((tab) => tab.tabId);

  it('拿出来:这条会话的格子不变形,页签进窗那一格,资源原样(不重建、不销毁)', () => {
    const { layout, dispose } = windowLayout();
    layout.open('single-test', { id: 'a' });
    layout.open('single-test', { id: 'b' });
    const home = layout.activePaneId;
    const b = tabOf(layout, 'b');
    const resource = layout.focusedPane.resolvedTabs.find((tab) => tab.tabId === b)!.resource;

    const windowPaneId = layout.detachToWindow(b)!;

    expect(layout.groups.map((g) => g.paneId)).toEqual([home]);
    expect(idsIn(layout.focusedPane)).toEqual([tabOf(layout, 'a')]);
    const windowPane = layout.windowPanes.get(windowPaneId)!;
    expect(idsIn(windowPane.pane)).toEqual([b]);
    expect(windowPane.pane.resolvedTabs[0].resource).toBe(resource);
    expect(windowPane.pane.isVisible).toBe(true);
    expect(dispose).not.toHaveBeenCalled();
    layout.dispose();
  });

  it('放回:回到原来那一格;那一格没了就回焦点那一格', () => {
    const { layout, dispose } = windowLayout();
    layout.open('single-test', { id: 'a' });
    layout.open('single-test', { id: 'b' });
    const home = layout.activePaneId;
    const windowPaneId = layout.detachToWindow(tabOf(layout, 'b'))!;

    layout.returnFromWindow(windowPaneId);

    expect(layout.windowPanes.size).toBe(0);
    expect(idsIn(layout.groups.find((g) => g.paneId === home)!.pane)).toEqual([tabOf(layout, 'a'), tabOf(layout, 'b')]);
    expect(layout.focusedPane.resolvedActiveTabId).toBe(tabOf(layout, 'b'));
    expect(dispose).not.toHaveBeenCalled();
    layout.dispose();
  });

  it('存档时窗里那枚记回原来那一格(窗随主窗重载而关,读回来它在原处)', () => {
    const { layout } = windowLayout();
    layout.open('single-test', { id: 'a' });
    layout.open('single-test', { id: 'b' });
    layout.detachToWindow(tabOf(layout, 'b'));

    const saved = layout.snapshot;

    expect(saved.groups).toHaveLength(1);
    expect(saved.groups[0].tabManager.tabs.map((tab) => tab.tabId)).toEqual([tabOf(layout, 'a'), tabOf(layout, 'b')]);
    layout.dispose();
  });

  it('只开一份的那种正在窗里:再打开它 = 把那扇窗提到前面,❌ 这边再开一份', () => {
    const { layout } = windowLayout();
    const revealer = vi.fn();
    layout.setWindowRevealer(revealer);
    layout.open('single-test', { id: 'a' });
    layout.open('single-test', { id: 'b' });
    const windowPaneId = layout.detachToWindow(tabOf(layout, 'b'))!;

    layout.open('single-test', { id: 'b' });

    expect(revealer).toHaveBeenCalledWith(windowPaneId);
    expect(idsIn(layout.focusedPane)).toEqual([tabOf(layout, 'a')]);
    layout.dispose();
  });

  it('窗里那枚被关掉:那一格跟着收掉', () => {
    const { layout, dispose } = windowLayout();
    layout.open('single-test', { id: 'a' });
    layout.open('single-test', { id: 'b' });
    const windowPaneId = layout.detachToWindow(tabOf(layout, 'b'))!;

    layout.windowPanes.get(windowPaneId)!.pane.closeTab(tabOf(layout, 'b'));

    expect(layout.windowPanes.has(windowPaneId)).toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
    layout.dispose();
  });
});
