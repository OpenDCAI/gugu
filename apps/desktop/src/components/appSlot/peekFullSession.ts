import { revealSessionpage } from '../../hooks/useSessionpageReveal'
import { openSessionInSessionWhenReady } from '../../session/renderer/features/sessions/open-session-in-session'
import { appState } from '../../session/renderer/lib/stores/app-state'

/** A session peeked beside an App, opened in full: as a click on its row opens it (app-menu-events, a banner's click). */
export function openSessionInFull({ sessionId, projectId }: { sessionId: string; projectId: string }): void {
  appState.navigation.navigate('session', { projectId, sessionId })
  revealSessionpage()
  openSessionInSessionWhenReady({ projectId, sessionId })
}
