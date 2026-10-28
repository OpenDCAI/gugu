import type { GitChangeStatus, GitObjectRef } from '@gugu/session-core/git';
import type { BrowserSessionSnapshot } from '@shared/browser';

export type TabViewSnapshot = {
  tabOrder: string[];
  activeTabId: string | undefined;
};

export type BuiltInTabDescriptor =
  | { kind: 'session'; tabId: string; sessionId: string; isPreview: boolean }
  | { kind: 'acp-chat'; tabId: string; sessionId: string; isPreview: boolean }
  | { kind: 'file-browser'; tabId: string; isPreview: boolean }
  | { kind: 'file'; tabId: string; path: string; isPreview: boolean; isExternal?: boolean }
  | { kind: 'review'; tabId: string; sessionId: string; isPreview: boolean }
  | {
      kind: 'browser';
      tabId: string;
      browserId: string;
      session: BrowserSessionSnapshot;
      isPreview: boolean;
    }
  | { kind: 'terminal'; tabId: string; terminalId: string; isPreview: boolean }
  | {
      kind: 'diff';
      tabId: string;
      path: string;
      diffGroup: 'disk' | 'staged' | 'git' | 'pr';
      originalRef: GitObjectRef;
      modifiedRef?: GitObjectRef;
      prNumber?: number;
      prBaseOid?: string;
      prHeadOid?: string;
      commitOriginalSha?: string | null;
      commitModifiedSha?: string;
      status?: GitChangeStatus;
      isPreview: boolean;
    };

export type ExtensionTabDescriptor = {
  kind: 'extension';
  extensionKind: string;
  tabId: string;
  isPreview: boolean;
  state?: Record<string, unknown>;
};

/** Closing a shown tab returns here while that tab is still open. */
export type TabReturnTo = { tabId: string; message?: string };

export type TabDescriptor = (BuiltInTabDescriptor | ExtensionTabDescriptor) & {
  returnTo?: TabReturnTo;
};

const BUILT_IN_TAB_KINDS = {
  session: true,
  'acp-chat': true,
  'file-browser': true,
  file: true,
  review: true,
  browser: true,
  terminal: true,
  diff: true,
} satisfies Record<BuiltInTabDescriptor['kind'], true>;

export function isBuiltInTabKind(kind: string): kind is BuiltInTabDescriptor['kind'] {
  return Object.hasOwn(BUILT_IN_TAB_KINDS, kind);
}

export type TabManagerSnapshot = {
  tabs: TabDescriptor[];
  activeTabId: string | undefined;
  /**
   * 并排的一对(spec session-page「并排」):钉住的那枚、另一枚、另一枚摆在哪边(没有 = 右边)、拖成前一页占几成(`share`;
   * 没拖过 = 没有,两页照页面自己声明的宽)。
   * 可选 —— 旧版本存的没有它,旧版本读到新存档也只是不认它(两枚照常是页签),不用迁移。10-26 起比例记在 `share`:
   * 之前存的 `ratio` 不再读(owner 宁可断代:拖过的人重新拖一次,所有人从页面声明的宽起步)。
   */
  pair?: {
    anchorTabId: string;
    sideTabId: string;
    share?: number;
    sideAt?: 'left' | 'right' | 'top' | 'bottom';
  };
  /**
   * 用户拆开过的那几类页签(按页签类型各记各的):开在对话旁边的同一类不再自动并排,直到他自己再把这一类分屏。
   * 没有 = 都没拆开过。10-28 之前那个不分类型的 `splitDeclined: boolean` 不再读(来源混着,owner 定直接丢)。
   */
  splitDeclinedKinds?: string[];
};

export type TabGroupsSnapshot = {
  groups: Array<{
    groupId: string;
    tabManager: TabManagerSnapshot;
  }>;
  activeGroupId: string;
  /** Percentage sizes parallel to groups[]. */
  paneSizes: number[];
  /**
   * How the panes are cut (#7052): side by side or stacked, nested. Absent in layouts saved before panes could stack —
   * those stand side by side in `groups` order with `paneSizes`, as they were drawn.
   */
  layout?: PaneLayoutSnapshotNode;
};

/** One node of a saved pane layout: a pane (by its group id), or a cut of nodes with their percentage shares. */
export type PaneLayoutSnapshotNode =
  | { pane: string }
  | { split: 'horizontal' | 'vertical'; children: PaneLayoutSnapshotNode[]; sizes: number[] };

export type EditorViewSnapshot = {
  /** Legacy: was used before tab state moved to TabManagerSnapshot. Ignored on restore. */
  tabs?: Array<{ tabId: string; path: string; isPreview: boolean; isExternal?: boolean }>;
  /** Legacy: was used before tab state moved to TabManagerSnapshot. Ignored on restore. */
  activeTabId?: string | null;
  expandedPaths: string[];
};

export type DiffViewSnapshot = {
  diffStyle: 'unified' | 'split';
  viewMode: 'file';
  activeFile?: ActiveFile;
  commitAction: 'commit' | 'commit-push' | 'commit-pr' | null;
  prTab?: 'files' | 'commits' | 'checks';
};

export type TerminalDrawerActiveItem =
  | { kind: 'terminal'; id: string }
  | { kind: 'script'; id: string };

export interface ActiveFile {
  path: string;
  /** Storage layer: how content is fetched.
   *  'disk' = working-tree read (disk://)
   *  'git'  = git-object read (git://) */
  type: 'disk' | 'git';
  /** Semantic context: which diff panel/group this file belongs to.
   *  Determines which side is original/modified and which events make it stale.
   *  'disk'   = working tree vs HEAD
   *  'staged' = index vs HEAD
   *  'git'    = arbitrary ref-to-ref comparison
   *  'pr'     = PR diff (originalRef is remote-tracking base) */
  group: 'disk' | 'staged' | 'git' | 'pr';
  originalRef: GitObjectRef;
  /** Fixed modified-side ref for 'git' and 'pr' diffs.
   *  When absent the diff viewer falls back to HEAD_REF. */
  modifiedRef?: GitObjectRef;
  /** Set only when group === 'pr'. Identifies the PR for store lookups. */
  prNumber?: number;
  /** Exact PR base/head OIDs for comment scoping and stable target identity. */
  prBaseOid?: string;
  prHeadOid?: string;
  /** Exact commit diff endpoints for comment scoping. Root commits use null original. */
  commitOriginalSha?: string | null;
  commitModifiedSha?: string;
}

export type SessionViewSnapshot = {
  sidebarTab?: string;
  isSidebarCollapsed?: boolean;
  focusedRegion: 'main' | 'bottom';
  isTerminalDrawerOpen?: boolean;
  terminalDrawerActiveItem?: TerminalDrawerActiveItem;
  /** Takes precedence over tabManager when present. */
  tabGroups?: TabGroupsSnapshot;
  /** @deprecated Use tabGroups. Kept for migration from single-pane snapshots. */
  tabManager?: TabManagerSnapshot;
  /** @deprecated Legacy field from before the unified tab refactor. Used only for migration. */
  sessions?: TabViewSnapshot;
  terminals?: TabViewSnapshot;
  editor?: EditorViewSnapshot;
  diffView?: DiffViewSnapshot;
};

export type ProjectViewSnapshot = {
  activeView: string;
  sessionViewTab: 'active' | 'archived';
  selectedIssueProvider?: string;
};

export type NavigationSnapshot = {
  currentViewId: string;
  viewParams: Record<string, unknown>;
};

export type SidebarSessionSortBy = 'created-at' | 'updated-at';

/** Persisted sidebar UI state; fields may be absent in older DB blobs. */
export type SidebarSnapshot = {
  expandedProjectIds?: string[];
  expandedSessionIds?: string[];
  projectOrder?: string[];
  sessionOrderByProject?: Record<string, string[]>;
  sessionSortBy?: SidebarSessionSortBy;
  /** Section headers (Pinned / Projects / Tasks) folded by the user. */
  pinnedCollapsed?: boolean;
  projectsCollapsed?: boolean;
  sessionsCollapsed?: boolean;
  chatsCollapsed?: boolean;
  /** gugu-dev#181 项目和对话分开(两枚页签)还是合在一起(一条列表),以及分开时看的是哪一页。 */
  listLayout?: SidebarListLayout;
  listPage?: SidebarListPage;
};

export type SidebarListLayout = 'split' | 'merged';
export type SidebarListPage = 'projects' | 'chats';
