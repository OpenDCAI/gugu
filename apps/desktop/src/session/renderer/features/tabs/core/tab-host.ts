import type { ResolvedTab, TabResource, TabViewContext } from './tab-provider';
import type { TabHistorySnapshot } from '@shared/view-state';

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
  navigationOf(tabId: string): TabHistorySnapshot | undefined;
  goTo(tabId: string, index: number): Promise<boolean>;
  canGo(tabId: string, delta: -1 | 1): boolean;
  go(tabId: string, delta: -1 | 1): Promise<boolean>;
  setPageViewState(tabId: string, state: Record<string, unknown>): void;

  /** Opens a tab of any registered kind. Untyped for use from resources/handles. */
  openKind(kind: string, args: unknown): void;

  setActiveTab(tabId: string): void;
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
  /**
   * 页签全屏(`tab-fullscreen.ts`):这一枚临时盖住整个工作区,❌ 动布局(拆开是另一件事,`separatePair`)。
   * 只在全屏有意义时给(并排着、或这一屏不止一块,或它正全屏着);别的时候 = null。页签上那颗钮和双击用它。
   * `multiBlock` = 这一格所在的这屏不止一块(调用方从 ScreenBlockContext 读)。
   */
  tabFill(tabId: string, multiBlock?: boolean): { full: boolean; toggle: () => void } | null;
  /** 向右分: this tab side by side with the page on screen (spec session-page「并排」). */
  splitTab(tabId: string): void;
  /** 拆开: the pair back to ordinary tabs, the one looked at fills. */
  separatePair(): void;
  /** 这一格在一个能分格的布局里(单独成窗的那一格、独立的格子不在)。 */
  readonly inSplitLayout: boolean;
  /** 为什么分不出来(null = 分得出来)。 */
  tabSplitBlocked(tabId: string): 'only-tab' | 'too-small' | null;
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
