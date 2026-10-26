import type { ExtensionAppState } from './bridge-protocol'

export type ReportedAppView = Omit<ExtensionAppState, 'windowFocused'>

/** The same per-field grants on every host; a reported agent is named by its session id. */
export function appStateOf(view: ReportedAppView, windowFocused: boolean, grants: { agents: boolean; files: boolean }, agentIds: ReadonlyMap<string, string>): ExtensionAppState {
  return {
    windowFocused,
    activeSessionId: view.activeSessionId,
    activeProjectId: view.activeProjectId,
    panes: view.panes.map((pane) => ({
      paneId: pane.paneId,
      focused: pane.focused,
      activeTab: pane.activeTab ? {
        tabId: pane.activeTab.tabId,
        kind: pane.activeTab.kind,
        ...(grants.agents && pane.activeTab.agentId && agentIds.has(pane.activeTab.agentId) ? { agentId: agentIds.get(pane.activeTab.agentId) } : {}),
        ...(grants.files && pane.activeTab.filePath ? { filePath: pane.activeTab.filePath } : {}),
      } : null,
    })),
  }
}
