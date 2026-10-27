import type { AgentSettingsTab } from './types'

const availableTabs = new Set<unknown>(['profile', 'look', 'share-act', 'tasks', 'aimodel'])

/** Old links to removed panes resolve to the working profile instead of an empty pane. */
export function resolveAgentSettingsTab(tab: unknown, assistant: boolean): AgentSettingsTab {
  if (!availableTabs.has(tab) || (tab === 'look' && !assistant)) return 'profile'
  return tab as AgentSettingsTab
}
