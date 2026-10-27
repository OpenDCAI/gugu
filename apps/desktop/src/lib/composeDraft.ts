import { APP_COMPOSE_EVENT, APP_SHOW_SESSION_EVENT, type AppComposeDetail } from '@/session/shared/extensions/app-runtime-protocol'
import type { SessionDirectoryRow } from '@/session/shared/remote-sessions/session-directory'
import { readMobileShell } from '@/hooks/useMobileShell'

export function composeChatDraft(detail: AppComposeDetail) {
  document.dispatchEvent(new CustomEvent(APP_COMPOSE_EVENT, { detail, bubbles: true }))
}
export async function composeTaskDraft(row: Pick<SessionDirectoryRow, 'session'> & Partial<Pick<SessionDirectoryRow, 'deviceId'>>, text: string, phone = readMobileShell()) {
  if (phone) { window.dispatchEvent(new CustomEvent(APP_SHOW_SESSION_EVENT, { detail: { ...row, draft: { text } } })); return }
  const [{ appState }, { getProjectManagerStore }, { composeWhenOpen }, { revealSessionpage }] = await Promise.all([
    import('@/session/renderer/lib/stores/app-state'), import('@/session/renderer/features/projects/stores/project-selectors'),
    import('@/session/renderer/features/extensions/compose-in-session'), import('@/hooks/useSessionpageReveal'),
  ])
  revealSessionpage()
  appState.navigation.navigate('session', { projectId: row.session.projectId, sessionId: row.session.conversationId })
  await composeWhenOpen(() => getProjectManagerStore().projects.get(row.session.projectId)?.mountedProject?.sessionManager.sessions.get(row.session.conversationId)?.viewModel ?? undefined, text)
}
