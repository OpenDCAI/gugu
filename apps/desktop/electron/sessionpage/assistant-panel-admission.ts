import type { AssistantPanelChange, AssistantPanelClient } from '@gugu/core/cloud/assistantPanel'

export type PanelPreparedAdmission = { text: string; accepted(): Promise<void> }
export type PanelApplication = {
  /** The local effect and its durable structured notice must both precede ack. */
  apply(change: AssistantPanelChange): Promise<void>
  inform(change: AssistantPanelChange): Promise<void>
  prepareText(text: string): Promise<PanelPreparedAdmission>
}

export class AssistantPanelApplicationError extends Error {
  constructor(readonly domain: string, readonly resourceKey: string, readonly code: string) {
    super(`Assistant panel change was not applied: ${domain}/${resourceKey} (${code})`)
    this.name = 'AssistantPanelApplicationError'
  }
}

const errorCode = (error: unknown) => error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message)
  ? error.message : 'RESOURCE_APPLY_FAILED'

/** Every normal admission, including scheduled work, shares this path. New
 * desired values may supersede a failed effect while it is being retried. */
export async function prepareAssistantPanelAdmission(input: {
  assistant: string; instance: string; cloud: AssistantPanelClient; application: PanelApplication
  text: string; wait?: (milliseconds: number) => Promise<void>
}): Promise<PanelPreparedAdmission> {
  const wait = input.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve,milliseconds)))
  for (let pass = 0; pass < 12; pass++) {
    const pending = await input.cloud.pending(input.assistant,input.instance)
    // Informational metadata is independent of required resource effects. A
    // failed append stays pending for another opportunity without blocking work.
    for (const notice of pending.notices) {
      try {
        await input.application.inform(notice)
        await input.cloud.ack(input.assistant,input.instance,notice.operation_id)
      } catch { /* The durable non-blocking notice remains for the next turn. */ }
    }
    for (const change of pending.changes) {
      let failed: unknown
      let superseded = false
      for (const pause of [0,50,150]) {
        if (pause) await wait(pause)
        try {
          await input.application.apply(change)
          const receipt = await input.cloud.ack(input.assistant,input.instance,change.operation_id)
          superseded = receipt.status === 'superseded'
          failed = undefined
          break
        } catch (error) {
          failed = error
          // A newer deletion may already have removed this obsolete save's body.
          // Its acknowledgement is terminal and must not restore a failure.
          try {
            const receipt = await input.cloud.ack(input.assistant,input.instance,change.operation_id,errorCode(error))
            if (receipt.status === 'superseded') { superseded = true; break }
          } catch { failed = new Error('CHANGE_ACK_UNAVAILABLE') }
        }
      }
      if (superseded) break
      if (failed) throw new AssistantPanelApplicationError(change.domain,change.resource_key,errorCode(failed))
    }
    try {
      const admission = await input.cloud.admit(input.assistant,input.instance,pending.revision)
      if (admission.admitted) return input.application.prepareText(input.text)
    } catch (error) {
      if ((error as { code?: string }).code !== '40001') throw error
    }
  }
  throw new AssistantPanelApplicationError('panel','current','CONCURRENT_CHANGES_RETRY')
}
