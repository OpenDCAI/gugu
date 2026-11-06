import type { GitChangeStatus, GitObjectRef } from '@gugu/session-core/git';
import type { BrowserSessionSnapshot } from '@shared/browser';

export type TabViewSnapshot = {
  tabOrder: string[];
  activeTabId: string | undefined;
};

/** A tab is one navigation context; pages in its history do not own tab order or layout. */
export type TabOpenIntent = 'navigate' | 'newTab' | 'beside';
export type TabPageSnapshot = {
  kind: string;
  state: unknown;
  /** Opaque presentation state owned by the page, never authorization data. */
  viewState?: Record<string, unknown>;
};
export type TabHistorySnapshot = {
  pages: TabPageSnapshot[];
  index: number;
};

export type BuiltInTabDescriptor =
  | { kind: 'session'; tabId: string; sessionId: string }
  | { kind: 'acp-chat'; tabId: string; sessionId: string }
  | { kind: 'file-view'; tabId: string; path: string; isExternal?: boolean }
  | { kind: 'review'; tabId: string; sessionId: string }
  | {
      kind: 'browser';
      tabId: string;
      browserId: string;
      session: BrowserSessionSnapshot;
    }
  | { kind: 'terminal'; tabId: string; terminalId: string }
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
    };

export type ExtensionTabDescriptor = {
  kind: 'extension';
  extensionKind: string;
  tabId: string;
  state?: Record<string, unknown>;
};

export type TabDescriptor = (BuiltInTabDescriptor | ExtensionTabDescriptor) & {
  history?: TabHistorySnapshot;
  openerTabId?: string;
};

const BUILT_IN_TAB_KINDS = {
  session: true,
  'acp-chat': true,
  'file-view': true,
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
  /** The group holding the side of the pair (spec session-page「并排」); absent = not paired, or saved before pairs. */
  sideGroupId?: string;
  /** What each tab pushed out of the pair, by tab id: closing it brings that one back (spec session-page「并排」). */
  displaced?: Record<string, DisplacedTab>;
};

/** A tab pushed out of the pair, and which side it was on. */
export type DisplacedTab = { tabId: string; role: 'pinned' | 'side' };

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
  idleExpandedProjectIds?: string[];
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
