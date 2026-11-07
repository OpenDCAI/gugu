import { action, computed, makeObservable, observable, reaction } from 'mobx';
import { MIN_PANE_HEIGHT_PX, MIN_PANE_WIDTH_PX, PaneStore } from '@renderer/features/tabs/pane-store';
import type { DisplacedTab, TabGroupsSnapshot, TabManagerSnapshot } from '@shared/view-state';
import type { TabEntry, TabViewContext } from './core/tab-provider';
import type {
  AnyTabProvider,
  KindOf,
  OpenArgsOf,
  TabOpenOptions,
  TabRegistry,
} from './core/tab-provider-registry';
import type { TabPersistenceAdapter } from './persistence';
import { accountTabPlacementMemory, type TabPlacementMemory } from './tab-placement-memory';
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

// 一格最窄多宽、最矮多高:定义挪到 pane-store(并排的两页也守它),这里照旧导出。
export { MIN_PANE_HEIGHT_PX, MIN_PANE_WIDTH_PX };

/** 为什么分不出来:没有别的页可以并排 / 放不下两页。 */
export type SplitBlock = 'only-tab' | 'too-small';
/** 并排里另一页摆在哪一边(只有左右:「向下分」owner 11-05 拿掉了)。 */
export type PairEdge = 'left' | 'right';

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
 * One session's tabs (spec session-page「并排」): **one tab strip**, at most one pair.
 *
 * @@@pair - while two pages stand side by side, the second pane holds the side: its page in front, plus the pages it
 * showed before (kept mounted there, as any hidden tab). The strip is drawn once for both - the main pane's strip with
 * the side joined right after the pinned tab and the side pane's other pages after it - so a session never shows a
 * second strip. Every entry that shows two pages — opening from a conversation, the tab
 * menu's 「向右分」, dragging to an edge, ⌘\ — goes through `pairWith`; 「拆开」 and closing either one go through
 * `unpair`. Moving a tab between the two panes is detach + adopt: the resource survives, no lifecycle calls.
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
  narrow = false;
  /** The pane holding the side of the pair; null = not paired. */
  sidePaneId: string | null = null;
  /**
   * The user separated a pair (拆开, ⌘\): from now on what a conversation opens is an ordinary tab, until the user
   * splits again (spec session-page「拆开 = 不分屏」). With the per-page memory it is an OR: either says separate.
   */
  pairDeclined = false;
  /**
   * @@@displaced - what each tab pushed out of the pair (owner 11-05 msg:00b090e9): closing it brings that one back,
   * beside what remains. One level per tab; closing a pushed-out tab hands its own record to whoever pointed at it, so
   * a chain unwinds one step per close. The user rearranging the pair (拆开, 向右分, a drag) clears its records.
   */
  private readonly _displaced = observable.map<string, DisplacedTab>({}, { deep: false });

  setNarrow(narrow: boolean): void { this.narrow = narrow; }
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
  private readonly _placementMemory: TabPlacementMemory;
  private readonly _activeTabDisposer: () => void;
  private _lastPersistentActivePaneId: string;
  private readonly _lastPersistentActiveTabIds = new Map<string, string | undefined>();

  constructor(
    registry: R,
    ctx: TabViewContext,
    persistor?: TabPersistenceAdapter,
    opts?: {
      onActiveTabChange?: (tabId: string | undefined) => void;
      placementMemory?: TabPlacementMemory;
    }
  ) {
    this._registry = registry;
    this._ctx = ctx;
    this._persistor = persistor;
    this._onActiveTabChange = opts?.onActiveTabChange;
    this._placementMemory = opts?.placementMemory ?? accountTabPlacementMemory();

    const initial = this._createPane();
    this.groups.push(initial);
    this.activePaneId = initial.paneId;
    this._lastPersistentActivePaneId = initial.paneId;
    this.layout = paneLeaf(initial.paneId);

    makeObservable(this, {
      groups: observable,
      activePaneId: observable,
      narrow: observable,
      sidePaneId: observable,
      pairDeclined: observable,
      setNarrow: action,
      layout: observable.ref,
      paneSizes: computed,
      isViewActive: computed,
      focusedPane: computed,
      mainGroup: computed,
      sideGroup: computed,
      pair: computed,
      stripTabIds: computed,
      splitRight: action,
      splitPane: action,
      pairWith: action,
      unpair: action,
      closePane: action,
      handleDragEnd: action,
      setActiveGroup: action,
      setViewActive: action,
      setPaneSizes: action,
      setSplitSizes: action,
      equalizeSplit: action,
      restoreSnapshot: action,
      open: action,
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

  /** The pane holding every tab but the side. */
  get mainGroup(): Pane<R> {
    return this.groups.find((g) => g.paneId !== this.sidePaneId) ?? this.groups[0];
  }

  get sideGroup(): Pane<R> | undefined {
    return this.sidePaneId === null ? undefined : this.groups.find((g) => g.paneId === this.sidePaneId);
  }

  /** The two tabs on screen side by side: the pinned one (main pane) and the side. */
  get pair(): { pinned: string; side: string } | null {
    const side = this.sideGroup?.pane.resolvedActiveTabId;
    const pinned = this.mainGroup.pane.resolvedActiveTabId;
    return side && pinned ? { pinned, side } : null;
  }

  /** The one strip, left to right: the main pane's tabs, the side pane's right after the pinned one (side in front first). */
  get stripTabIds(): string[] {
    const main = this.mainGroup.pane;
    const side = this.sideGroup?.pane;
    const pinned = main.resolvedActiveTabId;
    if (!side || !pinned) return [...main.tabOrder];
    const sideTabs = [side.resolvedActiveTabId!, ...side.tabOrder.filter((id) => id !== side.resolvedActiveTabId)];
    return main.tabOrder.flatMap((id) => (id === pinned ? [id, ...sideTabs] : [id]));
  }

  /** ⌘\: paired = 拆开; else the tab in front goes side by side with the one looked at before it. */
  splitRight(): void {
    if (this.sidePaneId !== null) this.unpair({ declined: true });
    else this.splitPane(this.activePaneId, 'right');
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
   * 把 `tabId` 从它那一格拿出来,放进一格只属于一扇窗的格子(资源不重建)。返回那一格的 id;找不到这枚 = null。
   * 原来那一格因此空了就照常收掉(放回时回到焦点那一格)。
   */
  detachToWindow(tabId: string): string | null {
    const source = this.groups.find((g) => g.pane.entries.has(tabId));
    if (!source) return null;
    this._rememberPlacement(source.pane.entries.get(tabId)!, 'separate');
    const pinnedLeaves = source === this.mainGroup && this.pair?.pinned === tabId;
    const detached = source.pane.detachTab(tabId);
    if (!detached) return null;
    // The pinned page left: the side fills (spec session-page「并排」). The side leaving closes its pane.
    if (pinnedLeaves) this.unpair();
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
    const target = this.mainGroup;
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

  /** Why `splitPane` would not pair `tabId` (default: the tab in front) with another page (null = it would). */
  splitBlocked(_paneId: string, tabId?: string, edge?: PaneEdge): SplitBlock | null {
    if (edge === 'top' || edge === 'bottom') return 'too-small';
    const moving = tabId ?? this.focusedPane.resolvedActiveTabId;
    if (!moving || !this._pinFor(moving)) return 'only-tab';
    return this.roomToSplit() ? null : 'too-small';
  }

  /** Room for two pages side by side, each at least MIN_PANE_WIDTH_PX (can't measure = room: tests, not drawn yet). */
  private roomToSplit(): boolean {
    const sizes = this.groups.map(({ paneId, pane }) => this.paneSizer?.(paneId) ?? pane.dimensions);
    if (sizes.some((size) => !size)) return typeof window === 'undefined' || window.innerWidth >= MIN_PANE_WIDTH_PX * 2 + 1;
    return sizes.reduce((width, size) => width + size!.width, 0) >= MIN_PANE_WIDTH_PX * 2 + 1;
  }

  /** 一格此刻画出来多大:会话页那一侧量了挂上来;没挂 = 不知道。 */
  paneSizer: ((paneId: string) => { width: number; height: number } | null) | null = null;

  setPaneSizer(sizer: ((paneId: string) => { width: number; height: number } | null) | null): void {
    this.paneSizer = sizer;
  }

  /**
   * The user splits (tab menu 「向右分」, a drag to an edge, ⌘\): `tabId` (default: the tab in front) goes side by side
   * with the page looked at before it, on `edge`. Splitting is the user choosing to split again (clears 拆开).
   */
  splitPane(paneId: string, edge: PaneEdge, tabId?: string): boolean {
    if (this.splitBlocked(paneId, tabId, edge) !== null) return false;
    const moving = tabId ?? this.focusedPane.resolvedActiveTabId!;
    this.pairDeclined = false;
    this.pairWith(this._pinFor(moving)!, moving, { edge: edge as PairEdge, by: 'user' });
    return true;
  }

  /** What `moving` pairs with: the pinned page; moving the pinned one itself swaps it with the side; else the page before. */
  private _pinFor(moving: string): string | undefined {
    const pair = this.pair;
    if (pair) return moving === pair.pinned ? pair.side : moving === pair.side ? pair.pinned : pair.pinned;
    const main = this.mainGroup.pane;
    const active = main.resolvedActiveTabId;
    if (active && active !== moving) return active;
    const previous = main.previousActiveTabId;
    if (previous && previous !== moving) return previous;
    return main.tabOrder.find((id) => id !== moving);
  }

  /**
   * Show `pinned` and `side` side by side (spec session-page「并排」). The pinned page goes to the main pane and stays in
   * front there; `side` goes alone into the side pane; a side it replaces goes back to the strip as an ordinary tab, right
   * after the pinned one. `focus: false` leaves focus where it is.
   */
  pairWith(pinned: string, side: string, opts: { edge?: PairEdge; focus?: boolean; by?: 'push' | 'user' | 'restore' } = {}): void {
    if (pinned === side || !this._groupOf(pinned) || !this._groupOf(side)) return;
    const before = this.pair;
    const main = this.mainGroup;
    let sideGroup = this.sideGroup;
    if (this._groupOf(pinned) !== main) this._move(pinned, main);
    if (!sideGroup) {
      sideGroup = this._createPane();
      this.groups.push(sideGroup);
      this.sidePaneId = sideGroup.paneId;
    }
    if (this._groupOf(side) !== sideGroup) this._move(side, sideGroup);
    if (opts.edge || this.layout.type === 'pane') {
      const sizes = this.layout.type === 'split' ? this.layout.sizes : null;
      this.layout = insertBeside(paneLeaf(main.paneId), main.paneId, sideGroup.paneId, opts.edge ?? 'right');
      if (sizes && this.layout.type === 'split') this.layout = setSplitSizes(this.layout, this.layout.id, sizes);
      this._syncGroupOrder();
    }
    main.pane.activeTabId = pinned;
    sideGroup.pane.activeTabId = side;
    if (opts.focus ?? true) this.activePaneId = sideGroup.paneId;
    for (const id of [pinned, side]) {
      const entry = this._groupOf(id)?.pane.entries.get(id);
      if (entry) this._rememberPlacement(entry, 'beside');
    }
    const by = opts.by ?? 'push';
    if (by === 'user') {
      for (const id of [pinned, side, before?.pinned, before?.side]) if (id) this._displaced.delete(id);
    } else if (by === 'push' && before) {
      const entering = [pinned, side].filter((id) => id !== before.pinned && id !== before.side);
      const leaving = (['pinned', 'side'] as const).filter((role) => before[role] !== pinned && before[role] !== side);
      if (entering.length === 1 && leaving.length === 1) this._displaced.set(entering[0], { tabId: before[leaving[0]], role: leaving[0] });
    }
  }

  /** A tab left for good: hand its record on; if it was on screen in the pair, bring back what it pushed out. */
  private _tabRemoved(paneId: string, tabId: string, wasActive: boolean): void {
    const record = this._displaced.get(tabId);
    this._displaced.delete(tabId);
    for (const [other, pointed] of [...this._displaced]) {
      if (pointed.tabId !== tabId) continue;
      if (record) this._displaced.set(other, record);
      else this._displaced.delete(other);
    }
    if (!wasActive || this.sidePaneId === null) return;
    const closedSide = paneId === this.sidePaneId;
    const remaining = closedSide ? this.mainGroup.pane.resolvedActiveTabId : this.sideGroup?.pane.resolvedActiveTabId;
    // Valid only while it is still an ordinary tab of this strip: not closed, not in a window, not on screen.
    const back = record && remaining && record.tabId !== remaining && this._groupOf(record.tabId) ? record : undefined;
    if (back && remaining) {
      if (back.role === 'pinned') this.pairWith(back.tabId, remaining, { by: 'restore' });
      else this.pairWith(remaining, back.tabId, { by: 'restore' });
      return;
    }
    // The pinned page closed: the side fills. The side closed: the pinned page fills.
    this.unpair({ fill: closedSide ? 'pinned' : 'side' });
  }

  /**
   * Back to one page: the side pane's pages become ordinary tabs right after the pinned one. `declined`: the user
   * separated them (拆开) — both pages and the session remember it. `fill`: which of the two is in front afterwards.
   */
  unpair(opts: { declined?: boolean; fill?: 'pinned' | 'side' } = {}): void {
    const side = this.sideGroup;
    if (!side) return;
    const main = this.mainGroup;
    const pinned = main.pane.resolvedActiveTabId;
    const sideTab = side.pane.resolvedActiveTabId;
    // 拆开: the one being looked at fills. One of the two closed or left: the other one fills.
    const fill = opts.fill ?? (opts.declined && this.activePaneId !== side.paneId ? 'pinned' : 'side');
    const front = fill === 'pinned' ? pinned : sideTab;
    for (const id of [...side.pane.tabOrder]) this._move(id, main, pinned);
    this.closePane(side.paneId);
    if (front) main.pane.activeTabId = front;
    this.activePaneId = main.paneId;
    if (!opts.declined) return;
    this.pairDeclined = true;
    for (const id of [pinned, sideTab]) if (id) this._displaced.delete(id);
    for (const id of [pinned, sideTab]) {
      const entry = id ? main.pane.entries.get(id) : undefined;
      if (entry) this._rememberPlacement(entry, 'separate');
    }
  }

  private _groupOf(tabId: string): Pane<R> | undefined {
    return this.groups.find((g) => g.pane.entries.has(tabId));
  }

  /** Detach + adopt: the resource survives unchanged, no lifecycle calls. `after`: insert right after that tab. */
  private _move(tabId: string, to: Pane<R>, after?: string): void {
    const from = this._groupOf(tabId);
    if (!from || from === to) return;
    const detached = from.pane.detachTab(tabId);
    if (!detached) return;
    const at = after ? to.pane.tabOrder.indexOf(after) : -1;
    to.pane.adoptEntry(detached.entry, detached.resource, { insertBeforeTabId: at === -1 ? undefined : to.pane.tabOrder[at + 1], activate: false });
  }

  closePane(paneId: string): void {
    if (this.groups.length <= 1) return;

    const index = this.groups.findIndex((g) => g.paneId === paneId);
    if (index === -1) return;

    if (this.sidePaneId === paneId) this.sidePaneId = null;
    const closing = this.groups[index];
    for (const entry of closing.pane.entries.values()) this._rememberPlacement(entry, 'beside');
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
   * A tab dropped (#7052): on a page's edge = side by side there; on the side's page = it becomes the side; the side
   * dropped among the tabs or on the main page = back to an ordinary tab; within the strip = reorder.
   */
  handleDragEnd(draggedTabId: string, overId: string): void {
    const fromGroup = this._groupOf(draggedTabId);
    if (!fromGroup) return;

    const edgeDrop = parseEdgeDrop(overId);
    if (edgeDrop) {
      this.splitPane(edgeDrop.paneId, edgeDrop.edge, draggedTabId);
      return;
    }

    const dropPane = overId.startsWith('pane-drop-') ? overId.slice('pane-drop-'.length) : overId.startsWith('pane-content-') ? overId.slice('pane-content-'.length) : undefined;
    const pair = this.pair;
    if (dropPane !== undefined && dropPane === this.sidePaneId && pair && draggedTabId !== pair.side) {
      this.pairWith(draggedTabId === pair.pinned ? pair.side : pair.pinned, draggedTabId, { by: 'user' });
      return;
    }
    if (pair && draggedTabId === pair.side) {
      this.unpair();
      for (const id of [pair.pinned, pair.side]) this._displaced.delete(id);
    } else if (fromGroup.paneId === this.sidePaneId) {
      this._move(draggedTabId, this.mainGroup);
    }
    const pane = this.mainGroup.pane;
    const fromIdx = pane.tabOrder.indexOf(draggedTabId);
    const toIdx = dropPane !== undefined ? pane.tabOrder.length - 1 : pane.tabOrder.indexOf(overId);
    if (fromIdx !== -1 && toIdx !== -1) pane.reorderTabs(fromIdx, toIdx);
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

  /** All opens name their source. No cardinality lookup, anchor inference or tab moving happens here. */
  open<K extends KindOf<R>>(kind: K, args: OpenArgsOf<R, K>, config: TabOpenOptions): string | undefined;
  open(kind: string, args: Record<string, unknown>, config: TabOpenOptions): string | undefined;
  open(kind: string, args: Record<string, unknown>, config: TabOpenOptions): string | undefined {
    if (!this._registry.has(kind)) return;
    if (config.from !== null && ![...this.groups, ...this.windowPanes.values()].some(({ pane }) => pane.entries.has(config.from!))) return;
    const def = this._registry.get(kind) as AnyTabProvider;
    const state = def.onBeforeOpen ? def.onBeforeOpen(args as never, this._ctx) : args;
    if (state !== null) return this._openFrom(kind, state, config);
  }

  private _resourceId(kind: string, state: unknown): string {
    const place = this._ctx.place;
    const container = place?.kind === 'session' ? `session:${place.sessionId}` : place?.kind === 'chat' ? `chat:${place.chatId}` : this._ctx.viewId;
    return `${container}\u0000${kind}\u0000${this._registry.get(kind).resourceKey(state as never)}`;
  }

  private _rememberPlacement(entry: TabEntry, placement: 'separate' | 'beside'): void {
    const pages = [...(entry.history?.pages ?? []), { kind: entry.kind, state: entry.state }];
    for (const page of pages) {
      if (!this._registry.has(page.kind) || this._registry.get(page.kind).conversation) continue;
      this._placementMemory.write(this._resourceId(page.kind, page.state), placement);
    }
  }

  /**
   * Where an open lands (spec session-page「并排」, owner 11-05): clicked inside a page = that tab navigates in place;
   * from a conversation (or asked `beside`) = side by side with it, unless that page or this session says separate;
   * otherwise a tab in the strip. Already open = that tab is shown, never a second one.
   */
  private _openFrom(kind: string, state: unknown, config: TabOpenOptions): string | undefined {
    const panes = [...this.groups, ...this.windowPanes.values()];
    const source = typeof config.from === 'string'
      ? panes.find((group) => group.pane.entries.has(config.from!))
      : undefined;
    if (typeof config.from === 'string' && !source) return;
    const from = source && config.from ? source.pane.entries.get(config.from) : undefined;
    const intent = config.intent ?? 'navigate';
    const activate = config.activate ?? true;
    const conversation = from && this._registry.has(from.kind) && this._registry.get(from.kind).conversation === true;
    // How this page was last shown (owner 11-03: separate stays separate, beside stays beside).
    const remembered = intent !== 'newTab' ? this._placementMemory.read(this._resourceId(kind, state)) : undefined;
    // Already open = that tab is shown (spec 「同一页已经开着」, owner 10-24: one resource, one tab); an explicit new tab
    // is a context of its own.
    const key = this._registry.get(kind).resourceKey(state as never);
    const open = intent === 'newTab' ? undefined : this.groups.flatMap(({ pane }) => [...pane.entries.values()])
      .find((entry) => entry.kind === kind && this._registry.get(kind).resourceKey(entry.state as never) === key);

    // A page this tab already went through is the tab's own (a file's 阅读 and 编辑): where it was last shown does not move it.
    const own = from && source!.pane.navigationOf(from.tabId)!.pages.some((page) => page.kind === kind && this._registry.get(kind).resourceKey(page.state as never) === key);
    if (intent === 'navigate' && from && !conversation && (own || !remembered) && (!open || open === from)) {
      source!.pane.navigate(from.tabId, kind, state);
      if (activate) {
        if (this.groups.includes(source as Pane<R>)) this.activePaneId = source!.paneId;
        source!.pane.activeTabId = from.tabId;
        // A resident source guest lives outside the pane DOM. Hand input to its replacement after navigation, never
        // while close confirmation is pending.
        if (source!.pane.entries.get(from.tabId) !== from) source!.pane.focusActiveContent();
      }
      return from.tabId;
    }

    const separate = this.pairDeclined || remembered === 'separate';
    const inLayout = !source || this.groups.includes(source as Pane<R>);
    // Pairing currently selects the pinned page. Until pair identity is independent of the active page, a background
    // request must leave another page the person is viewing alone (spec session-page「不切走正在看的」).
    const showPair = activate || from?.tabId === this.focusedPane.resolvedActiveTabId;
    const beside = inLayout && showPair && !separate && (intent === 'beside' || (intent === 'navigate' && (conversation || remembered === 'beside')));
    // Shown again from another page: that page is now its 上一页 (owner 10-24: how it was opened only gives it a Back).
    if (open && from && !conversation && open !== from) open.openerTabId = from.tabId;
    // The same page asked again: the latest ask wins (#7257) — e.g. a newer message carrying the same file.
    if (open && open !== from) open.state = state;
    let tabId = open?.tabId;
    if (!tabId) {
      const main = this.mainGroup.pane;
      tabId = main.openWithState(kind, state, { activate: false, after: from && main.entries.has(from.tabId) ? from.tabId : undefined, openerTabId: from?.tabId });
      if (!tabId) return;
    }
    const pinned = from && inLayout ? from.tabId : this.mainGroup.pane.resolvedActiveTabId;
    if (beside && pinned && pinned !== tabId) {
      this.pairWith(pinned, tabId, { focus: activate });
    } else if (activate) {
      this._groupOf(tabId)?.pane.setActiveTab(tabId);
    }
    if (activate) this._groupOf(tabId)?.pane.focusActiveContent();
    return tabId;
  }

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
      const home = projected.find(({ group }) => group === this.mainGroup) ?? projected[0];
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
      ...(this.sidePaneId !== null && retainedIds.includes(this.sidePaneId) ? { sideGroupId: this.sidePaneId } : {}),
      ...(this._displaced.size > 0 ? { displaced: Object.fromEntries(this._displaced) } : {}),
    };
  }

  restoreSnapshot(input: TabGroupsSnapshot): void {
    const snapshot = input;
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
    this._restorePair(snapshot.sideGroupId);
    const open = new Set(this.groups.flatMap(({ pane }) => pane.tabOrder));
    this._displaced.replace(Object.entries(snapshot.displaced ?? {}).filter(([tabId, record]) => open.has(tabId) && open.has(record.tabId)));
  }

  /**
   * A saved layout of several panes (every v3 save, any pane tree) comes back as one strip. A saved pair names its side;
   * else the pane holding the conversation (else the first) is the main one and the focused other pane's page in front
   * is the side. Every other tab joins the main strip. Left/right and the shares are kept (spec 「以前分好几栏的」).
   */
  private _restorePair(savedSide?: string): void {
    this.sidePaneId = null;
    if (this.groups.length < 2) return;
    const order = paneOrder(this.layout);
    const savedSizes = this.layout.type === 'split' && this.layout.orientation === 'horizontal' && this.layout.children.length === 2 ? this.layout.sizes : null;
    const main = (savedSide !== undefined ? this.groups.find((g) => g.paneId !== savedSide) : undefined)
      ?? this.groups.find(({ pane }) => [...pane.entries.values()].some((entry) => this._registry.has(entry.kind) && this._registry.get(entry.kind).conversation))
      ?? this.groups[0];
    const side = this.groups.find((g) => g !== main && g.paneId === this.activePaneId && g.pane.tabOrder.length > 0) ?? this.groups.find((g) => g !== main && g.pane.tabOrder.length > 0);
    const sideTab = side?.pane.resolvedActiveTabId;
    for (const group of this.groups) {
      if (group === main || group === side) continue;
      for (const id of [...group.pane.tabOrder]) this._move(id, main);
    }
    for (const group of [...this.groups]) if (group !== main && group !== side) this.closePane(group.paneId);
    if (!side || !sideTab) return;
    this.sidePaneId = side.paneId;
    const sideFirst = order.indexOf(side.paneId) < order.indexOf(main.paneId);
    this.layout = insertBeside(paneLeaf(main.paneId), main.paneId, side.paneId, sideFirst ? 'left' : 'right');
    if (savedSizes && this.layout.type === 'split') this.layout = setSplitSizes(this.layout, this.layout.id, savedSizes);
    this._syncGroupOrder();
    if (this.activePaneId !== side.paneId) this.activePaneId = main.paneId;
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

  private _createPane(): Pane<R> {
    const paneId = crypto.randomUUID();
    const pane = this._createPaneStore(paneId);
    this._registerAutoClose(paneId, pane);
    return { paneId, pane };
  }

  private _createPaneStore(paneId: string): PaneStore<R> {
    return new PaneStore<R>(this._registry, this._ctx, {
      layoutOpener: (kind, args, config) => this.open(kind, args, config),
      isViewActive: () => this._isViewActiveBox.get() && (!this.narrow || this.activePaneId === paneId),
      layoutSplitter: {
        tabClosing: (entry) => this._rememberPlacement(entry, this.sidePaneId !== null ? 'beside' : 'separate'),
        // Closing the pinned page = the side fills (closing the side closes its pane): 关掉一页 ≠ 拆开.
        tabRemoved: (tabId, wasActive) => this._tabRemoved(paneId, tabId, wasActive),
        // While paired, bringing any other tab of the strip forward replaces the side; the pinned page stays.
        activating: (tabId) => {
          this.activePaneId = paneId;
          const pair = this.pair;
          if (!pair || tabId === pair.pinned || tabId === pair.side) return false;
          this.pairWith(pair.pinned, tabId);
          return true;
        },
        windowOpener: (tabId) => this.windowOpener?.(tabId) ?? null,
        split: (tabId) => { this.splitPane(paneId, 'right', tabId); },
        splitBlocked: (tabId) => this.splitBlocked(paneId, tabId, 'right'),
        entryForTab: (tabId) => this.groups.map(({ pane }) => pane.entries.get(tabId)).find(Boolean),
        isOnScreen: (tabId) => !this.narrow && (this.pair?.pinned === tabId || this.pair?.side === tabId),
        revealTab: (tabId) => {
          const group = this._groupOf(tabId);
          if (!group) return false;
          group.pane.setActiveTab(tabId);
          group.pane.focusActiveContent();
          return true;
        },
        hasSibling: () => this.groups.length > 1,
        isFocusedPane: () => this.activePaneId === paneId,
        pairRole: (tabId) => {
          const pair = this.pair;
          if (!pair || (tabId !== pair.pinned && tabId !== pair.side)) return undefined;
          const sideFirst = paneOrder(this.layout)[0] === this.sidePaneId;
          return (tabId === pair.side) === sideFirst ? 'start' : 'end';
        },
        pairSide: () => (paneId === this.sidePaneId ? undefined : this.sideGroup),
        isSide: () => paneId === this.sidePaneId,
        separatePair: () => this.unpair({ declined: true }),
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
