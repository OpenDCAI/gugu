import type { ResolvedTab, TabResource, TabViewContext } from './tab-provider';
import type { TabReturnTo } from '@shared/view-state';

/**
 * Narrow host interface that PaneStore implements.
 * UI components (tab bar, content panels) receive this instead of the full
 * store so they cannot reach into internal engine state directly.
 */
export interface TabHost {
  readonly resolvedTabs: ReadonlyArray<ResolvedTab>;
  readonly resolvedActiveTabId: string | undefined;
  /** The ambient context for this pane (viewId + any domain-specific fields). */
  readonly ctx: TabViewContext;
  returnToOf(tabId: string): TabReturnTo | undefined;

  /** Opens a tab of any registered kind. Untyped for use from resources/handles. */
  openKind(kind: string, args: unknown): void;

  setActiveTab(tabId: string): void;
  /** Sets isPreview = false (no-op when already stable). */
  pin(tabId: string): void;
  /** Force-close — no confirmation dialog, calls dispose, removes entry. */
  closeTab(tabId: string): void;
  /**
   * User-initiated close — awaits onBeforeClose veto, then closes if confirmed.
   */
  requestCloseTab(tabId: string): void;
  /** Closes every open tab except the given one (each asks first, like requestCloseTab). */
  closeOthers(tabId: string): void;
  /** Closes the tabs to the right of the given one. */
  closeToRight(tabId: string): void;
  /** Closes every tab here. */
  closeAll(): void;
  /** 右键「拆开」:并排的一对变回两枚普通页签(spec session-page「并排」)。 */
  separatePair(): void;
  /**
   * 并排在对话旁边的那一页「占满」(= 拆开、它占满),或拆开后点着的它「还原」回对话旁边;别的页签 = null
   * (页签上那颗钮和双击,owner 10-26 选 A:工具栏那一行去掉,钮长在它作用的那枚页签上)。
   */
  tabFill(tabId: string): { full: boolean; toggle: () => void } | null;
  /** Whether this tab can go to a new pane beside its own (#7052). False where there is no pane layout. */
  canSplitTab(tabId: string): boolean;
  /** Moves this tab into a new pane on that side of its own. */
  splitTab(tabId: string, edge: 'right' | 'bottom'): void;
  /** 这一格在一个能分格的布局里(单独成窗的那一格、独立的格子不在)。 */
  readonly inSplitLayout: boolean;
  /** 往那一边分为什么分不出来(null = 分得出来)。 */
  tabSplitBlocked(tabId: string, edge: 'right' | 'bottom'): 'full' | 'only-tab' | 'too-small' | null;
  /** 「移到另一栏」:这条会话还有别的格可去时给出怎么挪,没有 = null(原型页签右键)。 */
  tabMoveToOtherPane(tabId: string): (() => void) | null;
  /** 页签右键「在新窗口打开」:这一枚能单独成窗就给出怎么开,不能 = null(spec session-page「一屏几块」)。 */
  tabWindowOpener(tabId: string): (() => void) | null;
  /**
   * Signal hover/focus intent for a tab — fires resource.onActivateIntent().
   * No-op if the resource has no intent handler.
   */
  signalActivateIntent(tabId: string): void;

  readonly renameRequest: { tabId: string; nonce: number } | null;
  requestRename(tabId: string): void;
  clearRenameRequest(): void;
  /** Delegates to the active tab's commands.rename entry. */
  commitRename(tabId: string, name: string): void;
}

/** Props for a kind's TabBarItem component (rendered in the tab bar). */
export interface TabBarItemProps<T extends TabResource> {
  tab: ResolvedTab<T>;
  host: TabHost;
  ctx: TabViewContext;
}

/**
 * Props for a kind's Content component (the pane body area).
 *
 * PaneContent retains recently visited kinds within its shared bound. A kind
 * with several pages uses the same retention for its individual tabs.
 */
export interface TabContentProps {
  host: TabHost;
  ctx: TabViewContext;
}
