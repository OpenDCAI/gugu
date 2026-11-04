import type { AssistantPanelChange, AssistantPanelClient } from '@gugu/core/cloud/assistantPanel'
import { panelApplicationFailure } from '@gugu/core/shared/assistantPanelFailure'

export type PanelPreparedAdmission = { text: string; beforeText?: string; accepted(): Promise<void>; rejected?(): Promise<void> }
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

type PanelPendingInput = {
  assistant: string; instance: string; cloud: Pick<AssistantPanelClient, 'pending' | 'ack' | 'reject'>
  application: PanelApplication; locale?: string; wait?: (milliseconds: number) => Promise<void>
}

function panelRetry(wait: (milliseconds: number) => Promise<void>) {
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    let failure: unknown
    for (const pause of [0,150,450]) {
      if (pause) await wait(pause)
      try { return await operation() } catch (error) {
        failure = error
        if (['22023','54000','55000','PT409'].includes(String((error as { code?: string }).code))) throw error
      }
    }
    throw failure
  }
}

/** Apply and acknowledge durable changes without admitting a turn or consuming
 * its prepared notices. Background pulls and prompt preparation share effects. */
export async function applyAssistantPanelPending(input: PanelPendingInput) {
  const wait = input.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve,milliseconds)))
  const retry = panelRetry(wait)
  const pending = await retry(() => input.cloud.pending(input.assistant,input.instance))
  let settledFailure = false, superseded = false
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
    if (receipt.status === 'superseded') { superseded = true; break }
    if (failed) {
      if (!receipt.terminal) throw new AssistantPanelApplicationError(change.domain,change.resource_key,errorCode(failed),input.locale)
      settledFailure = true
    }
  }
  return { revision: pending.revision,settledFailure,superseded }
}

/** Every normal admission, including scheduled work, shares this path. */
export async function prepareAssistantPanelAdmission(input: PanelPendingInput & {
  cloud: AssistantPanelClient; text: string
}): Promise<PanelPreparedAdmission> {
  const wait = input.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve,milliseconds)))
  const retry = panelRetry(wait)
  for (let pass = 0; pass < 12; pass++) {
    const pending = await applyAssistantPanelPending(input)
    // A terminal receipt queues its explanation for this prompt.
    if (pending.settledFailure) continue
    try {
      const admission = await retry(() => input.cloud.admit(input.assistant,input.instance,pending.revision))
      if (admission.admitted) return input.application.prepareText(input.text)
    } catch (error) {
      if ((error as { code?: string }).code !== 'PT409') throw error
    }
  }
  throw new AssistantPanelApplicationError('panel','current','CONCURRENT_CHANGES_RETRY',input.locale)
}
