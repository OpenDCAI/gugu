import { action, comparer, computed, makeObservable, observable, reaction, runInAction, toJS } from 'mobx';
import type { Snapshottable } from '@renderer/lib/stores/snapshottable';
import {
  addTabId,
  removeTabId,
  reorderTabIds,
  setNextTabActive as tabUtilsSetNextTabActive,
  setPreviousTabActive as tabUtilsSetPreviousTabActive,
  setTabActiveIndex as tabUtilsSetTabActiveIndex,
  type TabOrderState,
} from '@renderer/lib/stores/tab-utils';
import {
  isBuiltInTabKind,
  type BuiltInTabDescriptor,
  type TabDescriptor,
  type TabManagerSnapshot,
  type TabReturnTo,
} from '@shared/view-state';
import type { TabHost } from './core/tab-host';
import { tabFullscreen } from './tab-fullscreen';
import type {
  TabEntry,
  TabHandle,
  TabResource,
  TabViewContext,
  ResolvedTab,
} from './core/tab-provider';
import type { KindOf, OpenArgsOf, TabOpenOptions, TabRegistry } from './core/tab-provider-registry';
import { createUnavailableTabResource, isUnavailableTabResource } from './unavailable-tab';

/**
 * 一格最窄多宽、最矮多高。宽照 VS Code 编辑区一格的下限(src/vs/workbench/browser/parts/editor/editor.ts
 * `DEFAULT_EDITOR_MIN_DIMENSIONS = new Dimension(220, 70)`);高要放下页签条和一点内容。分出来会比这还窄 / 矮 = 不分。
 * 并排的两页也各守这个宽(spec session-page「并排」)。
 */
export const MIN_PANE_WIDTH_PX = 220;
export const MIN_PANE_HEIGHT_PX = 160;

/** 并排里另一页摆在钉住那页的哪一边:左右 = 左右并排,上下 = 上下叠着。 */
export type PairEdge = 'left' | 'right' | 'top' | 'bottom';

/**
 * 并排(spec session-page「并排」,一条会话分屏只有这一种):钉住的那页(`anchor` —— 分屏前在看的那页,
 * agent 打开时是对话)和另一页(`side`),同一条页签条上连成一对。之后点别的页签、再拖进来一页,换掉的都是 `side`。
 * `sideAt` = 另一页摆在哪一边;`ratio` = 前一页(左 / 上)占几成。
 */
export type TabPair = { anchor: string; side: string; sideAt: PairEdge; ratio: number | null };

const OPPOSITE_EDGE: Record<PairEdge, PairEdge> = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
export const isVerticalPairEdge = (edge: PairEdge): boolean => edge === 'top' || edge === 'bottom';
/** 另一页摆在前一格(左 / 上)。 */
const sideLeads = (edge: PairEdge): boolean => edge === 'left' || edge === 'top';

/** 换了摆法、前一格换了一页:比例翻过来,两页各自的宽窄照旧(ratio 记的是前一格占几成;null = 照页面自己声明的宽)。 */
function ratioKeepingWidths(before: TabPair, after: TabPair): number | null {
  if (before.ratio === null) return null;
  return sideLeads(before.sideAt) === sideLeads(after.sideAt) ? before.ratio : 1 - before.ratio;
}

/** 这一格放得下两页吗(各至少 MIN_PANE_WIDTH_PX 宽 / MIN_PANE_HEIGHT_PX 高;量不到 = 放得下)。 */
function roomForTwo(dimensions: { width: number; height: number } | null, vertical: boolean): boolean {
  if (!dimensions) return true;
  return vertical ? dimensions.height >= MIN_PANE_HEIGHT_PX * 2 + 1 : dimensions.width >= MIN_PANE_WIDTH_PX * 2 + 1;
}

/** Serialize a live entry to the built-in or extension shape used in snapshots and history. */
function descriptorOf(entry: TabEntry): TabDescriptor {
  const state = toJS(entry.state) as Record<string, unknown>;
  const navigation = entry.returnTo ? { returnTo: toJS(entry.returnTo) } : {};
  if (!isBuiltInTabKind(entry.kind)) {
    return {
      kind: 'extension',
      extensionKind: entry.kind,
      tabId: entry.tabId,
      isPreview: entry.isPreview,
      state,
      ...navigation,
    };
  }
  return {
    kind: entry.kind,
    tabId: entry.tabId,
    isPreview: entry.isPreview,
    ...state,
    ...navigation,
  } as BuiltInTabDescriptor;
}

/** Deserialize a TabDescriptor back to its runtime provider identity and opaque state. */
function stateFromDescriptor(desc: TabDescriptor): {
  kind: string;
  tabId: string;
  isPreview: boolean;
  state: unknown;
  returnTo?: TabReturnTo;
} {
  if (desc.kind === 'extension') {
    return {
      kind: desc.extensionKind,
      tabId: desc.tabId,
      isPreview: desc.isPreview,
      state: desc.state ?? {},
      returnTo: desc.returnTo,
    };
  }
  const { kind, tabId, isPreview, returnTo, ...state } = desc;
  return { kind, tabId, isPreview, state, returnTo };
}

class TabEntryImpl<S = unknown> implements TabEntry<S> {
  readonly kind: string;
  readonly tabId: string;
  isPreview: boolean;
  returnTo?: TabReturnTo;
  /** Reactive, serializable domain state. Mutated in-place; read by snapshot. */
  state: S;

  constructor(kind: string, tabId: string, isPreview: boolean, state: S, returnTo?: TabReturnTo) {
    this.kind = kind;
    this.tabId = tabId;
    this.isPreview = isPreview;
    this.state = state;
    this.returnTo = returnTo;
    makeObservable(this, {
      isPreview: observable,
      state: observable,
      returnTo: observable,
    });
  }
}

/**
 * Owns all tab open/close/order/active state for a single pane.
 *
 * The engine guarantees:
 *   - initialize() is called exactly once when a tab enters the view
 *   - dispose() is called exactly once when a tab permanently leaves the view
 *   - Neither is called during a cross-pane tab move (detachTab + adoptEntry)
 *
 * Domain resource managers (not the engine) are responsible for ref-counting.
 */
/**
 * What a pane inside a layout can ask of it. 分屏不在这里:一条会话只有一条页签条,向右分 / 向下分 / 拖到边上
 * 都是这一格里的并排(spec session-page「并排」),由 PaneStore 自己做。
 */
export interface PaneSplitter {
  /** 这一枚能不能单独成窗,能的话怎么开(会话自己那枚 = 整个会话,App 那枚 = 这个 App,别的附页 = 这一枚)。 */
  windowOpener?(tabId: string): (() => void) | null;
  /** 挪到这条会话的另一格(走格子的先后:后一格,没有就前一格);只有这一格 = null。 */
  moveToOtherPane?(tabId: string): (() => void) | null;
  /** 这一格里的对话那一枚(「开在对话旁边」的那一枚,PaneLayoutStore.setPairAnchor);不在这一格 = null。 */
  pairAnchorTab?(): string | null;
}

export class PaneStore<R extends TabRegistry = TabRegistry>
  implements Snapshottable<TabManagerSnapshot>, TabHost
{
  /** All open tab entries keyed by tabId. O(1) lookup; finer-grained MobX reactivity. */
  readonly entries = observable.map<string, TabEntryImpl>();
  /** Domain resources keyed by tabId. Parallel to entries. */
  readonly _resources = observable.map<string, TabResource>();
  /** Tab display order (array of tabIds). Drives resolvedTabs. */
  tabOrder: string[] = [];
  /** 拿着焦点的那一枚。并排时屏上有两枚,这是其中点着的那一边;「屏上显示着哪几枚」读 `shownTabIds`。 */
  activeTabId: string | undefined = undefined;
  /** 并排的一对(spec session-page「并排」);整份替换。成不成立读 `livePair`。 */
  pair: TabPair | null = null;
  /**
   * 用户拆开过哪几类页签(「拆开」、⌘\):之后开在对话旁边的**同一类**不再自动并排,只多一枚页签 —— 那是用户对这一类
   * 选的「不分屏」,❌ 让 agent 一打开就推翻。按类各记各的(owner 10-28):拆开过文件页,群文件 / 成员 / 设置照旧并排。
   * 用户自己再把这一类分屏才清掉。关掉一边 ≠ 拆开;程序为让位拆开的(`separatePair({ remember: false })`)也不算。
   */
  splitDeclinedKinds = new Set<string>();
  /** 上一枚拿过焦点的页签:分屏时「正看着的就是要挪的那枚」,另一边放它(⌘\ 也是和它并排)。 */
  private _previousActiveTabId: string | undefined = undefined;
  /** Current pixel dimensions of the pane container, null until first measurement. */
  dimensions: { width: number; height: number } | null = null;

  readonly registry: R;
  private readonly _ctx: TabViewContext;
  /**
   * Returns true when the owning view is the active route.
   * Injected by PaneLayoutStore; defaults to () => false for standalone panes.
   */
  private readonly _isViewActive: () => boolean;
  private readonly _layoutSplitter: PaneSplitter | null;
  /**
   * Layout-level opener injected at construction time.
   * Handles target routing and single-mount cardinality checks.
   */
  private readonly _layoutOpener:
    | ((kind: string, args: Record<string, unknown>, config?: TabOpenOptions) => void)
    | null;
  private readonly _closedTabHistory: Array<{
    desc: TabDescriptor;
    index: number;
  }> = [];
  private static readonly _MAX_CLOSED_HISTORY = 20;
  renameRequest: { tabId: string; nonce: number } | null = null;
  private _contentFocuser: (() => void) | null = null;
  /** Disposes the per-pane onActivate effect reaction. */
  private readonly _onActivateDisposer: () => void;
  private readonly _providerRegisteredDisposer: () => void;
  private readonly _providerUnregisteredDisposer: () => void;
  private readonly _kindClosedDisposer: () => void;

  get ctx(): TabViewContext {
    return this._ctx;
  }

  constructor(
    registry: R,
    ctx: TabViewContext,
    opts?: {
      layoutOpener?: (kind: string, args: Record<string, unknown>, config?: TabOpenOptions) => void;
      isViewActive?: () => boolean;
      /** Splitting a tab out beside this pane — only a pane inside a layout can (#7052). */
      layoutSplitter?: PaneSplitter;
    }
  ) {
    this.registry = registry;
    this._ctx = ctx;
    this._layoutOpener = opts?.layoutOpener ?? null;
    this._layoutSplitter = opts?.layoutSplitter ?? null;
    this._isViewActive = opts?.isViewActive ?? (() => false);

    makeObservable(this, {
      tabOrder: observable,
      activeTabId: observable,
      pair: observable.ref,
      splitDeclinedKinds: observable,
      livePair: computed,
      pairSlots: computed,
      pairShown: computed,
      shownTabIds: computed,
      pairWith: action,
      separatePair: action,
      splitBeside: action,
      toggleSplit: action,
      setPairRatio: action,
      isVisible: computed,
      dimensions: observable,
      resolvedActiveTabId: computed,
      activeEntry: computed,
      resolvedTabs: computed,
      snapshot: computed,
      open: action,
      openKind: action,
      closeTab: action,
      closeActiveTab: action,
      setActiveTab: action,
      reorderTabs: action,
      setNextTabActive: action,
      setPreviousTabActive: action,
      setTabActiveIndex: action,
      setDimensions: action,
      pin: action,
      closeOthers: action,
      closeToRight: action,
      closeAll: action,
      requestCloseTab: action,
      reopenClosedTab: action,
      restoreSnapshot: action,
      detachTab: action,
      adoptEntry: action,
      retargetEntry: action,
      renameRequest: observable,
      requestRename: action,
      clearRenameRequest: action,
      commitRename: action,
    });

    // Fire onActivate() whenever the active visible resource instance changes.
    // Tracking the resource instance (not just the tab id) ensures onActivate()
    // fires after a preview-retarget, where retargetEntry() swaps in a new
    // resource at the same tabId (leaving the id unchanged but the instance new).
    //
    // 并排时屏上有两枚(spec session-page「并排」):每一枚刚上屏都要 onActivate —— 它的意思是「这一页上屏了」
    // (对话开场加载记录、标已读、改动页同步当前文件)。❌ 只盯拿着焦点的那枚:焦点在右边那页时(人点了链接、
    // 重启后读回),左边的对话就永远不开场。
    this._onActivateDisposer = reaction(
      () =>
        this.isVisible
          ? this.shownTabIds.map((id) => this._resources.get(id)).filter((r): r is TabResource => r !== undefined)
          : [],
      (shown, previous) => {
        for (const resource of shown) if (!previous?.includes(resource)) resource.onActivate?.();
      },
      { fireImmediately: true, equals: comparer.shallow }
    );

    this._providerRegisteredDisposer = this.registry.onProviderRegistered((kind) => {
      runInAction(() => this._reviveUnavailableTabs(kind));
    });
    this._providerUnregisteredDisposer = this.registry.onProviderUnregistered((kind) => {
      runInAction(() => this._demoteTabsToUnavailable(kind));
    });
    this._kindClosedDisposer = this.registry.onKindClosed((kind, which) => {
      runInAction(() => this._closeTabsOfKind(kind, which));
    });
  }

  /**
   * Closes every open tab of a kind — for a disable the user asked for, where a
   * placeholder would be litter (see TabRegistry.closeKind). Goes through the
   * ordinary removal so reopen history and the active-tab handoff behave as if
   * the user had closed each one.
   */
  private _closeTabsOfKind(kind: string, which?: (state: unknown) => boolean): void {
    const ids = [...this.entries.values()]
      .filter((e) => e.kind === kind && (!which || which(e.state)))
      .map((e) => e.tabId);
    for (const id of ids) this._removeTab(id);
  }

  /**
   * Turns the placeholders for a kind into live tabs, now that its provider has
   * arrived. Reached when an extension registers after a restored layout — or
   * when one is reinstalled — and the user's open tabs must come back rather
   * than stay dead until they reopen them by hand.
   *
   * The entry object is reused, so tabId, order, preview flag and persisted
   * state survive: this promotes the tab in place, it does not reopen it.
   */
  /**
   * Turns a kind's live tabs back into placeholders, now that its provider is gone.
   *
   * The mirror of _reviveUnavailableTabs, and the reason it exists: uninstalling an
   * extension must not close the tabs the user left open, but it must stop the
   * uninstalled extension from continuing to draw them. Disposing the resource is
   * what tears its surface down — a user who uninstalls something they stopped
   * trusting should not have it still running until the next restart.
   *
   * The entry object is reused, so tabId, order, preview flag and persisted state
   * survive and a reinstall promotes the very same tab back.
   */
  private _demoteTabsToUnavailable(kind: string): void {
    for (const entry of this.entries.values()) {
      if (entry.kind !== kind) continue;
      const resource = this._resources.get(entry.tabId);
      if (!resource || isUnavailableTabResource(resource)) continue;
      resource.dispose();
      this._resources.set(entry.tabId, createUnavailableTabResource());
    }
  }

  private _reviveUnavailableTabs(kind: string): void {
    for (const entry of this.entries.values()) {
      if (entry.kind !== kind) continue;
      const resource = this._resources.get(entry.tabId);
      if (!resource || !isUnavailableTabResource(resource)) continue;
      resource.dispose();
      this._resources.set(
        entry.tabId,
        this.registry.get(kind).initialize(entry as never, this._buildHandle(entry), this._ctx)
      );
    }
  }

  /** True when the owning view is the currently active route. */
  get isVisible(): boolean {
    return this._isViewActive();
  }

  get resolvedActiveTabId(): string | undefined {
    if (this.activeTabId && this.entries.has(this.activeTabId)) {
      return this.activeTabId;
    }
    return this.tabOrder[0];
  }

  get activeEntry(): TabEntry | undefined {
    return this.entries.get(this.resolvedActiveTabId ?? '');
  }

  /** 这一对还成立吗:两枚都在、都认得出来(同一种页签也行 —— 两个文件、两个网页照样并排)。 */
  get livePair(): TabPair | null {
    const pair = this.pair;
    return pair && this._canPair(pair.anchor, pair.side) ? pair : null;
  }

  /** 一对在屏上怎么摆:前一页(左 / 上)、后一页(右 / 下)、是不是上下叠着。页签条上也按这个先后排。 */
  get pairSlots(): { first: string; second: string; vertical: boolean } | null {
    const pair = this.livePair;
    if (!pair) return null;
    const sideFirst = pair.sideAt === 'left' || pair.sideAt === 'top';
    return {
      first: sideFirst ? pair.side : pair.anchor,
      second: sideFirst ? pair.anchor : pair.side,
      vertical: isVerticalPairEdge(pair.sideAt),
    };
  }

  /**
   * 这一对此刻在屏上:点着的是其中一枚,且这一格放得下两页(各至少 MIN_PANE_WIDTH_PX 宽 / MIN_PANE_HEIGHT_PX 高)。
   * 放不下时一对照样连着,屏上只显示点着的那一页,宽了自动回并排(spec session-page「并排」)。
   */
  get pairShown(): boolean {
    if (tabFullscreen.isOn(this)) return false;
    const pair = this.livePair;
    if (!pair) return false;
    const active = this.resolvedActiveTabId;
    if (active !== pair.anchor && active !== pair.side) return false;
    return roomForTwo(this.dimensions, isVerticalPairEdge(pair.sideAt));
  }

  /** 此刻画在屏上的页签:并排时两枚(按屏上的先后:左 / 上在前),否则点着的那一枚。 */
  get shownTabIds(): readonly string[] {
    const slots = this.pairSlots;
    if (slots && this.pairShown) return [slots.first, slots.second];
    const active = this.resolvedActiveTabId;
    return active ? [active] : [];
  }

  private _canPair(anchor: string, side: string): boolean {
    if (anchor === side) return false;
    const a = this.entries.get(anchor);
    const b = this.entries.get(side);
    if (!a || !b) return false;
    if (!this.registry.has(a.kind) || !this.registry.has(b.kind)) return false;
    const ra = this._resources.get(anchor);
    const rb = this._resources.get(side);
    return !!ra && !!rb && !isUnavailableTabResource(ra) && !isUnavailableTabResource(rb);
  }

  /**
   * 开在对话旁边(agent 打开的、从对话里点开的):把 `tabId` 摆到 `anchorId`(对话)旁边并排(spec session-page「并排」)。
   * ❌ 不改点着的是哪一枚:用户正看着对话,就看到并排;正看着别的(终端、审阅),就不切走,一对只在页签条上连好。
   * 唯一例外是用户正点着被顶下来的那页 —— 那个位置换了一页,焦点跟着位置走。
   * 用户拆开过这一类(splitDeclinedKinds)、或摆不到一起(认不出来)= 什么都不做,它照常是一枚页签。
   */
  pairWith(anchorId: string, tabId: string): void {
    if (this.splitDeclinedFor(tabId) || !this._canPair(anchorId, tabId)) return;
    const current = this.livePair;
    if (current && (current.anchor === anchorId || current.side === anchorId)) {
      // 对话已经在这一对里(钉住的、或被摆到另一边的都算):另一页换成它,摆法不动,从此钉住的是对话。
      const other = current.anchor === anchorId ? current.side : current.anchor;
      if (other === tabId) return;
      const otherFocused = this.activeTabId === other;
      const sideAt = current.anchor === anchorId ? current.sideAt : OPPOSITE_EDGE[current.sideAt];
      this._replaceSide({ anchor: anchorId, side: other, sideAt, ratio: current.ratio }, tabId);
      if (otherFocused) this.activeTabId = tabId;
      return;
    }
    this.pair = { anchor: anchorId, side: tabId, sideAt: 'right', ratio: null };
    this._placeAdjacent(this.pair);
  }

  /**
   * 「拆开」(两枚中间那根线上的钮、页签右键、⌘\):两枚都变回普通页签,点着的那枚占满(照 Chrome「Separate views」)。
   * 这是用户对这一类选了不分屏:之后开在对话旁边的同一类不再自动并排,直到他自己再分屏。
   * `remember: false` = 程序为让位拆开的(会话浮在页上时,群面板 setPanelFull),不是用户的选择,❌ 记。
   */
  separatePair({ remember = true }: { remember?: boolean } = {}): void {
    const pair = this.pair;
    this.pair = null;
    if (!remember || !pair) return;
    // 记的是并排在对话旁边的那几类;对话那一枚(锚)本身不算一类「不想并排」的页签。
    const anchorTab = this._layoutSplitter?.pairAnchorTab?.() ?? null;
    for (const id of [pair.anchor, pair.side]) {
      const kind = id === anchorTab ? undefined : this.entries.get(id)?.kind;
      if (kind) this.splitDeclinedKinds.add(kind);
    }
  }

  /** 这一枚所属的那一类,用户拆开过没有(拆开过 = 开在对话旁边的不再自动并排)。 */
  splitDeclinedFor(tabId: string): boolean {
    const kind = this.entries.get(tabId)?.kind;
    return !!kind && this.splitDeclinedKinds.has(kind);
  }

  /** 用户自己把这几枚分屏了:它们那几类的「拆开过」清掉(别的类照旧)。 */
  private _acceptSplitOf(...tabIds: (string | undefined)[]): void {
    for (const id of tabIds) {
      const kind = id ? this.entries.get(id)?.kind : undefined;
      if (kind) this.splitDeclinedKinds.delete(kind);
    }
  }

  /**
   * 手动分屏(页签右键「向右分 / 向下分」、把页签拖到内容区的哪条边):`tabId` 摆到 `edge` 那一边并排,焦点给它。
   * - 它本来就在这一对里 = 只换摆法(它挪到那一边,另一枚到对面)。
   * - 屏上正并排着 = 它顶替另一页(钉住的那页不动)。
   * - 否则和此刻屏上那页并排,那页钉住;挪的正是屏上那页 = 另一边放上一枚看过的(没有就放它旁边那枚)。
   * 返回分没分成。
   */
  splitBeside(tabId: string, edge: PairEdge): boolean {
    if (this.pairSplitBlocked(tabId, edge) !== null) return false;
    const pair = this.livePair;
    if (pair && (tabId === pair.anchor || tabId === pair.side)) {
      const moved = { ...pair, sideAt: tabId === pair.side ? edge : OPPOSITE_EDGE[edge] };
      this.pair = { ...moved, ratio: ratioKeepingWidths(pair, moved) };
    } else if (pair && this.pairShown) {
      this._replaceSide(pair, tabId);
      const replaced = this.pair!;
      const moved = { ...replaced, sideAt: edge };
      this.pair = { ...moved, ratio: ratioKeepingWidths(replaced, moved) };
    } else {
      const anchor = this._partnerFor(tabId);
      if (!anchor || !this._canPair(anchor, tabId)) return false;
      this.pair = { anchor, side: tabId, sideAt: edge, ratio: null };
    }
    this._placeAdjacent(this.pair!);
    this._acceptSplitOf(this.pair!.anchor, this.pair!.side);
    this._focus(tabId);
    return true;
  }

  /** 往 `edge` 那边分为什么分不出来(null = 分得出来):没有别的页可并排 / 这一格太窄(太矮)放不下两页。 */
  pairSplitBlocked(tabId: string, edge: PairEdge): 'only-tab' | 'too-small' | null {
    const partner = this._partnerFor(tabId);
    if (!partner || !this._canPair(partner, tabId)) return 'only-tab';
    return roomForTwo(this.dimensions, isVerticalPairEdge(edge)) ? null : 'too-small';
  }

  /**
   * ⌘\:看着的是这一对(并排着、或窄得只显示一页)= 拆开;没并排 = 此刻这页钉住,和上一枚看过的(没有就旁边那枚)并排。
   * 正看着这一对之外的页签时按 = 分屏,❌ 拆开一对屏上看不见的。
   */
  toggleSplit(): void {
    const pair = this.livePair;
    const current = this.resolvedActiveTabId;
    if (pair && (current === pair.anchor || current === pair.side)) {
      this.separatePair();
      return;
    }
    const other = current ? this._partnerFor(current) : undefined;
    if (!current || !other || !this._canPair(current, other)) return;
    if (!roomForTwo(this.dimensions, false)) return;
    // 左右照页签条上的先后:靠前那枚不挪,另一枚挨过去(对话打头就还在打头、还在左边)。
    const otherFirst = this.tabOrder.indexOf(other) < this.tabOrder.indexOf(current);
    this.pair = { anchor: current, side: other, sideAt: otherFirst ? 'left' : 'right', ratio: null };
    this._placeAdjacent(this.pair, otherFirst ? 'side' : 'anchor');
    this._acceptSplitOf(current, other);
  }

  /** 和 `tabId` 并排的会是哪一页(见 splitBeside)。 */
  private _partnerFor(tabId: string): string | undefined {
    const pair = this.livePair;
    if (pair && tabId === pair.anchor) return pair.side;
    if (pair && tabId === pair.side) return pair.anchor;
    if (pair && this.pairShown) return pair.anchor;
    const shown = this.resolvedActiveTabId;
    if (shown && shown !== tabId) return shown;
    const previous = this._previousActiveTabId;
    if (previous && previous !== tabId && this.entries.has(previous)) return previous;
    const at = this.tabOrder.indexOf(tabId);
    return at === -1 ? undefined : (this.tabOrder[at - 1] ?? this.tabOrder[at + 1]);
  }

  /** 拖中间那条分界:前一页(左 / 上)占几成(两边各守最窄 / 最矮由拖的那一侧按像素卡住)。null = 回到页面自己声明的宽(双击分界)。 */
  setPairRatio(ratio: number | null): void {
    if (!this.pair || (ratio !== null && !Number.isFinite(ratio))) return;
    this.pair = { ...this.pair, ratio: ratio === null ? null : Math.min(0.9, Math.max(0.1, ratio)) };
  }

  /**
   * 前一页(左 / 上)此刻占几成:拖过 = 拖成的那样;没拖过 = 声明了宽的那页(sideWidth,另一页优先)照它的像素、至多一半,
   * 都没声明 = 一半一半(两页对等)。
   */
  get pairShare(): number {
    const pair = this.livePair;
    if (!pair) return 0.5;
    if (pair.ratio !== null) return pair.ratio;
    const extent = isVerticalPairEdge(pair.sideAt) ? this.dimensions?.height : this.dimensions?.width;
    const declared = [pair.side, pair.anchor].map((tabId) => ({ tabId, px: this._sideWidthOf(tabId) })).find((it) => it.px !== undefined);
    if (!declared || !extent) return 0.5;
    const share = Math.min(0.5, declared.px! / extent);
    return declared.tabId === this.pairSlots!.first ? share : 1 - share;
  }

  private _sideWidthOf(tabId: string): number | undefined {
    const entry = this.entries.get(tabId);
    return entry && this.registry.has(entry.kind) ? this.registry.get(entry.kind).sideWidth?.(entry.state as never) : undefined;
  }

  /**
   * 另一页换成 `tabId`:只把新页挪到钉住的那页旁边,其余页签保留相对次序。
   * 被顶下来的是瞄一眼那种就收掉 —— 瞄一眼的意思就是不留(spec session-page「并排」)。
   */
  private _replaceSide(pair: TabPair, tabId: string, closePreview = true): void {
    const old = pair.side;
    if (this.tabOrder[0] === tabId) {
      // 页签条打头那枚(通常是对话)不挪走:它摆到前一格(左 / 上),钉住的那页挨到它后面,被顶下来的留在原处。
      const sideAt: PairEdge = isVerticalPairEdge(pair.sideAt) ? 'top' : 'left';
      const next = { ...pair, side: tabId, sideAt };
      this.pair = { ...next, ratio: this._ratioForNewSide(pair, tabId) === null ? null : ratioKeepingWidths(pair, next) };
      this._placeAdjacent(this.pair, 'side');
    } else {
      this.pair = { ...pair, side: tabId, ratio: this._ratioForNewSide(pair, tabId) };
      this._placeAdjacent(this.pair);
    }
    // 和人点 × 一样先问一句(有没存的东西会问):被否了就留成一枚普通页签,❌ 悄悄扔掉。
    if (closePreview && this.entries.get(old)?.isPreview) void this._requestClose(old, false);
  }

  /**
   * 另一页换成 `tabId`:换进来的(或被顶下来的)那页声明了自己的宽,就照新的这页来,❌ 接着用上一页拖出来的比例;
   * 两页都是对等的(都没声明)才留着拖过的比例。
   */
  private _ratioForNewSide(pair: TabPair, tabId: string): number | null {
    return this._sideWidthOf(tabId) === undefined && this._sideWidthOf(pair.side) === undefined ? pair.ratio : null;
  }

  /** 一对在页签条上挨着,先后和屏上一样(左 / 上那页在前)。`keep` 那枚不动,另一枚挪到它旁边。 */
  private _placeAdjacent(pair: TabPair, keep: 'anchor' | 'side' = 'anchor'): void {
    const order = this._adjacentOrder(this.tabOrder, pair, keep);
    if (order.some((id, i) => id !== this.tabOrder[i])) this.tabOrder = order;
  }

  private _adjacentOrder(current: string[], pair: TabPair, keep: 'anchor' | 'side'): string[] {
    if (!current.includes(pair.anchor) || !current.includes(pair.side)) return current;
    const [fixed, moving] = keep === 'anchor' ? [pair.anchor, pair.side] : [pair.side, pair.anchor];
    const order = current.filter((id) => id !== moving);
    const at = order.indexOf(fixed);
    const movingFirst = sideLeads(pair.sideAt) === (keep === 'anchor');
    order.splice(movingFirst ? at : at + 1, 0, moving);
    return order;
  }

  /** 页签插进来可能落在一对中间:让它们重新挨着。 */
  private _keepPairAdjacent(): void {
    const pair = this.livePair;
    if (pair) this._placeAdjacent(pair);
  }

  private _focus(id: string): void {
    if (this.activeTabId !== id) this._previousActiveTabId = this.activeTabId;
    this.activeTabId = id;
  }

  /** 这一对少了一枚 = 拆开,剩下那枚接着亮(关掉右边那页 → 对话占满)。 */
  private _dropFromPair(id: string): void {
    const pair = this.pair;
    if (!pair || (id !== pair.anchor && id !== pair.side)) return;
    this.pair = null;
    if (this.activeTabId === id) this.activeTabId = id === pair.side ? pair.anchor : pair.side;
  }

  /** All entries of the given kind, in tab-order. */
  entriesOfKind<E extends TabEntry>(kind: string): E[] {
    const result: E[] = [];
    for (const id of this.tabOrder) {
      const entry = this.entries.get(id);
      if (entry?.kind === kind) result.push(entry as unknown as E);
    }
    return result;
  }

  /** 屏上显示着的那一枚这种页签(并排时两枚里种类对得上的那枚;两枚同种 = 点着的那枚)。 */
  activeEntryOfKind<E extends TabEntry>(kind: string): E | undefined {
    const focused = this.entries.get(this.resolvedActiveTabId ?? '');
    if (focused?.kind === kind) return focused as unknown as E;
    for (const id of this.shownTabIds) {
      const entry = this.entries.get(id);
      if (entry?.kind === kind) return entry as unknown as E;
    }
    return undefined;
  }

  /** All resources of the given kind, in tab-order. */
  resourcesOfKind<T extends TabResource>(kind: string): T[] {
    const result: T[] = [];
    for (const id of this.tabOrder) {
      const entry = this.entries.get(id);
      if (entry?.kind !== kind) continue;
      const resource = this._resources.get(id);
      if (resource) result.push(resource as T);
    }
    return result;
  }

  /** Resource of the tab of this kind shown on screen (either half of a pair), if any. */
  activeResourceOfKind<T extends TabResource>(kind: string): T | undefined {
    const entry = this.activeEntryOfKind(kind);
    return entry ? (this._resources.get(entry.tabId) as T | undefined) : undefined;
  }

  /**
   * Find an existing tab entry in this pane matching kind + resourceKey.
   * Only meaningful for single-mount providers; returns undefined for multi providers
   * or when no matching entry exists.
   */
  findSingleMountEntry(kind: string, resourceKey: string): TabEntryImpl | undefined {
    if (!this.registry.has(kind)) return undefined;
    const def = this.registry.get(kind);
    if ((def.mount ?? 'multi') !== 'single') return undefined;
    for (const id of this.tabOrder) {
      const e = this.entries.get(id);
      if (e?.kind === kind && def.resourceKey(e.state as never) === resourceKey) return e;
    }
    return undefined;
  }

  /**
   * Returns true if any tab of the given kind in this pane has the given resourceKey.
   * Used for list-selection queries — reads only observable `tabOrder` + `entries`.
   */
  hasOpenKey(kind: string, key: string): boolean {
    if (!this.registry.has(kind)) return false;
    const def = this.registry.get(kind);
    return this.tabOrder.some((id) => {
      const e = this.entries.get(id);
      return e?.kind === kind && def.resourceKey(e.state as never) === key;
    });
  }

  /**
   * Returns true if the active tab in this pane matches the given kind + resourceKey.
   * Used for list-selection queries.
   */
  activeMatches(kind: string, key: string): boolean {
    const e = this.activeEntryOfKind(kind);
    if (!e || !this.registry.has(kind)) return false;
    return this.registry.get(kind).resourceKey(e.state as never) === key;
  }

  /** Find the first preview entry of a given kind (used for preview retargeting). */
  private _previewEntryOfKind(kind: string): TabEntryImpl | undefined {
    for (const id of this.tabOrder) {
      const e = this.entries.get(id);
      if (e?.kind === kind && e.isPreview) return e;
    }
    return undefined;
  }

  get resolvedTabs(): ResolvedTab[] {
    const result: ResolvedTab[] = [];
    const effectiveActiveId = this.resolvedActiveTabId;
    const shown = this.shownTabIds;
    const slots = this.pairSlots;
    for (const id of this.tabOrder) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      const resource = this._resources.get(id);
      if (!resource) continue;
      result.push({
        kind: entry.kind,
        tabId: id,
        isPreview: entry.isPreview,
        isActive: shown.includes(id),
        isFocused: effectiveActiveId === id,
        pairRole: slots?.first === id ? 'start' : slots?.second === id ? 'end' : undefined,
        resource,
      } as ResolvedTab);
    }
    return result;
  }

  get snapshot(): TabManagerSnapshot {
    const tabs: TabDescriptor[] = [];
    for (const id of this.tabOrder) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      if (this.registry.has(entry.kind)) {
        const provider = this.registry.get(entry.kind);
        if (provider.isPersistent?.(entry.state as never) === false) continue;
      }
      tabs.push(descriptorOf(entry));
    }
    const activeTabId = tabs.some((tab) => tab.tabId === this.activeTabId)
      ? this.activeTabId
      : tabs[0]?.tabId;
    // 用 `pair` 不用 `livePair`:右边那页是 App、App 被停用时它暂时成了占位(livePair 不认),这时存档也得留着这一对,
    // 重新启用回来还是一对;❌ 中途一次自动保存把它永久丢掉。
    const pair = this.pair;
    const savedPair =
      pair && tabs.some((tab) => tab.tabId === pair.anchor) && tabs.some((tab) => tab.tabId === pair.side)
        ? {
            anchorTabId: pair.anchor,
            sideTabId: pair.side,
            ...(pair.ratio === null ? {} : { share: pair.ratio }),
            // 只在不是默认那种(另一页在右)时记,旧存档读回来照旧是左右并排。
            ...(pair.sideAt === 'right' ? {} : { sideAt: pair.sideAt }),
          }
        : undefined;
    return {
      tabs,
      activeTabId,
      ...(savedPair ? { pair: savedPair } : {}),
      ...(this.splitDeclinedKinds.size > 0 ? { splitDeclinedKinds: [...this.splitDeclinedKinds].sort() } : {}),
    };
  }

  /**
   * Open a tab in THIS pane. Skips single-mount cardinality (that is enforced by
   * the layout store before routing here). Handles preview retarget within the pane.
   *
   * `initialState` is the already-computed state from the layout store.
   * `isPreview` comes from the caller's `preview` flag.
   * `overrideState` applies when the layout found a single-mount match in this pane.
   */
  openWithState(
    kind: string,
    initialState: unknown,
    opts?: { isPreview?: boolean; overrideState?: boolean; activate?: boolean; returnTo?: TabReturnTo }
  ): string | undefined {
    const isPreview = opts?.isPreview ?? false;
    const activate = opts?.activate ?? true;

    if (!this.registry.has(kind)) {
      console.warn(`[PaneStore] Unknown tab kind: ${kind}`);
      return undefined;
    }
    const def = this.registry.get(kind);

    // Single-mount dedup: if already open in THIS pane, focus (and optionally update state).
    if ((def.mount ?? 'multi') === 'single') {
      const key = def.resourceKey(initialState as never);
      const existing = this.findSingleMountEntry(kind, key);
      if (existing) {
        if (!isPreview) existing.isPreview = false;
        if (opts?.overrideState) existing.state = initialState;
        if (opts?.returnTo) existing.returnTo = opts.returnTo;
        if (activate) this.setActiveTab(existing.tabId);
        return existing.tabId;
      }
    }

    // Preview retarget: replace the existing preview for this kind, if any.
    if (isPreview) {
      const previewEntry = this._previewEntryOfKind(kind);
      if (previewEntry) {
        this.retargetEntry(previewEntry.tabId, { state: initialState, isPreview: true, returnTo: opts?.returnTo });
        // 不抢的打开(开在对话旁边)也走到这里:原地换了内容,但不切过去(spec session-page「并排」)。
        if (activate) this.setActiveTab(previewEntry.tabId);
        return previewEntry.tabId;
      }
    }

    // Fresh tab.
    const tabId = crypto.randomUUID();
    const entry = new TabEntryImpl(kind, tabId, isPreview, initialState, opts?.returnTo);
    this._attachEntryAndInitialize(entry, { activate });
    return this.entries.has(tabId) ? tabId : undefined;
  }

  /**
   * Untyped open used by resources (via handle.open) and internal callers.
   * Delegates to the layout opener if available (handles cardinality + routing),
   * falling back to computing state and opening directly in this pane.
   */
  openKind(kind: string, args: Record<string, unknown>, config?: TabOpenOptions): void {
    if (this._layoutOpener) {
      this._layoutOpener(kind, args, config);
    } else {
      // Fallback: compute state and open directly in this pane.
      if (!this.registry.has(kind)) return;
      const def = this.registry.get(kind);
      const state: unknown = def.onBeforeOpen
        ? def.onBeforeOpen(args as never, this._ctx)
        : (args as unknown);
      if (state === null) return;
      this.openWithState(kind, state, {
        isPreview: !!config?.preview,
        overrideState: !!config?.overrideState,
        returnTo: config?.returnTo,
      });
    }
  }

  /**
   * Typed open for direct PaneStore consumers (e.g. PaneLayoutStore routing into a pane).
   */
  open<K extends KindOf<R>>(kind: K, args: OpenArgsOf<R, K>, config?: TabOpenOptions): void {
    this.openKind(kind as string, args, config);
  }

  closeTab(id: string): void {
    this._removeTab(id);
  }

  returnToOf(tabId: string): TabReturnTo | undefined {
    return this.entries.get(tabId)?.returnTo;
  }

  closeActiveTab(): void {
    if (!this.activeTabId) return;
    this.requestCloseTab(this.activeTabId);
  }

  /**
   * 亮起一枚页签(点页签、键盘切换、新开的页签都经过这里)。spec session-page「并排」的那条规矩就在这儿:
   * 屏上正并排时,钉住的那页不动 —— 亮起一枚不在这对里的,它顶替另一页、原来那页退下;屏上只有一页时照旧换成它。
   * 亮起这一对里的任一枚 = 那一边拿到焦点,并排照旧。用户拆开过的那一类不顶替,自己占满这一格(这一对留着)。
   */
  setActiveTab(id: string): void {
    const pair = this.livePair;
    if (pair && id !== pair.anchor && id !== pair.side && this.pairShown && !this.splitDeclinedFor(id) && this._canPair(pair.anchor, id)) {
      this._replaceSide(pair, id);
    }
    this._focus(id);
  }

  reorderTabs(fromIndex: number, toIndex: number): void {
    this.tabOrder = this.previewTabOrder(fromIndex, toIndex);
  }

  /** The strip previews this exact move while dragging; persistence changes only on drop. */
  previewTabOrder(fromIndex: number, toIndex: number): string[] {
    const dragged = this.tabOrder[fromIndex];
    const next: TabOrderState = { tabOrder: [...this.tabOrder], activeTabId: this.activeTabId };
    if (dragged === undefined || toIndex < 0 || toIndex >= next.tabOrder.length) return next.tabOrder;
    reorderTabIds(next, fromIndex, toIndex);
    // 一对始终挨着(照 Chrome):拖其中一枚,它落在松手处、另一枚跟过去 —— 要拆开走两枚中间那颗钮、右键「拆开」或 ⌘\。
    const pair = this.livePair;
    return pair ? this._adjacentOrder(next.tabOrder, pair, dragged === pair.side ? 'side' : 'anchor') : next.tabOrder;
  }

  setNextTabActive(): void {
    this._activateBy(tabUtilsSetNextTabActive);
  }

  setPreviousTabActive(): void {
    this._activateBy(tabUtilsSetPreviousTabActive);
  }

  setTabActiveIndex(index: number): void {
    this._activateBy((state) => tabUtilsSetTabActiveIndex(state, index));
  }

  /** 键盘切页签同样经过 setActiveTab,和点一下是同一条规矩。 */
  private _activateBy(step: (state: TabOrderState) => void): void {
    const probe: TabOrderState = { tabOrder: this.tabOrder, activeTabId: this.activeTabId };
    step(probe);
    if (probe.activeTabId && probe.activeTabId !== this.activeTabId) this.setActiveTab(probe.activeTabId);
  }

  pin(tabId: string): void {
    const entry = this.entries.get(tabId);
    if (entry) entry.isPreview = false;
  }

  closeOthers(tabId: string): void {
    void this._requestCloseInTurn(this.tabOrder.filter((id) => id !== tabId));
  }

  canSplitTab(tabId: string): boolean {
    return this.inSplitLayout && this.pairSplitBlocked(tabId, 'right') === null;
  }

  tabFill(tabId: string, multiBlock = false): { full: boolean; toggle: () => void } | null {
    const full = tabFullscreen.isOn(this, tabId);
    const pair = this.livePair;
    // 只有一块时,对话那一枚(并排的锚)照旧没有这颗钮:全屏它只等于把旁边那页藏起来。
    const paired = !!pair && this.pairShown && tabId === pair.side;
    if (!full && !paired && !multiBlock) return null;
    return { full, toggle: () => runInAction(() => { this._focus(tabId); tabFullscreen.toggle(this, tabId); }) };
  }

  tabWindowOpener(tabId: string): (() => void) | null {
    return this._layoutSplitter?.windowOpener?.(tabId) ?? null;
  }

  tabSplitBlocked(tabId: string, edge: 'right' | 'bottom'): 'full' | 'only-tab' | 'too-small' | null {
    return this.pairSplitBlocked(tabId, edge);
  }

  /** 能分屏的地方(会话那一块);单独成窗的那一格只装一枚页签,不分。 */
  get inSplitLayout(): boolean {
    return this._layoutSplitter !== null;
  }

  tabMoveToOtherPane(tabId: string): (() => void) | null {
    return this._layoutSplitter?.moveToOtherPane?.(tabId) ?? null;
  }

  /** 页签右键「向右分 / 向下分」= 和屏上那页并排(spec session-page「并排」),❌ 再分出一格带自己的页签条。 */
  splitTab(tabId: string, edge: 'right' | 'bottom'): void {
    this.splitBeside(tabId, edge);
  }

  /** 关闭右侧页签:这一枚右边的都关掉(照 VS Code / Chrome)。 */
  closeToRight(tabId: string): void {
    const index = this.tabOrder.indexOf(tabId);
    if (index < 0) return;
    void this._requestCloseInTurn(this.tabOrder.slice(index + 1));
  }

  /** 关闭全部页签。最后一枚关掉,这一格跟着关掉(由布局的自动关闭接)。 */
  closeAll(): void {
    void this._requestCloseInTurn([...this.tabOrder]);
  }

  /**
   * 一次关一排,也一枚一枚问:有没存的文件就停下来等那一问答完再关下一枚 —— 同时弹几个确认框,
   * 后一个会把前一个顶掉,被顶掉的那枚就永远等不到回答。❌ 直接强关:那会把没存的修改悄悄扔掉。
   */
  private async _requestCloseInTurn(tabIds: readonly string[]): Promise<void> {
    for (const id of tabIds) await this._requestClose(id, false);
  }

  /** 关掉这几枚(一枚一枚问,同一排):会话那枚问过「会话和页签都关」之后,替它把别的页签关掉。 */
  requestCloseTabs(tabIds: readonly string[]): Promise<void> {
    return this._requestCloseInTurn(tabIds);
  }

  requestRename(tabId: string): void {
    this.renameRequest = { tabId, nonce: (this.renameRequest?.nonce ?? 0) + 1 };
  }

  clearRenameRequest(): void {
    this.renameRequest = null;
  }

  commitRename(tabId: string, name: string): void {
    const entry = this.entries.get(tabId);
    if (!entry || !this.registry.has(entry.kind)) return;
    const def = this.registry.get(entry.kind);
    const resource = this._resources.get(tabId);
    if (!resource || !def.commands?.rename) return;
    def.commands.rename.exec(resource, name);
  }

  /**
   * Signals inline rename of the active tab when its kind supports it.
   * Returns true when a renamable tab was signalled, false otherwise.
   */
  renameActiveTab(): boolean {
    const id = this.resolvedActiveTabId;
    if (!id) return false;
    const entry = this.entries.get(id);
    if (!entry || !this.registry.has(entry.kind)) return false;
    if (!this.registry.get(entry.kind).commands?.rename) return false;
    this.requestRename(id);
    return true;
  }

  setContentFocuser(focuser: (() => void) | null): void {
    this._contentFocuser = focuser;
  }

  focusActiveContent(): void {
    const focuser = this._contentFocuser;
    if (!focuser) return;
    requestAnimationFrame(() => focuser());
  }

  /** User-initiated close — calls onBeforeClose if defined, then closes on confirm. */
  requestCloseTab(tabId: string): void {
    void this._requestClose(tabId);
  }

  private _requestClose(tabId: string, alone = true): Promise<void> {
    const entry = this.entries.get(tabId);
    if (!entry) return Promise.resolve();
    const resource = this._resources.get(tabId);

    if (resource && this.registry.has(entry.kind)) {
      const def = this.registry.get(entry.kind);
      if (def.onBeforeClose) {
        return Promise.resolve(def.onBeforeClose(entry as never, resource as never, this._ctx, { alone })).then(
          (proceed) => {
            if (proceed) runInAction(() => this._removeTab(tabId));
          }
        );
      }
    }

    // 一排关的时候第二枚起是在 await 之后跑的,已经出了调用方的 action。
    runInAction(() => this._removeTab(tabId));
    return Promise.resolve();
  }

  /** Fire resource.onActivateIntent() for a tab (called on hover/focus intent). */
  signalActivateIntent(tabId: string): void {
    const resource = this._resources.get(tabId);
    resource?.onActivateIntent?.();
  }

  setDimensions(width: number, height: number): void {
    this.dimensions = { width, height };
  }

  restoreSnapshot(snapshot: Partial<TabManagerSnapshot>): void {
    if (snapshot.tabs) {
      // Dispose all current entries.
      for (const id of [...this.tabOrder]) {
        this._disposeEntry(id);
      }
      this.entries.clear();
      this._resources.clear();
      this.tabOrder = [];

      // Re-initialize from snapshot.
      for (const desc of snapshot.tabs) {
        const { kind, tabId, isPreview, state, returnTo } = stateFromDescriptor(desc);
        const entry = new TabEntryImpl(kind, tabId, isPreview, state, returnTo);
        if (this.registry.has(kind)) {
          this._attachEntryAndInitialize(entry, { activate: false });
        } else {
          this._attachUnavailableEntry(entry);
        }
      }
      // 存下来的一对照原样回来;那枚页签这回没认出来(App 还没登记),livePair 不认它,登记上了又是一对。
      const pair = snapshot.pair;
      this.pair = pair
        ? { anchor: pair.anchorTabId, side: pair.sideTabId, sideAt: pair.sideAt ?? 'right', ratio: pair.share ?? null }
        : null;
      // 合成一条页签条的旧存档里,两格屏上那两页不一定挨着:读回来就让它们挨着(一对在页签条上始终连着)。
      if (this.pair) this._placeAdjacent(this.pair);
      // 10-28 之前存的是一个不分类型的 splitDeclined:来源混着(多半是从前的「最大化」和浮出会话留下的),直接不读。
      this.splitDeclinedKinds.clear();
      for (const kind of Array.isArray(snapshot.splitDeclinedKinds) ? snapshot.splitDeclinedKinds : []) {
        if (typeof kind === 'string') this.splitDeclinedKinds.add(kind);
      }
    }
    if (snapshot.activeTabId !== undefined) this.activeTabId = snapshot.activeTabId;
  }

  dispose(): void {
    this._onActivateDisposer();
    this._providerRegisteredDisposer();
    this._providerUnregisteredDisposer();
    this._kindClosedDisposer();
    for (const id of [...this.tabOrder]) {
      this._disposeEntry(id);
    }
  }

  /**
   * Detaches an entry and its resource from this pane WITHOUT calling dispose.
   * Used by moveTab — the resource survives unchanged.
   * Returns { entry, resource } or undefined if not found.
   */
  detachTab(id: string): { entry: TabEntryImpl; resource: TabResource } | undefined {
    const entry = this.entries.get(id);
    const resource = this._resources.get(id);
    if (!entry || !resource) return undefined;

    // 挪走(单独成窗)= 从这一对里拿出来,剩下那枚占满(spec session-page「并排」)。
    this._dropFromPair(id);
    this.entries.delete(id);
    this._resources.delete(id);
    removeTabId(this, id);
    return { entry, resource };
  }

  /**
   * Adopts a detached entry+resource from another pane WITHOUT calling initialize.
   * Used by moveTab — the resource continues with no lifecycle transition.
   */
  adoptEntry(
    entry: TabEntryImpl,
    resource: TabResource,
    opts?: { insertBeforeTabId?: string; activate?: boolean }
  ): void {
    this.entries.set(entry.tabId, entry);
    this._resources.set(entry.tabId, resource);
    const insertIdx = opts?.insertBeforeTabId ? this.tabOrder.indexOf(opts.insertBeforeTabId) : -1;
    if (insertIdx === -1) {
      this.tabOrder.push(entry.tabId);
    } else {
      this.tabOrder.splice(insertIdx, 0, entry.tabId);
    }
    this._keepPairAdjacent();
    if (opts?.activate ?? false) this.setActiveTab(entry.tabId);
  }

  /**
   * Replaces an existing entry's state in-place without changing tabId.
   * Used by the generic open for preview retargeting:
   *   1. Dispose the old resource.
   *   2. Create a new entry with the new state at the same tabId slot.
   *   3. Initialize the new resource.
   */
  retargetEntry(tabId: string, update: { state: unknown; isPreview?: boolean; returnTo?: TabReturnTo }): void {
    const oldEntry = this.entries.get(tabId);
    if (!oldEntry) return;

    // Dispose old resource.
    this._disposeEntry(tabId);
    this._resources.delete(tabId);

    // Create new entry at same slot.
    const newEntry = new TabEntryImpl(
      oldEntry.kind,
      tabId,
      update.isPreview ?? oldEntry.isPreview,
      update.state,
      update.returnTo
    );
    this.entries.set(tabId, newEntry);

    // Initialize new resource.
    if (this.registry.has(newEntry.kind)) {
      const def = this.registry.get(newEntry.kind);
      const resource = def.initialize(newEntry as never, this._buildHandle(newEntry), this._ctx);
      this._resources.set(tabId, resource);
    }
  }

  reopenClosedTab(): void {
    const record = this._closedTabHistory.pop();
    if (!record) return;
    const { desc, index } = record;
    const { kind, tabId, isPreview, state, returnTo } = stateFromDescriptor(desc);
    if (!this.registry.has(kind)) return;
    const entry = new TabEntryImpl(kind, tabId, isPreview, state, returnTo);
    const def = this.registry.get(kind);
    const resource = def.initialize(entry as never, this._buildHandle(entry), this._ctx);
    this.entries.set(entry.tabId, entry);
    this._resources.set(entry.tabId, resource);
    const insertAt = Math.min(index, this.tabOrder.length);
    this.tabOrder.splice(insertAt, 0, entry.tabId);
    this._keepPairAdjacent();
    this.setActiveTab(entry.tabId);
  }

  private _attachEntryAndInitialize(entry: TabEntryImpl, opts?: { activate?: boolean }): void {
    if (!this.registry.has(entry.kind)) {
      console.warn(`[PaneStore] No provider for kind: ${entry.kind}`);
      return;
    }
    const def = this.registry.get(entry.kind);
    const resource = def.initialize(entry as never, this._buildHandle(entry), this._ctx);
    this.entries.set(entry.tabId, entry);
    this._resources.set(entry.tabId, resource);
    addTabId(this, entry.tabId);
    if (opts?.activate) this.setActiveTab(entry.tabId);
  }

  private _attachUnavailableEntry(entry: TabEntryImpl): void {
    this.entries.set(entry.tabId, entry);
    this._resources.set(entry.tabId, createUnavailableTabResource());
    addTabId(this, entry.tabId);
  }

  private _removeTab(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;

    // Record for reopen history before removing.
    const index = this.tabOrder.indexOf(id);
    const persistent =
      !this.registry.has(entry.kind) ||
      this.registry.get(entry.kind).isPersistent?.(entry.state as never) !== false;
    if (persistent) this._closedTabHistory.push({ desc: descriptorOf(entry), index });
    if (this._closedTabHistory.length > PaneStore._MAX_CLOSED_HISTORY) {
      this._closedTabHistory.shift();
    }

    const returnId = entry.returnTo?.tabId;
    if (returnId && returnId !== id && this.entries.has(returnId) && this.shownTabIds.includes(id)) {
      const pair = this.livePair;
      if (pair && this.pairShown && returnId !== pair.anchor && returnId !== pair.side && this._canPair(pair.anchor, returnId)) {
        // As when selecting the previous page; this close already owns the outgoing preview's disposal.
        this._replaceSide(pair, returnId, false);
      }
      this._focus(returnId);
    }
    this._dropFromPair(id);
    this._disposeEntry(id);
    this.entries.delete(id);
    this._resources.delete(id);
    removeTabId(this, id);
  }

  /** Call provider.dispose() for an entry if its resource exists. Does NOT remove from maps. */
  private _disposeEntry(id: string): void {
    const entry = this.entries.get(id);
    const resource = this._resources.get(id);
    if (!entry || !resource) return;
    if (this.registry.has(entry.kind) && !isUnavailableTabResource(resource)) {
      this.registry.get(entry.kind).dispose(entry as never, resource as never, this._ctx);
    }
    resource.dispose();
  }

  /** Builds the TabHandle interface for an entry. */
  private _buildHandle(entry: TabEntryImpl): TabHandle {
    return {
      tabId: entry.tabId,
      pin: action(() => {
        entry.isPreview = false;
      }),
      close: (opts?: { force?: boolean }): Promise<boolean> => {
        if (opts?.force) {
          runInAction(() => this._removeTab(entry.tabId));
          return Promise.resolve(true);
        }
        // User-style close: run onBeforeClose veto.
        const entryRef = this.entries.get(entry.tabId);
        if (!entryRef) return Promise.resolve(false);
        const resource = this._resources.get(entry.tabId);
        if (resource && this.registry.has(entryRef.kind)) {
          const def = this.registry.get(entryRef.kind);
          if (def.onBeforeClose) {
            return Promise.resolve(
              def.onBeforeClose(entryRef as never, resource as never, this._ctx, { alone: false })
            ).then((proceed) => {
              if (proceed) runInAction(() => this._removeTab(entry.tabId));
              return proceed;
            });
          }
        }
        runInAction(() => this._removeTab(entry.tabId));
        return Promise.resolve(true);
      },
      open: (
        kind: string,
        args: Record<string, unknown>,
        config?: { target?: unknown; preview?: boolean; overrideState?: boolean }
      ) => {
        this.openKind(kind, args, config as TabOpenOptions | undefined);
      },
    };
  }
}
