export type SessionAdmissionPreparation = { text: string; accepted(): Promise<void> }
type Prepare = (sessionId: string, text: string) => Promise<SessionAdmissionPreparation>
let prepare: Prepare | null = null

/** Installed through the embedded-module bridge: its module graph is separate
 * from the host's. Non-assistant sessions return their original text. */
export function setSessionAdmissionPreparation(provider: Prepare | null): void { prepare = provider }
export async function prepareSessionAdmission(sessionId: string, text: string): Promise<SessionAdmissionPreparation> {
  try { return prepare ? await prepare(sessionId,text) : { text,accepted: async () => {} } }
  catch (error) {
    // No model call has happened. Preserve existing deferred messages and let the
    // caller safely retry this user input after the saved change is repaired.
    throw Object.assign(error instanceof Error ? error : new Error('Session preparation failed',{ cause: error }),
      { deliveryRejectedBeforeAdmission: true })
  }
}
