import type { AssistantPanelChange, AssistantPanelClient } from '@gugu/core/cloud/assistantPanel'
import { panelApplicationFailure } from '@gugu/core/shared/assistantPanelFailure'

export type PanelPreparedAdmission = { text: string; accepted(): Promise<void> }
export type PanelApplication = {
  /** The local effect and its durable structured notice must both precede ack. */
  apply(change: AssistantPanelChange): Promise<void>
  inform(change: AssistantPanelChange): Promise<void>
  prepareText(text: string): Promise<PanelPreparedAdmission>
}

export class AssistantPanelApplicationError extends Error {
  constructor(readonly domain: string, readonly resourceKey: string, readonly code: string, locale = 'zh-CN') {
    super(panelApplicationFailure(domain,resourceKey,code,locale))
    this.name = 'AssistantPanelApplicationError'
  }
}

const errorCode = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code
    : error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message) ? error.message : 'RESOURCE_APPLY_FAILED'
}

/** Every normal admission, including scheduled work, shares this path. New
 * desired values may supersede a failed effect while it is being retried. */
export async function prepareAssistantPanelAdmission(input: {
  assistant: string; instance: string; cloud: AssistantPanelClient; application: PanelApplication
  text: string; locale?: string; wait?: (milliseconds: number) => Promise<void>
}): Promise<PanelPreparedAdmission> {
  const wait = input.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve,milliseconds)))
  async function retry<T>(operation: () => Promise<T>): Promise<T> {
    let failure: unknown
    for (const pause of [0,150,450]) {
      if (pause) await wait(pause)
      try { return await operation() } catch (error) {
        failure = error
        if (['22023','54000','55000','40001'].includes(String((error as { code?: string }).code))) throw error
      }
    }
    throw failure
  }
  for (let pass = 0; pass < 12; pass++) {
    const pending = await retry(() => input.cloud.pending(input.assistant,input.instance))
    let settledFailure = false
    for (const notice of pending.notices) {
      try {
        await input.application.inform(notice)
        await retry(() => input.cloud.ack(input.assistant,input.instance,notice.operation_id))
      } catch { /* Non-blocking metadata remains pending for another opportunity. */ }
    }
    for (const change of pending.changes) {
      let failed: unknown
      for (const pause of [0,50,150]) {
        if (pause) await wait(pause)
        try { await input.application.apply(change); failed = undefined; break }
        catch (error) { failed = error }
      }
      // An effect and its receipt have different failure modes. In particular,
      // losing a success response must never reapply it or publish a failure.
      let receipt
      try {
        receipt = await retry(() => failed
          ? input.cloud.reject(input.assistant,input.instance,change.operation_id,errorCode(failed))
          : input.cloud.ack(input.assistant,input.instance,change.operation_id))
      } catch {
        throw new AssistantPanelApplicationError(change.domain,change.resource_key,'CHANGE_ACK_UNAVAILABLE',input.locale)
      }
      if (receipt.status === 'superseded') break
      if (failed) {
        if (!receipt.terminal) throw new AssistantPanelApplicationError(change.domain,change.resource_key,errorCode(failed),input.locale)
        settledFailure = true
      }
    }
    // The terminal receipt queues an explanation. Fetch it before this prompt,
    // while the failed resource itself can no longer block later effects.
    if (settledFailure) continue
    try {
      const admission = await retry(() => input.cloud.admit(input.assistant,input.instance,pending.revision))
      if (admission.admitted) return input.application.prepareText(input.text)
    } catch (error) {
      if ((error as { code?: string }).code !== '40001') throw error
    }
  }
  throw new AssistantPanelApplicationError('panel','current','CONCURRENT_CHANGES_RETRY',input.locale)
}
