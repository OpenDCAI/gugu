import { setNativePromptPreparation } from '@gugu/session-runtime/acp-agents'
export type SessionAdmissionPreparation = { text: string; beforeText?: string; accepted(): Promise<void>; rejected?(): Promise<void>; assistantPanel?: true }
type Prepare = (sessionId: string, text: string) => Promise<SessionAdmissionPreparation>
let prepare: Prepare | null = null
const panelSessions = new Set<string>()

/** Installed through the embedded-module bridge: its module graph is separate
 * from the host's. Non-assistant sessions return their original text. */
export function setSessionAdmissionPreparation(provider: Prepare | null): void { prepare = provider; panelSessions.clear(); setNativePromptPreparation(provider ? sessionId => prepareSessionAdmission(sessionId,'') : null) }
export function hasSessionAdmissionPreparation(): boolean { return prepare !== null }
export function sessionUsesAssistantPanel(sessionId: string): boolean { return panelSessions.has(sessionId) }
export async function prepareSessionAdmission(sessionId: string, text: string): Promise<SessionAdmissionPreparation> {
  try {
    const result = prepare ? await prepare(sessionId,text) : { text,accepted: async () => {} }
    if ('assistantPanel' in result && result.assistantPanel) panelSessions.add(sessionId)
    else panelSessions.delete(sessionId)
    return result
  }
  catch (error) {
    // No model call has happened. Preserve existing deferred messages and let the
    // caller safely retry this user input after the saved change is repaired.
    throw Object.assign(error instanceof Error ? error : new Error('Session preparation failed',{ cause: error }),
      { deliveryRejectedBeforeAdmission: true })
  }
}

/** What an admission applies (saved panel changes) without keeping what only a sent turn may carry:
 * the notice it reserved goes straight back to the session's next turn (#881). */
export async function applySessionAdmissionChanges(sessionId: string): Promise<void> {
  const prepared = await prepareSessionAdmission(sessionId,'')
  await prepared.rejected?.()
}
