import { autorun } from 'mobx';
import { rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import type { PaneLayoutStore } from '@renderer/features/tabs/pane-layout-store';

/**
 * Reports what the workspace panel is showing, so extension surfaces can be told.
 *
 * **Exactly one task view reports at a time.** Every `WorkspaceViewModel` already
 * reacts to「我是不是当前路由」, so the naive wiring is「active 就报自己、inactive
 * 就报空」—— and that races: switching from task A to task B fires both reactions
 * with no ordering guarantee, so A's「空」can land after B's report and leave the
 * app looking like nothing is open. Registering a *source* instead makes the
 * order irrelevant: a clear from a view that is no longer the source is a no-op.
 *
 * Refs #4068.
 */

/** Tabs whose state carries a conversation id — i.e. tabs that show an agent. */
const AGENT_TAB_KINDS = new Set(['session', 'acp-chat', 'side-chat']);
/** Tabs whose state carries a working-copy path. */
const FILE_TAB_KINDS = new Set(['file']);

interface ReportedTab {
  tabId: string;
  kind: string;
  agentId?: string;
  filePath?: string;
}

interface ReportedPane {
  paneId: string;
  focused: boolean;
  activeTab: ReportedTab | null;
}

interface ReportedAppView {
  activeSessionId: string | null;
  activeProjectId: string | null;
  panes: ReportedPane[];
}

let sourceSessionId: string | null = null;
let disposeReport: (() => void) | null = null;

/**
 * This task view is now the one on screen; report its panes until told otherwise.
 *
 * The autorun re-reads on every pane/tab change. Main drops reports identical to
 * the last one, so a reaction that fires without changing anything costs one IPC
 * and no surface wake-ups.
 */
export function setExtensionAppStateSource(
  sessionId: string,
  projectId: string,
  layout: PaneLayoutStore
): void {
  sourceSessionId = sessionId;
  disposeReport?.();
  disposeReport = autorun(() => {
    push({ activeSessionId: sessionId, activeProjectId: projectId, panes: readPanes(layout) });
  });
}

/**
 * This task view is no longer on screen.
 *
 * Ignored when another view has already taken over — that is the whole point of
 * routing this through a single source (see the header).
 */
export function clearExtensionAppStateSource(sessionId: string): void {
  if (sourceSessionId !== sessionId) return;
  sourceSessionId = null;
  disposeReport?.();
  disposeReport = null;
  push({ activeSessionId: null, activeProjectId: null, panes: [] });
}

function readPanes(layout: PaneLayoutStore): ReportedPane[] {
  return layout.groups.map((group) => {
    const entry = group.pane.activeEntry;
    return {
      paneId: group.paneId,
      focused: group.paneId === layout.activePaneId,
      activeTab: entry ? readTab(entry) : null,
    };
  });
}

/**
 * `kind` goes across verbatim — the provider registry is open and extensions
 * register kinds of their own, so ❌ 别在这里把它映射成一个封闭枚举:装上任何一个
 * 扩展 tab,那个枚举当天就错。
 */
function readTab(entry: { kind: string; tabId: string; state?: unknown }): ReportedTab {
  const state = (entry.state ?? {}) as { sessionId?: string; path?: string };
  const agentId = AGENT_TAB_KINDS.has(entry.kind) ? state.sessionId : undefined;
  const filePath = FILE_TAB_KINDS.has(entry.kind) ? state.path : undefined;
  return {
    tabId: entry.tabId,
    kind: entry.kind,
    ...(agentId ? { agentId } : {}),
    ...(filePath ? { filePath } : {}),
  };
}

/**
 * Reported raw: agent ids and paths go over as they are, and **main** redacts per
 * surface. ❌ 别在这里按权限裁剪——那需要这一侧知道每个已装扩展被授予了什么,
 * 于是「谁说了算」就有了两个答案,漂了的那次一定是放行的那次。
 */
function push(view: ReportedAppView): void {
  void rpc.extensions.setAppState(view).catch((error: unknown) => {
    log.warn('Failed to publish extension app state:', error);
  });
}
