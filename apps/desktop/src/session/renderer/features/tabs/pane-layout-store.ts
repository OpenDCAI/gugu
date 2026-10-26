import { action, computed, makeObservable, observable, reaction } from 'mobx';
import { MIN_PANE_HEIGHT_PX, MIN_PANE_WIDTH_PX, PaneStore } from '@renderer/features/tabs/pane-store';
import type { TabGroupsSnapshot, TabManagerSnapshot } from '@shared/view-state';
import type { OpenTarget, TabViewContext } from './core/tab-provider';
import type {
  AnyTabProvider,
  KindOf,
  OpenArgsOf,
  TabOpenOptions,
  TabRegistry,
} from './core/tab-provider-registry';
import type { TabPersistenceAdapter } from './persistence';
import {
  equalizeSplit,
  evenSizes,
  insertBeside,
  layoutFor,
  neighbourInOrder,
  paneLeaf,
  paneOrder,
  removePane,
  setSplitSizes,
  snapshotOf,
  type PaneEdge,
  type PaneLayoutNode,
} from './pane-layout-tree';

const MAX_PANE_COUNT = 8;
// 一格最窄多宽、最矮多高:定义挪到 pane-store(并排的两页也守它),这里照旧导出。
export { MIN_PANE_HEIGHT_PX, MIN_PANE_WIDTH_PX };

/** 「开在对话旁边」认的那一枚对话:它在哪一格、是哪一枚(spec session-page「并排」)。 */
export type PairAnchor = { paneId: string; tabId: string };

/** 为什么分不出来:分满了 / 这一格只剩这一枚 / 这一格太窄(或太矮)。 */
export type SplitBlock = 'full' | 'only-tab' | 'too-small';

/**
 * 以前分好几格的存档合成一格(一条会话一条页签条,spec session-page「并排」):页签按格子的先后接起来,
 * 焦点那一格屏上那枚仍拿着焦点;正好两格且都没有并排时,两格各自屏上那页并排着回来(左右 / 上下照原样,份额照原样)。
 */
export function mergeIntoOneStrip(snapshot: TabGroupsSnapshot): TabGroupsSnapshot {
  if (snapshot.groups.length <= 1) return snapshot;
  const layout = layoutFor(
    snapshot.groups.map((g) => g.groupId),
    snapshot.layout,
    snapshot.paneSizes
  );
  const order = paneOrder(layout);
  const groups = [...snapshot.groups].sort((a, b) => order.indexOf(a.groupId) - order.indexOf(b.groupId));
  const focused = groups.find((g) => g.groupId === snapshot.activeGroupId) ?? groups[0];
  const shownOf = (g: (typeof groups)[number]) =>
    g.tabManager.tabs.some((t) => t.tabId === g.tabManager.activeTabId) ? g.tabManager.activeTabId : g.tabManager.tabs[0]?.tabId;
  const merged: TabManagerSnapshot = {
    tabs: groups.flatMap((g) => g.tabManager.tabs),
    activeTabId: shownOf(focused),
  };
  const existingPair = groups.find((g) => g.tabManager.pair)?.tabManager.pair;
  const declined = groups.some((g) => g.tabManager.splitDeclined);
  if (existingPair) {
    merged.pair = existingPair;
  } else if (groups.length === 2 && layout.type === 'split') {
    const first = shownOf(groups[0]);
    const second = shownOf(groups[1]);
    if (first && second) {
      const vertical = layout.orientation === 'vertical';
      merged.pair = {
        anchorTabId: first,
        sideTabId: second,
        ...(vertical ? { sideAt: 'bottom' as const } : {}),
      };
    }
  }
  if (declined) merged.splitDeclined = true;
  return {
    groups: [{ groupId: focused.groupId, tabManager: merged }],
    activeGroupId: focused.groupId,
    paneSizes: [100],
    layout: snapshotOf(paneLeaf(focused.groupId)),
  };
}

export interface Pane<R extends TabRegistry = TabRegistry> {
  paneId: string;
  pane: PaneStore<R>;
}

/** 一枚页签单独成窗时装它的那一格:不在布局里(这条会话的格子照旧),记着它是从哪一格拿出来的。 */
export interface WindowPane<R extends TabRegistry = TabRegistry> extends Pane<R> {
  originPaneId: string;
}

/** A drop on a pane's edge (#7052): `pane-edge-<edge>-<paneId>` — the tab goes into a new pane on that side. */
export const PANE_EDGE_DROP_PREFIX = 'pane-edge-';
export const paneEdgeDropId = (edge: PaneEdge, paneId: string) => `${PANE_EDGE_DROP_PREFIX}${edge}-${paneId}`;
const parseEdgeDrop = (overId: string): { edge: PaneEdge; paneId: string } | null => {
  const match = /^pane-edge-(left|right|top|bottom)-(.+)$/.exec(overId);
  return match ? { edge: match[1] as PaneEdge, paneId: match[2] } : null;
};

/**
 * Owns the per-pane PaneStore instances, how they are cut (`layout`: side by side or stacked, nested), the active pane
 * and the shares. `groups` lists the panes in layout order (top-left to bottom-right).
 *
 * Cross-pane concerns handled here:
 * - mount:'single' cardinality — at most one tab per dedupKey across ALL panes
 * - Tab move (detachTab + adoptEntry) — resource survives unchanged, no lifecycle calls
 * - target routing — 'active', 'left', 'right', { paneId }
 * - splitting a pane on any edge (spec session-page「一屏几块」:拖页签到格子边上 = 再分格)
 */
export class PaneLayoutStore<R extends TabRegistry = TabRegistry> {
  readonly groups: Pane<R>[] = [];
  /**
   * 单独成窗的页签各自那一格(spec session-page「一屏几块」:拖到窗口外 = 单独成窗,一枚页签也行),按格子 id。
   * 不在 `groups` / `layout` 里:这条会话在屏上的格子不因它变形;页签的资源(终端进程等)原样跟过去。
   * 存档时它们记回原来那一格 —— 窗随主窗重载而关,读回来它就在原处。
   */
  // 记成不带类型参数的那种:带上它,这个存储对类型参数就成了不变的(会话页按宽的那种传它)。
  private readonly _windowPanes = observable.map<string, WindowPane>({}, { deep: false });

  get windowPanes(): ReadonlyMap<string, WindowPane> {
    return this._windowPanes;
  }
  activePaneId: string;
  /** How the panes are cut. Replaced whole on every change (pane-layout-tree.ts is pure). */
  layout: PaneLayoutNode;

  /**
   * True when the owning task view is the currently active route.
   * Stored as an observable.box so it is reactive before makeObservable runs,
   * allowing the per-pane onActivate reactions (fireImmediately) to track it
   * correctly during pane construction.
   */
  private readonly _isViewActiveBox = observable.box(false);

  /** Expose as a plain getter for external consumers (e.g. tests, VM). */
  get isViewActive(): boolean {
    return this._isViewActiveBox.get();
  }

  private readonly _registry: R;
  private readonly _ctx: TabViewContext;
  private readonly _persistor: TabPersistenceAdapter | undefined;
  private _persistDisposer: (() => void) | null = null;
  private readonly _autoCloseDisposers = new Map<string, () => void>();
  private readonly _onActiveTabChange: ((tabId: string | undefined) => void) | undefined;
  private readonly _singleStrip: boolean;
  private readonly _activeTabDisposer: () => void;
  private _lastPersistentActivePaneId: string;
  private readonly _lastPersistentActiveTabIds = new Map<string, string | undefined>();

  constructor(
    registry: R,
    ctx: TabViewContext,
    persistor?: TabPersistenceAdapter,
    opts?: {
      onActiveTabChange?: (tabId: string | undefined) => void;
      /**
       * 一条页签条(会话页,spec session-page「并排」):分屏只有并排一种,拖到边上 = 并排;读回以前分好几格的存档时
       * 合成一格 —— 两格的话,两格各自屏上那页并排着回来。
       */
      singleStrip?: boolean;
    }
  ) {
    this._registry = registry;
    this._ctx = ctx;
    this._persistor = persistor;
    this._onActiveTabChange = opts?.onActiveTabChange;
    this._singleStrip = opts?.singleStrip ?? false;

    const initial = this._createPane();
    this.groups.push(initial);
    this.activePaneId = initial.paneId;
    this._lastPersistentActivePaneId = initial.paneId;
    this.layout = paneLeaf(initial.paneId);

    makeObservable(this, {
      groups: observable,
      activePaneId: observable,
      layout: observable.ref,
      paneSizes: computed,
      isViewActive: computed,
      focusedPane: computed,
      splitRight: action,
      splitDown: action,
      splitPane: action,
      closePane: action,
      moveTab: action,
      handleDragEnd: action,
      setActiveGroup: action,
      setViewActive: action,
      setPaneSizes: action,
      setSplitSizes: action,
      equalizeSplit: action,
      restoreSnapshot: action,
      open: action,
      showBeside: action,
      detachToWindow: action,
      returnFromWindow: action,
      // 会话页挂上来的时候页签右键可能已经画好了(刷新后页签先于会话页的挂接出现):挂上 = 菜单跟着重算。
      windowOpener: observable.ref,
      setWindowOpener: action,
    });

    // Runtime-only tabs may take live focus, but must not replace persisted navigation state.
    this._activeTabDisposer = reaction(
      () => {
        const pane = this.focusedPane;
        const tabId = pane.resolvedActiveTabId;
        return {
          paneId: this.activePaneId,
          tabId,
          isPersistent: this._isPersistentTab(pane, tabId),
        };
      },
      ({ paneId, tabId, isPersistent }) => {
        if (!isPersistent) return;
        this._lastPersistentActivePaneId = paneId;
        this._lastPersistentActiveTabIds.set(paneId, tabId);
        this._onActiveTabChange?.(tabId);
      },
      { fireImmediately: true }
    );
  }

  setViewActive(active: boolean): void {
    this._isViewActiveBox.set(active);
  }

  get focusedPane(): PaneStore<R> {
    return this.groups.find((g) => g.paneId === this.activePaneId)?.pane ?? this.groups[0].pane;
  }

  /** The focused pane's tab in front goes into a new pane on its right (⌘\\, the tab menu's 「向右分」). */
  splitRight(): void {
    this.splitPane(this.activePaneId, 'right');
  }

  /** The same, below it (the tab menu's 「向下分」). */
  splitDown(): void {
    this.splitPane(this.activePaneId, 'bottom');
  }

  /**
   * 哪一枚能单独成窗、怎么开:会话页那一侧知道(会话自己那枚 = 整个会话,App 那枚 = 这个 App),由它挂上来;
   * 没挂(测试、新建任务页)= 哪一枚都不能。
   */
  windowOpener: ((tabId: string) => (() => void) | null) | null = null;

  setWindowOpener(opener: ((tabId: string) => (() => void) | null) | null): void {
    this.windowOpener = opener;
  }

  /** 要打开的那枚(只开一份的那种)正在某扇窗里:把那扇窗提到前面。会话页那一侧挂上来。 */
  windowRevealer: ((windowPaneId: string) => void) | null = null;

  setWindowRevealer(revealer: ((windowPaneId: string) => void) | null): void {
    this.windowRevealer = revealer;
  }

  /**
   * 「开在对话旁边」(`beside`)认哪一枚是对话:会话页那一侧知道(这条会话自己的对话页签),由它挂上来;
   * 没挂(测试、新建任务页)或这会儿没有对话 = 照常开。
   */
  pairAnchor: (() => PairAnchor | null) | null = null;

  setPairAnchor(finder: (() => PairAnchor | null) | null): void {
    this.pairAnchor = finder;
  }

  /**
   * 把这条会话里已经开着的 `tabId` 请到对话右边(spec session-page「并排」:同一页已经开着 = 请到右边,❌ 新开一枚)。
   * 它在用户自己分出的另一格里 = 留在原处,只在那一格亮到前面(不抢焦点那一格);在单独的窗里 = 把窗提到前面。
   * `reveal`:人点开的 = 把并排亮到屏上;agent 打开的(false)= 用户正看着别的就不切走,一对只在页签条上连好。
   * 返回认没认出来这一枚;没有对话可并排 = false,调用方照它原来的办法切过去。
   */
  showBeside(tabId: string, opts?: { reveal?: boolean }): boolean {
    const anchor = this.pairAnchor?.() ?? null;
    if (!anchor) return false;
    for (const windowPane of this.windowPanes.values()) {
      if (!windowPane.pane.entries.has(tabId)) continue;
      this.windowRevealer?.(windowPane.paneId);
      return true;
    }
    const group = this.groups.find((g) => g.pane.entries.has(tabId));
    if (!group) return false;
    if (group.paneId !== anchor.paneId) {
      group.pane.setActiveTab(tabId);
      return true;
    }
    if (group.pane.splitDeclined) {
      // 用户拆开过:不再自动并排,人点开的照常亮到前面,agent 请的不切走。
      if (opts?.reveal) {
        this.setActiveGroup(group.paneId);
        group.pane.setActiveTab(tabId);
      }
      return true;
    }
    group.pane.pairWith(anchor.tabId, tabId);
    if (opts?.reveal) {
      this.setActiveGroup(group.paneId);
      group.pane.setActiveTab(tabId);
    }
    return true;
  }

  /**
   * 把 `tabId` 从它那一格拿出来,放进一格只属于一扇窗的格子(资源不重建)。返回那一格的 id;找不到这枚 = null。
   * 原来那一格因此空了就照常收掉(放回时回到焦点那一格)。
   */
  detachToWindow(tabId: string): string | null {
    const source = this.groups.find((g) => g.pane.entries.has(tabId));
    if (!source) return null;
    const detached = source.pane.detachTab(tabId);
    if (!detached) return null;
    const paneId = crypto.randomUUID();
    const pane = new PaneStore<R>(this._registry, this._ctx, {
      layoutOpener: (kind, args, config) => this.open(kind, args, config),
      // 窗开着就是看得见的,和这条会话此刻是不是正看着的那页无关。
      isViewActive: () => true,
    });
    pane.adoptEntry(detached.entry, detached.resource, { activate: true });
    this._windowPanes.set(paneId, { paneId, pane, originPaneId: source.paneId });
    // 窗里那枚被 × 关掉了:这一格跟着收掉(窗也就跟着关)。
    this._autoCloseDisposers.set(
      paneId,
      reaction(
        () => pane.tabOrder.length,
        (length) => {
          if (length === 0) this._dropWindowPane(paneId);
        }
      )
    );
    return paneId;
  }

  /** 窗里的页签回到原来那一格(那一格没了 = 焦点那一格)。`activate`:「放回咕咕」带到前面;关掉窗只是回去,不抢焦点。 */
  returnFromWindow(windowPaneId: string, opts?: { activate?: boolean }): void {
    const windowPane = this.windowPanes.get(windowPaneId);
    if (!windowPane) return;
    const activate = opts?.activate ?? true;
    const target = this.groups.find((g) => g.paneId === windowPane.originPaneId) ?? this.groups.find((g) => g.paneId === this.activePaneId) ?? this.groups[0];
    for (const tabId of [...windowPane.pane.tabOrder]) {
      const detached = windowPane.pane.detachTab(tabId);
      if (detached) target.pane.adoptEntry(detached.entry, detached.resource, { activate });
    }
    if (activate) this.activePaneId = target.paneId;
    this._dropWindowPane(windowPaneId);
  }

  private _dropWindowPane(windowPaneId: string): void {
    const windowPane = this.windowPanes.get(windowPaneId);
    if (!windowPane) return;
    this._autoCloseDisposers.get(windowPaneId)?.();
    this._autoCloseDisposers.delete(windowPaneId);
    this._windowPanes.delete(windowPaneId);
    windowPane.pane.dispose();
  }

  /**
   * Whether `splitPane` would do anything: room for one more pane, a tab to move that leaves its pane not empty,
   * and — on that edge — room for two panes where this one is (`edge` omitted = either way would do).
   */
  canSplit(paneId: string, tabId?: string, edge?: PaneEdge): boolean {
    return this.splitBlocked(paneId, tabId, edge) === null;
  }

  /** Why `splitPane` would not split (null = it would). */
  splitBlocked(paneId: string, tabId?: string, edge?: PaneEdge): SplitBlock | null {
    if (this.groups.length >= MAX_PANE_COUNT) return 'full';
    const target = this.groups.find((g) => g.paneId === paneId);
    if (!target) return 'full';
    const moving = tabId ?? target.pane.resolvedActiveTabId;
    if (!moving) return 'only-tab';
    const source = this.groups.find((g) => g.pane.entries.has(moving));
    if (!source) return 'full';
    // Taking a pane's only tab to its own edge would leave it empty: there is nothing to split.
    if (source.paneId === paneId && source.pane.tabOrder.length < 2) return 'only-tab';
    return this.roomToSplit(paneId, edge) ? null : 'too-small';
  }

  /** 这一格放得下两格吗(量不到 = 不拦:测试、还没画出来)。 */
  private roomToSplit(paneId: string, edge?: PaneEdge): boolean {
    const size = this.paneSizer?.(paneId);
    if (!size) return true;
    const wide = size.width >= MIN_PANE_WIDTH_PX * 2 + 1;
    const tall = size.height >= MIN_PANE_HEIGHT_PX * 2 + 1;
    if (!edge) return wide || tall;
    return edge === 'left' || edge === 'right' ? wide : tall;
  }

  /** 一格此刻画出来多大:会话页那一侧量了挂上来;没挂 = 不知道。 */
  paneSizer: ((paneId: string) => { width: number; height: number } | null) | null = null;

  setPaneSizer(sizer: ((paneId: string) => { width: number; height: number } | null) | null): void {
    this.paneSizer = sizer;
  }

  /**
   * A new pane on that edge of `paneId`, holding `tabId` (default: that pane's tab in front) taken from wherever it is.
   * A pane left with no tab closes (its auto-close). Returns whether it split.
   */
  splitPane(paneId: string, edge: PaneEdge, tabId?: string): boolean {
    if (!this.canSplit(paneId, tabId, edge)) return false;
    const target = this.groups.find((g) => g.paneId === paneId)!;
    const moving = tabId ?? target.pane.resolvedActiveTabId!;
    const source = this.groups.find((g) => g.pane.entries.has(moving))!;
    const fresh = this._createPane();
    this.groups.push(fresh);
    this.layout = insertBeside(this.layout, paneId, fresh.paneId, edge);
    this._syncGroupOrder();
    this.moveTab(moving, source.paneId, fresh.paneId);
    return true;
  }

  closePane(paneId: string): void {
    if (this.groups.length <= 1) return;

    const index = this.groups.findIndex((g) => g.paneId === paneId);
    if (index === -1) return;

    const closing = this.groups[index];
    // Focus goes to the pane that takes its place in the walk order: the next one, or the previous at the end.
    const adjacentId =
      neighbourInOrder(this.layout, paneId, 'after') ?? neighbourInOrder(this.layout, paneId, 'before');

    this._autoCloseDisposers.get(paneId)?.();
    this._autoCloseDisposers.delete(paneId);
    this._lastPersistentActiveTabIds.delete(paneId);

    closing.pane.dispose();

    this.groups.splice(index, 1);
    this.layout = removePane(this.layout, paneId);
    this._syncGroupOrder();

    if (this.activePaneId === paneId && adjacentId) {
      this.activePaneId = adjacentId;
    }
  }

  /**
   * Moves a tab between panes by detaching it (no dispose) and adopting it
   * in the target pane (no initialize). The resource instance is unchanged.
   */
  /**
   * `activate: false` moves a tab without bringing it forward: the target pane keeps showing what it showed, and the
   * focused pane stays where it is (the pane policy tidying a tab nobody was looking at). A drag brings it forward.
   */
  moveTab(tabId: string, fromPaneId: string, toPaneId: string, insertBeforeTabId?: string, opts?: { activate?: boolean }): void {
    if (fromPaneId === toPaneId) return;
    const fromGroup = this.groups.find((g) => g.paneId === fromPaneId);
    const toGroup = this.groups.find((g) => g.paneId === toPaneId);
    if (!fromGroup || !toGroup) return;

    const activate = opts?.activate ?? true;
    const detached = fromGroup.pane.detachTab(tabId);
    if (!detached) return;

    toGroup.pane.adoptEntry(detached.entry, detached.resource, {
      insertBeforeTabId,
      activate,
    });
    if (activate) this.activePaneId = toPaneId;
  }

  handleDragEnd(draggedTabId: string, overId: string): void {
    const fromGroup = this.groups.find((g) => g.pane.entries.has(draggedTabId));
    if (!fromGroup) return;

    const edgeDrop = parseEdgeDrop(overId);
    if (edgeDrop) {
      // 拖到内容区的哪条边 = 在那一边并排(spec session-page「并排」);一条页签条的会话 ❌ 再分出一格。
      if (this._singleStrip) {
        const target = this.groups.find((g) => g.paneId === edgeDrop.paneId);
        if (!target) return;
        if (target.paneId !== fromGroup.paneId) {
          this.moveTab(draggedTabId, fromGroup.paneId, target.paneId, undefined, { activate: false });
        }
        this.activePaneId = target.paneId;
        target.pane.splitBeside(draggedTabId, edgeDrop.edge);
        return;
      }
      this.splitPane(edgeDrop.paneId, edgeDrop.edge, draggedTabId);
      return;
    }

    let toPaneId: string | undefined;
    if (overId.startsWith('pane-drop-') || overId.startsWith('pane-content-')) {
      toPaneId = overId.startsWith('pane-drop-')
        ? overId.slice('pane-drop-'.length)
        : overId.slice('pane-content-'.length);
    } else {
      toPaneId = this.groups.find((g) => g.pane.entries.has(overId))?.paneId;
    }

    if (!toPaneId || toPaneId === fromGroup.paneId) {
      const fromTabIds = fromGroup.pane.resolvedTabs.map((t) => t.tabId);
      const fromIdx = fromTabIds.indexOf(draggedTabId);
      if (fromIdx === -1) return;
      const toIdx =
        overId.startsWith('pane-drop-') || overId.startsWith('pane-content-')
          ? fromTabIds.length - 1
          : fromTabIds.indexOf(overId);
      if (toIdx !== -1) fromGroup.pane.reorderTabs(fromIdx, toIdx);
      return;
    }

    const insertBeforeTabId =
      overId.startsWith('pane-drop-') || overId.startsWith('pane-content-') ? undefined : overId;
    this.moveTab(draggedTabId, fromGroup.paneId, toPaneId, insertBeforeTabId);
  }

  setActiveGroup(paneId: string): void {
    if (this.groups.some((g) => g.paneId === paneId)) {
      this.activePaneId = paneId;
    }
  }

  /** The shares of the outermost cut (one entry per pane while the panes only stand side by side). */
  get paneSizes(): number[] {
    return this.layout.type === 'split' ? this.layout.sizes : [100];
  }

  /** Legacy: the outermost cut's shares, when it has that many children. */
  setPaneSizes(sizes: number[]): void {
    if (this.layout.type === 'split') this.setSplitSizes(this.layout.id, sizes);
  }

  /** A divider dragged: that cut's new shares (kept, so the layout comes back as it was left). */
  setSplitSizes(splitId: string, sizes: readonly number[]): void {
    this.layout = setSplitSizes(this.layout, splitId, sizes);
  }

  /** A divider double-clicked: that cut back to even shares. */
  equalizeSplit(splitId: string): void {
    this.layout = equalizeSplit(this.layout, splitId);
  }

  /**
   * The single public open entry point.
   *
   * `kind` selects the provider; `args` are the domain open-args (the "searchParams");
   * `config` carries engine routing flags:
   *   preview      – open as a preview tab (replaced on next preview open)
   *   overrideState – when single-mount hit, replace the existing tab's state
   *   target       – which pane to open into ('active' | 'left' | 'right' | {paneId})
   *
   * For single-mount providers, scans all panes for an existing dedupKey match
   * and focuses it (with optional state override) instead of opening a new tab.
   * When callers provide an explicit pane target, the existing tab is moved
   * there so drag/drop placement intent is preserved without reinitializing
   * the resource.
   *
   * For multi providers, routes directly to the target pane.
   */
  open<K extends KindOf<R>>(kind: K, args: OpenArgsOf<R, K>, config?: TabOpenOptions): void;
  /** Untyped overload used internally (handles, fallback from unknown registries). */
  open(kind: string, args: Record<string, unknown>, config?: TabOpenOptions): void;
  open(kind: string, args: Record<string, unknown>, config?: TabOpenOptions): void {
    const previewFlag = !!config?.preview;
    const overrideStateFlag = !!config?.overrideState;
    const resolvedTarget: OpenTarget = config?.target ?? 'active';
    const explicitTargetPaneId =
      typeof resolvedTarget === 'object' && 'paneId' in resolvedTarget
        ? resolvedTarget.paneId
        : undefined;

    if (!this._registry.has(kind)) {
      console.warn(`[PaneLayoutStore] Unknown tab kind: ${kind}`);
      return;
    }
    const def = this._registry.get(kind) as AnyTabProvider;

    // Compute initial state via onBeforeOpen or fall back to args directly.
    const initialState: unknown = def.onBeforeOpen
      ? def.onBeforeOpen(args as never, this._ctx)
      : (args as unknown);
    if (initialState === null) return; // aborted by onBeforeOpen

    // 开在对话旁边(spec session-page「并排」):对话那一格、那一枚。没有对话 = 照常开;
    // 用户拆开过 = 不再自动并排,也照常开 —— agent 打开的不切走,人点开的切过去(和普通浏览器一样)。
    const foundAnchor = config?.beside ? (this.pairAnchor?.() ?? null) : null;
    const declinedGroup = foundAnchor
      ? this.groups.find((g) => g.paneId === foundAnchor.paneId && g.pane.splitDeclined)
      : undefined;
    const anchor = declinedGroup ? null : foundAnchor;
    const anchorGroup = anchor ? this.groups.find((g) => g.paneId === anchor.paneId) : undefined;

    // Single-mount: check ALL panes for an existing resourceKey match.
    if ((def.mount ?? 'multi') === 'single') {
      const key = def.resourceKey(initialState as never);
      // 它在单独的窗里:那扇窗提到前面,❌ 在这边再开一份。
      for (const windowPane of this.windowPanes.values()) {
        const existing = windowPane.pane.findSingleMountEntry(kind, key);
        if (!existing) continue;
        if (!previewFlag) existing.isPreview = false;
        if (overrideStateFlag) existing.state = initialState;
        if (config?.returnTo) existing.returnTo = config.returnTo;
        if (anchorGroup || (config?.activate ?? true)) this.windowRevealer?.(windowPane.paneId);
        return;
      }
      for (const g of this.groups) {
        const existing = g.pane.findSingleMountEntry(kind, key);
        if (existing && config?.returnTo) existing.returnTo = config.returnTo;
        if (existing && anchor && anchorGroup) {
          if (!previewFlag) existing.isPreview = false;
          if (overrideStateFlag) existing.state = initialState;
          this.showBeside(existing.tabId, { reveal: config?.activate ?? true });
          return;
        }
        if (existing && declinedGroup) {
          // 拆开过:已经开着的照常亮到前面(人点的),agent 请的不切走。
          if (!previewFlag) existing.isPreview = false;
          if (overrideStateFlag) existing.state = initialState;
          if (config?.activate ?? true) {
            this.setActiveGroup(g.paneId);
            g.pane.setActiveTab(existing.tabId);
          }
          return;
        }
        if (existing) {
          const explicitTargetGroup = explicitTargetPaneId
            ? this.groups.find((group) => group.paneId === explicitTargetPaneId)
            : undefined;
          if (explicitTargetGroup && explicitTargetGroup.paneId !== g.paneId) {
            if (!previewFlag) existing.isPreview = false;
            if (overrideStateFlag) existing.state = initialState;
            this.moveTab(existing.tabId, g.paneId, explicitTargetGroup.paneId);
            return;
          }

          if (!previewFlag) existing.isPreview = false;
          if (overrideStateFlag) existing.state = initialState;
          if (config?.activate ?? true) {
            this.setActiveGroup(g.paneId);
            g.pane.setActiveTab(existing.tabId);
          }
          return;
        }
      }
    }

    if (anchor && anchorGroup) {
      // 开在对话那一格、先不切过去,再和对话连成一对:用户正看着对话就看到并排,正看着别的就不动(pairWith)。
      const tabId = anchorGroup.pane.openWithState(kind, initialState, {
        isPreview: previewFlag,
        overrideState: overrideStateFlag,
        activate: false,
        returnTo: config?.returnTo,
      });
      if (!tabId) return;
      anchorGroup.pane.pairWith(anchor.tabId, tabId);
      // 人点开的:并排亮到屏上、焦点在那一页;agent 打开的(activate: false)到此为止,不切走。
      if (config?.activate ?? true) {
        this.setActiveGroup(anchor.paneId);
        anchorGroup.pane.setActiveTab(tabId);
      }
      return;
    }

    // Route to the target pane. 拆开过的会话落在对话那一格(同并排时一样,❌ 落进用户正点着的别的格)。
    const targetPane = declinedGroup?.pane ?? this._resolveTargetPane(resolvedTarget);
    targetPane.openWithState(kind, initialState, {
      isPreview: previewFlag,
      overrideState: overrideStateFlag,
      returnTo: config?.returnTo,
      // 要开在对话旁边、却没有对话可并排 = 照常开,照常就是切过去(❌ 开成一枚屏上看不见的后台页签);
      // 用户拆开过就按调用方说的(agent 打开的不切走)。
      activate: config?.beside && !declinedGroup ? true : (config?.activate ?? true),
    });
  }

  /** Returns true if any pane has a tab of the given kind + resourceKey open. */
  isOpen(kind: string, key: string): boolean {
    return this.groups.some((g) => g.pane.hasOpenKey(kind, key));
  }

  /** Returns true if the active tab in the focused pane matches kind + resourceKey. */
  isActiveInFocusedPane(kind: string, key: string): boolean {
    return this.focusedPane.activeMatches(kind, key);
  }

  /** Returns true if any pane's active tab matches kind + resourceKey. */
  isActiveInAnyPane(kind: string, key: string): boolean {
    return this.groups.some((g) => g.pane.activeMatches(kind, key));
  }

  get snapshot(): TabGroupsSnapshot {
    const projected = this.groups.map((group, index) => ({
      group,
      index,
      tabManager: this._projectPaneSnapshot(group),
    }));
    // 单独成窗的页签记回原来那一格(那一格没了就记在第一格):窗随主窗重载而关,读回来它在原处。
    for (const windowPane of this.windowPanes.values()) {
      const tabs = windowPane.pane.snapshot.tabs;
      if (tabs.length === 0 || projected.length === 0) continue;
      const home = projected.find(({ group }) => group.paneId === windowPane.originPaneId) ?? projected[0];
      home.tabManager = { ...home.tabManager, tabs: [...home.tabManager.tabs, ...tabs] };
    }
    let retained = projected.filter(
      ({ group, tabManager }) => tabManager.tabs.length > 0 || group.pane.tabOrder.length === 0
    );
    if (retained.length === 0 && projected[0]) retained = [projected[0]];

    const activeGroupId = retained.some(
      ({ group }) => group.paneId === this._lastPersistentActivePaneId
    )
      ? this._lastPersistentActivePaneId
      : (retained[0]?.group.paneId ?? this.activePaneId);

    const retainedIds = retained.map(({ group }) => group.paneId);
    const layout = layoutFor(retainedIds, snapshotOf(this.layout));
    return {
      groups: retained.map(({ group, tabManager }) => ({
        groupId: group.paneId,
        tabManager,
      })),
      activeGroupId,
      // Read by builds from before panes could stack: the outermost cut's shares when it is one flat row, else even.
      paneSizes:
        layout.type === 'split' && layout.orientation === 'horizontal' && layout.children.length === retainedIds.length
          ? [...layout.sizes]
          : evenSizes(retainedIds.length),
      layout: snapshotOf(layout),
    };
  }

  restoreSnapshot(input: TabGroupsSnapshot): void {
    const snapshot = this._singleStrip ? mergeIntoOneStrip(input) : input;
    for (let i = 1; i < this.groups.length; i++) {
      this.groups[i].pane.dispose();
    }
    this.groups.splice(0, this.groups.length);

    for (const g of snapshot.groups) {
      const pane = this._createPaneStore(g.groupId);
      pane.restoreSnapshot(g.tabManager);
      this.groups.push({ paneId: g.groupId, pane });
      this._registerAutoClose(g.groupId, pane);
    }

    this.activePaneId = snapshot.groups.some((g) => g.groupId === snapshot.activeGroupId)
      ? snapshot.activeGroupId
      : (snapshot.groups[0]?.groupId ?? this.activePaneId);
    this._lastPersistentActivePaneId = this.activePaneId;
    this._lastPersistentActiveTabIds.clear();
    for (const group of snapshot.groups) {
      this._lastPersistentActiveTabIds.set(group.groupId, group.tabManager.activeTabId);
    }

    this.layout = layoutFor(
      snapshot.groups.map((g) => g.groupId),
      snapshot.layout,
      snapshot.paneSizes
    );
    this._syncGroupOrder();
  }

  hydrate(fallback?: unknown): boolean {
    const saved = this._persistor?.load(fallback);
    if (saved) {
      this.restoreSnapshot(saved);
      return true;
    }
    return false;
  }

  startPersistence(): void {
    if (!this._persistor) return;
    this._persistDisposer?.();
    this._persistDisposer = this._persistor.start(() => this.snapshot);
  }

  stopPersistence(): void {
    this._persistDisposer?.();
    this._persistDisposer = null;
  }

  dispose(): void {
    this._activeTabDisposer();
    this.stopPersistence();
    for (const disposer of this._autoCloseDisposers.values()) {
      disposer();
    }
    this._autoCloseDisposers.clear();
    for (const { pane } of this.groups) {
      pane.dispose();
    }
    for (const { pane } of this.windowPanes.values()) {
      pane.dispose();
    }
    this._windowPanes.clear();
  }

  /**
   * Resolve a target to an existing or newly-split PaneStore.
   * 'active' => focused pane
   * 'right'  => pane immediately after focused (split if needed and below max)
   * 'left'   => pane immediately before focused (split if needed and below max)
   * { paneId } => specific pane (falls back to focused if not found)
   */
  private _resolveTargetPane(target: OpenTarget): PaneStore<R> {
    if (target === 'active') return this.focusedPane;

    if (typeof target === 'object' && 'paneId' in target) {
      return this.groups.find((g) => g.paneId === target.paneId)?.pane ?? this.focusedPane;
    }

    // 'left' or 'right' — the neighbouring pane in walk order, splitting if there is none.
    const focusedId = this.groups.some((g) => g.paneId === this.activePaneId)
      ? this.activePaneId
      : this.groups[0].paneId;
    const adjacentId = neighbourInOrder(this.layout, focusedId, target === 'right' ? 'after' : 'before');
    const existing = adjacentId ? this.groups.find((g) => g.paneId === adjacentId) : undefined;
    if (existing) {
      this.activePaneId = existing.paneId;
      return existing.pane;
    }

    // Need to split.
    if (this.groups.length >= MAX_PANE_COUNT) return this.focusedPane;
    const newGroup = this._createPane();
    this.groups.push(newGroup);
    this.layout = insertBeside(this.layout, focusedId, newGroup.paneId, target === 'right' ? 'right' : 'left');
    this._syncGroupOrder();
    this.activePaneId = newGroup.paneId;
    return newGroup.pane;
  }

  private _createPane(): Pane<R> {
    const paneId = crypto.randomUUID();
    const pane = this._createPaneStore(paneId);
    this._registerAutoClose(paneId, pane);
    return { paneId, pane };
  }

  private _createPaneStore(paneId: string): PaneStore<R> {
    return new PaneStore<R>(this._registry, this._ctx, {
      layoutOpener: (kind, args, config) => this.open(kind, args, config),
      isViewActive: () => this._isViewActiveBox.get(),
      layoutSplitter: {
        windowOpener: (tabId) => this.windowOpener?.(tabId) ?? null,
        pairAnchorTab: () => {
          const anchor = this.pairAnchor?.() ?? null;
          return anchor && anchor.paneId === paneId ? anchor.tabId : null;
        },
        moveToOtherPane: (tabId) => {
          const to = neighbourInOrder(this.layout, paneId, 'after') ?? neighbourInOrder(this.layout, paneId, 'before');
          return to ? () => this.moveTab(tabId, paneId, to) : null;
        },
      },
    });
  }

  private _isPersistentTab(pane: PaneStore<R>, tabId: string | undefined): boolean {
    if (!tabId) return true;
    const entry = pane.entries.get(tabId);
    if (!entry || !pane.registry.has(entry.kind)) return true;
    return pane.registry.get(entry.kind).isPersistent?.(entry.state as never) !== false;
  }

  private _projectPaneSnapshot(group: Pane<R>): TabManagerSnapshot {
    const snapshot = group.pane.snapshot;
    if (this._isPersistentTab(group.pane, group.pane.resolvedActiveTabId)) return snapshot;

    const lastPersistentTabId = this._lastPersistentActiveTabIds.get(group.paneId);
    if (!snapshot.tabs.some((tab) => tab.tabId === lastPersistentTabId)) return snapshot;
    return { ...snapshot, activeTabId: lastPersistentTabId };
  }

  private _registerAutoClose(paneId: string, pane: PaneStore<R>): void {
    const disposer = reaction(
      () => pane.tabOrder.length,
      (length) => {
        if (length === 0 && this.groups.length > 1) {
          this.closePane(paneId);
        }
      }
    );
    this._autoCloseDisposers.set(paneId, disposer);
  }

  /** `groups` in the layout's walk order (top-left to bottom-right): what lists and 'left' / 'right' read. */
  private _syncGroupOrder(): void {
    const order = paneOrder(this.layout);
    const rank = new Map(order.map((id, index) => [id, index]));
    const sorted = [...this.groups].sort(
      (a, b) => (rank.get(a.paneId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.paneId) ?? Number.MAX_SAFE_INTEGER)
    );
    this.groups.splice(0, this.groups.length, ...sorted);
  }
}
