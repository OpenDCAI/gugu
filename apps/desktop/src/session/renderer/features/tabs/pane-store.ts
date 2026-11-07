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
  type TabHistorySnapshot,
  type TabPageSnapshot,
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

/** Serialize only navigation and provider state; obsolete preview/companion metadata is never written. */
function descriptorOf(entry: TabEntry): TabDescriptor {
  const state = toJS(entry.state) as Record<string, unknown>;
  const navigation = {
    ...(entry.history ? { history: toJS(entry.history) } : {}),
    ...(entry.openerTabId ? { openerTabId: entry.openerTabId } : {}),
  };
  return isBuiltInTabKind(entry.kind)
    ? { ...state, kind: entry.kind, tabId: entry.tabId, ...navigation } as BuiltInTabDescriptor
    : { kind: 'extension', extensionKind: entry.kind, tabId: entry.tabId, state, ...navigation };
}

/** Old snapshots are read at this boundary; their preview/return metadata has no runtime meaning. */
function stateFromDescriptor(desc: TabDescriptor): TabPageSnapshot & { tabId: string; history?: TabHistorySnapshot; openerTabId?: string } {
  const metadata = { tabId: desc.tabId, history: desc.history, openerTabId: desc.openerTabId };
  if (desc.kind === 'extension') return { ...metadata, kind: desc.extensionKind, state: desc.state ?? {} };
  const state: Record<string, unknown> = { ...desc };
  for (const key of ['kind', 'tabId', 'history', 'companionPaneId', 'openerTabId', 'isPreview', 'returnTo']) delete state[key];
  return { ...metadata, kind: desc.kind, state };
}

class TabEntryImpl<S = unknown> implements TabEntry<S> {
  history?: TabHistorySnapshot;
  openerTabId?: string;
  navigationRequest = 0;
  constructor(readonly kind: string, readonly tabId: string, public state: S) {
    makeObservable(this, { state: observable, history: observable.ref, openerTabId: observable });
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
 * What a pane inside a layout can ask of it. 并排(spec session-page「并排」)is the layout's: one strip for the session,
 * the side of a pair in a pane of its own (PaneLayoutStore `@@@pair`).
 */
export interface PaneSplitter {
  tabClosing?(entry: TabEntry): void;
  /** A tab left this pane for good; `wasActive`: it was the one in front. */
  tabRemoved?(tabId: string, wasActive: boolean): void;
  /** A tab is being brought forward; true = the layout placed it (it replaced the side of the pair). */
  activating?(tabId: string): boolean;
  /** 这一枚能不能单独成窗,能的话怎么开(会话自己那枚 = 整个会话,App 那枚 = 这个 App,别的附页 = 这一枚)。 */
  windowOpener?(tabId: string): (() => void) | null;
  /** 向右分 / ⌘\: this tab side by side with the page looked at before it. */
  split(tabId: string): void;
  /** 为什么分不出来;null = 分得出来。 */
  splitBlocked(tabId: string): 'only-tab' | 'too-small' | null;
  revealTab?(tabId: string): boolean;
  /** Whether a tab is showing now, beside this one or in front. */
  isOnScreen?(tabId: string): boolean;
  entryForTab?(tabId: string): TabEntry | undefined;
  hasSibling?(): boolean;
  isFocusedPane?(): boolean;
  /** This tab's place in the pair on the strip ('start' = left), undefined = not in the pair. */
  pairRole?(tabId: string): 'start' | 'end' | undefined;
  /** The side pane, drawn joined into this pane's strip (only for the main pane while paired). */
  pairSide?(): { paneId: string; pane: PaneStore } | undefined;
  /** This pane is the side of a pair: its tab is drawn in the main pane's strip, it has no strip of its own. */
  isSide?(): boolean;
  /** 拆开. */
  separatePair?(): void;
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
  /** Current pixel dimensions of the pane container, null until first measurement. */
  dimensions: { width: number; height: number } | null = null;
  /** The tab that had focus before the one in front: 向右分 / ⌘\ put the one in front beside it. */
  private _previousActiveTabId: string | undefined = undefined;

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
    | ((kind: string, args: Record<string, unknown>, config: TabOpenOptions) => void)
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
      layoutOpener?: (kind: string, args: Record<string, unknown>, config: TabOpenOptions) => void;
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
      shownTabIds: computed,
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
      toggleSplit: action,
      closeOthers: action,
      closeToRight: action,
      closeAll: action,
      requestCloseTab: action,
      reopenClosedTab: action,
      restoreSnapshot: action,
      detachTab: action,
      adoptEntry: action,
      navigate: action,
      go: action,
      goTo: action,
      setPageViewState: action,
      renameRequest: observable,
      requestRename: action,
      clearRenameRequest: action,
      commitRename: action,
    });

    // Fire onActivate() whenever the active visible resource instance changes.
    // Tracking the resource instance (not just the tab id) ensures onActivate()
    // fires after navigation, where _showPage() swaps in a new
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
   * The entry object is reused, so tabId, order and persisted
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
   * The entry object is reused, so tabId, order and persisted state
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

  /** Each real pane shows its active navigation context. */
  get shownTabIds(): readonly string[] {
    const active = this.resolvedActiveTabId;
    return active ? [active] : [];
  }

  private _focus(id: string): void {
    if (this.activeTabId && this.activeTabId !== id) this._previousActiveTabId = this.activeTabId;
    this.activeTabId = id;
  }

  get previousActiveTabId(): string | undefined {
    const id = this._previousActiveTabId;
    return id && this.entries.has(id) ? id : undefined;
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

  get resolvedTabs(): ResolvedTab[] {
    const result: ResolvedTab[] = [];
    const effectiveActiveId = this.resolvedActiveTabId;
    const shown = this.shownTabIds;
    for (const id of this.tabOrder) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      const resource = this._resources.get(id);
      if (!resource) continue;
      result.push({
        kind: entry.kind,
        tabId: id,
        isActive: shown.includes(id),
        isFocused: effectiveActiveId === id,
        pairRole: this._layoutSplitter?.pairRole?.(id),
        resource,
      } as ResolvedTab);
    }
    return result;
  }

  get snapshot(): TabManagerSnapshot {
    const tabs = this.tabOrder.flatMap((id) => {
      const entry = this.entries.get(id);
      const descriptor = entry && this._persistentDescriptor(entry);
      return descriptor ? [descriptor] : [];
    });
    return { tabs, activeTabId: tabs.some((tab) => tab.tabId === this.activeTabId) ? this.activeTabId : tabs[0]?.tabId };
  }

  private _persistentDescriptor(entry: TabEntry): TabDescriptor | undefined {
    const history = this.navigationOf(entry.tabId)!;
    const retained = history.pages.map((page, index) => ({ page, index })).filter(({ page }) => !this.registry.has(page.kind) || this.registry.get(page.kind).isPersistent?.(page.state as never) !== false);
    if (!retained.length) return undefined;
    const index = Math.max(0, retained.findLastIndex((page) => page.index <= history.index));
    const page = retained[index].page;
    return descriptorOf({ ...entry, kind: page.kind, state: page.state, history: entry.history ? { pages: retained.map(({ page }) => page), index } : undefined });
  }

  /** Open a fresh navigation context in this pane from normalized provider state. */
  openWithState(kind: string, initialState: unknown, opts?: { activate?: boolean; after?: string; openerTabId?: string }): string | undefined {
    if (!this.registry.has(kind)) return undefined;
    const tabId = crypto.randomUUID();
    const entry = new TabEntryImpl(kind, tabId, initialState);
    entry.openerTabId = opts?.openerTabId;
    this._attachEntryAndInitialize(entry, { activate: false });
    const origin = opts?.after;
    const at = origin ? this.tabOrder.indexOf(origin) : -1;
    if (at !== -1) {
      const order = this.tabOrder.filter((id) => id !== tabId);
      order.splice(at + 1, 0, tabId);
      this.tabOrder = order;
    }
    if (opts?.activate ?? true) this.setActiveTab(tabId);
    return tabId;
  }

  /**
   * Untyped open used by resources (via handle.open) and internal callers.
   * Delegates to the layout opener if available (handles cardinality + routing),
   * falling back to computing state and opening directly in this pane.
   */
  openKind(kind: string, args: Record<string, unknown>, config?: Partial<TabOpenOptions>): void {
    const from = config?.from === undefined ? this.resolvedActiveTabId ?? null : config.from;
    if (this._layoutOpener) {
      this._layoutOpener(kind, args, { ...config, from, intent: config?.intent ?? 'navigate' });
      return;
    }
    if (!this.registry.has(kind)) return;
    const def = this.registry.get(kind);
    const state = def.onBeforeOpen ? def.onBeforeOpen(args as never, this._ctx) : args;
    if (state === null) return;
    if (from && (config?.intent ?? 'navigate') === 'navigate') this.navigate(from, kind, state);
    else this.openWithState(kind, state, { activate: config?.activate, after: from ?? undefined, openerTabId: from ?? undefined });
  }

  /**
   * Typed open for direct PaneStore consumers (e.g. PaneLayoutStore routing into a pane).
   */
  open<K extends KindOf<R>>(kind: K, args: OpenArgsOf<R, K>, config?: Partial<TabOpenOptions>): void {
    this.openKind(kind as string, args, config);
  }

  closeTab(id: string): void {
    this._removeTab(id);
  }


  /** Read the current page without manufacturing a second tab identity. */
  navigationOf(tabId: string): TabHistorySnapshot | undefined {
    const entry = this.entries.get(tabId);
    return entry?.history ?? (entry ? { pages: [{ kind: entry.kind, state: toJS(entry.state) }], index: 0 } : undefined);
  }

  setPageViewState(tabId: string, viewState: Record<string, unknown>): void {
    const entry = this.entries.get(tabId);
    const history = this.navigationOf(tabId);
    if (!entry || !history) return;
    const pages = [...history.pages];
    pages[history.index] = { kind: entry.kind, state: toJS(entry.state), viewState: toJS(viewState) };
    entry.history = { pages, index: history.index };
  }

  navigate(tabId: string, kind: string, state: unknown): void {
    const entry = this.entries.get(tabId);
    const history = this.navigationOf(tabId);
    if (!entry || !history || !this.registry.has(kind)) return;
    if (entry.kind === kind && this.registry.get(kind).resourceKey(entry.state as never) === this.registry.get(kind).resourceKey(state as never)) return;
    this._beforeNavigate(entry, () => {
      const pages = history.pages.slice(0, history.index + 1);
      pages[history.index] = { ...pages[history.index], kind: entry.kind, state: toJS(entry.state) };
      pages.push({ kind, state });
      this._showPage(entry, { pages, index: pages.length - 1 });
    });
  }

  go(tabId: string, delta: -1 | 1): Promise<boolean> {
    const entry = this.entries.get(tabId);
    const history = this.navigationOf(tabId);
    if (!entry || !history) return Promise.resolve(false);
    if (!history.pages[history.index + delta]) {
      if (delta === -1 && entry.openerTabId) {
        if (this.entries.has(entry.openerTabId)) {
          this.setActiveTab(entry.openerTabId);
          this.focusActiveContent();
          return Promise.resolve(true);
        }
        return Promise.resolve(this._layoutSplitter?.revealTab?.(entry.openerTabId) ?? false);
      }
      return Promise.resolve(false);
    }
    return this.goTo(tabId, history.index + delta);
  }

  goTo(tabId: string, index: number): Promise<boolean> {
    const entry = this.entries.get(tabId);
    const history = this.navigationOf(tabId);
    if (!entry || !history?.pages[index] || index === history.index) return Promise.resolve(false);
    return this._beforeNavigate(entry, () => {
      const pages = [...history.pages];
      pages[history.index] = { ...pages[history.index], kind: entry.kind, state: toJS(entry.state) };
      this._showPage(entry, { pages, index });
    });
  }

  openerOf(tabId: string): TabEntry | undefined {
    const id = this.entries.get(tabId)?.openerTabId;
    return id ? this.entries.get(id) ?? this._layoutSplitter?.entryForTab?.(id) : undefined;
  }

  canGo(tabId: string, delta: -1 | 1): boolean {
    const history = this.navigationOf(tabId);
    if (history?.pages[history.index + delta]) return true;
    // The tab it was opened from, unless that is on screen already (beside it): going there would change nothing.
    const opener = delta === -1 ? this.openerOf(tabId) : undefined;
    return !!opener && !this._layoutSplitter?.isOnScreen?.(opener.tabId);
  }

  private _beforeNavigate(entry: TabEntryImpl, apply: () => void): Promise<boolean> {
    const request = ++entry.navigationRequest;
    const resource = this._resources.get(entry.tabId);
    const def = this.registry.has(entry.kind) ? this.registry.get(entry.kind) : undefined;
    const allowed = resource && def?.onBeforeClose
      ? def.onBeforeClose(entry as never, resource as never, this._ctx, { alone: false, navigation: true })
      : true;
    const finish = (proceed: boolean): boolean => {
      if (!proceed || entry.navigationRequest !== request || this.entries.get(entry.tabId) !== entry) return false;
      runInAction(apply);
      return true;
    };
    return typeof allowed === 'boolean' ? Promise.resolve(finish(allowed)) : allowed.then(finish);
  }

  private _showPage(oldEntry: TabEntryImpl, history: TabHistorySnapshot): void {
    const page: TabPageSnapshot = history.pages[history.index];
    this._disposeEntry(oldEntry.tabId);
    const entry = new TabEntryImpl(page.kind, oldEntry.tabId, page.state);
    entry.history = history;
    entry.openerTabId = oldEntry.openerTabId;
    this.entries.set(entry.tabId, entry);
    this._resources.set(entry.tabId, this.registry.has(entry.kind)
      ? this.registry.get(entry.kind).initialize(entry as never, this._buildHandle(entry), this._ctx)
      : createUnavailableTabResource());
  }

  closeActiveTab(): void {
    if (!this.activeTabId) return;
    this.requestCloseTab(this.activeTabId);
  }

  /**
   * 亮起一枚页签(点页签、键盘切换、新开的页签都经过这里)。spec session-page「并排」的那条规矩就在这儿:
   * 屏上正并排时,钉住的那页不动 —— 亮起一枚不在这对里的,它顶替另一页、原来那页退回页签条(布局做,`activating`);
   * 屏上只有一页时照旧换成它。亮起这一对里的任一枚 = 那一边拿到焦点,并排照旧。
   */
  setActiveTab(id: string): void {
    if (!this.entries.has(id) || this._layoutSplitter?.activating?.(id)) return;
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
    return next.tabOrder;
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


  closeOthers(tabId: string): void {
    void this._requestCloseInTurn(this.tabOrder.filter((id) => id !== tabId));
  }

  /** 这一格是不是它那个布局里握着焦点的那格;单独成窗的那一格只有它自己。 */
  get isFocused(): boolean {
    return this._layoutSplitter?.isFocusedPane?.() ?? true;
  }

  tabFill(tabId: string, multiBlock = false): { full: boolean; toggle: () => void } | null {
    const full = tabFullscreen.isOn(this, tabId);
    if (!full && !multiBlock && !this._layoutSplitter?.hasSibling?.()) return null;
    return { full, toggle: () => runInAction(() => { this.setActiveTab(tabId); tabFullscreen.toggle(this, tabId); }) };
  }

  tabWindowOpener(tabId: string): (() => void) | null {
    return this._layoutSplitter?.windowOpener?.(tabId) ?? null;
  }

  tabSplitBlocked(tabId: string): 'only-tab' | 'too-small' | null {
    // 布局说的 null 就是「分得出来」,原样交出去。没有布局(单独成窗那一格)菜单里这一项本就灰着。
    return this._layoutSplitter ? this._layoutSplitter.splitBlocked(tabId) : 'only-tab';
  }

  /** 能分屏的地方(会话那一块);单独成窗的那一格只装一枚页签,不分。 */
  get inSplitLayout(): boolean {
    return this._layoutSplitter !== null;
  }

  /** 页签右键「向右分」:这一枚和屏上那页并排。 */
  splitTab(tabId: string): void {
    this._layoutSplitter?.split(tabId);
  }

  /** ⌘\: paired = 拆开; else the tab in front side by side with the page looked at before it. */
  toggleSplit(): void {
    if (this._layoutSplitter?.pairRole?.(this.resolvedActiveTabId ?? '')) this.separatePair();
    else if (this.resolvedActiveTabId) this.splitTab(this.resolvedActiveTabId);
  }

  /** 拆开(spec session-page「并排」,照 Chrome「Separate views」):两枚都变回普通页签,点着的那枚占满。 */
  separatePair(): void {
    this._layoutSplitter?.separatePair?.();
  }

  /** The side pane drawn joined into this strip, while this is the main pane of a pair. */
  get pairSide(): { paneId: string; pane: PaneStore } | undefined {
    return this._layoutSplitter?.pairSide?.();
  }

  /** This pane holds the side of a pair: it has no strip of its own. */
  get isPairSide(): boolean {
    return this._layoutSplitter?.isSide?.() ?? false;
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
      for (const id of [...this.tabOrder]) this._disposeEntry(id);
      this.entries.clear();
      this._resources.clear();
      this.tabOrder = [];
      for (const desc of snapshot.tabs) {
        const { kind, tabId, state, history, openerTabId } = stateFromDescriptor(desc);
        const entry = new TabEntryImpl(kind, tabId, state);
        entry.history = history;
        entry.openerTabId = openerTabId;
        if (this.registry.has(kind)) this._attachEntryAndInitialize(entry, { activate: false });
        else this._attachUnavailableEntry(entry);
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
    if (opts?.activate ?? false) this.setActiveTab(entry.tabId);
  }

  reopenClosedTab(): void {
    const record = this._closedTabHistory.pop();
    if (!record) return;
    const { desc, index } = record;
    const { kind, tabId, state, history, openerTabId } = stateFromDescriptor(desc);
    if (!this.registry.has(kind)) return;
    const entry = new TabEntryImpl(kind, tabId, state);
    entry.history = history;
    entry.openerTabId = openerTabId;
    const def = this.registry.get(kind);
    const resource = def.initialize(entry as never, this._buildHandle(entry), this._ctx);
    this.entries.set(entry.tabId, entry);
    this._resources.set(entry.tabId, resource);
    const insertAt = Math.min(index, this.tabOrder.length);
    this.tabOrder.splice(insertAt, 0, entry.tabId);
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
    this._layoutSplitter?.tabClosing?.(entry);
    const wasActive = this.resolvedActiveTabId === id;

    // Record for reopen history before removing.
    const index = this.tabOrder.indexOf(id);
    const descriptor = this._persistentDescriptor(entry);
    if (descriptor) this._closedTabHistory.push({ desc: descriptor, index });
    if (this._closedTabHistory.length > PaneStore._MAX_CLOSED_HISTORY) {
      this._closedTabHistory.shift();
    }

    this._disposeEntry(id);
    this.entries.delete(id);
    this._resources.delete(id);
    removeTabId(this, id);
    const kinds = new Set([entry.kind, ...(entry.history?.pages.map((page) => page.kind) ?? [])]);
    for (const kind of kinds) if (this.registry.has(kind)) this.registry.get(kind).closed?.(id, this._ctx);
    this._layoutSplitter?.tabRemoved?.(id, wasActive);
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
      close: (opts?: { force?: boolean }): Promise<boolean> => {
        if (this.entries.get(entry.tabId) !== entry) return Promise.resolve(false);
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
              if (proceed && this.entries.get(entry.tabId) === entry) runInAction(() => this._removeTab(entry.tabId));
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
        config?: Partial<TabOpenOptions>
      ) => {
        if (this.entries.get(entry.tabId) !== entry) return;
        if (this._layoutOpener) this._layoutOpener(kind, args, { ...config, from: entry.tabId, intent: config?.intent ?? 'navigate' });
        else { this.setActiveTab(entry.tabId); this.openKind(kind, args, config); }
      },
    };
  }
}
