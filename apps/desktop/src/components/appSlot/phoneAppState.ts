import { appStateOf, type ReportedAppView } from '../../session/shared/extensions/app-state'
import type { ExtensionCapability } from '../../session/shared/extensions/manifest'
import { liveDeviceSessions } from '../../session/shared/remote-sessions/session-directory'
import { platform } from '../../platform'

const EMPTY: ReportedAppView = { activeSessionId: null, activeProjectId: null, panes: [] }
const views: ReportedAppView[] = []
let windowFocused = typeof document !== 'undefined' && document.visibilityState === 'visible'
const listeners = new Set<() => void>()
let stopFocus: (() => void) | undefined
const changed = () => { for (const listener of listeners) listener() }

/** The timeline's actual route/tab; closing a peek restores the underlying task, and old cleanup leaves newer views alone. */
export function showPhoneAppView(next: ReportedAppView): () => void {
  views.push(next)
  changed()
  return () => { const index = views.indexOf(next); if (index !== -1) { views.splice(index, 1); changed() } }
}

export function phoneAppState(capabilities: readonly ExtensionCapability[]) {
  const ids = new Map(Object.values(liveDeviceSessions()).flatMap(({ sessions }) => sessions.flatMap((session) => session.agent ? [[session.conversationId, `user:${session.agent.userId}`] as const] : [])))
  return appStateOf(views.at(-1) ?? EMPTY, windowFocused, { agents: capabilities.includes('agents:read'), files: capabilities.includes('files:read') || capabilities.includes('files:write') }, ids)
}

/** Shares the host's foreground signal, including Android's background-watch case where document.visibility lies. */
export function onPhoneAppState(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    const sync = () => { windowFocused = document.visibilityState === 'visible'; changed() }
    stopFocus = platform.subscribeAppActive?.((active) => { windowFocused = active; changed() })
    if (!stopFocus) {
      document.addEventListener('visibilitychange', sync)
      stopFocus = () => document.removeEventListener('visibilitychange', sync)
    }
  }
  return () => { listeners.delete(listener); if (!listeners.size) { stopFocus?.(); stopFocus = undefined } }
}
