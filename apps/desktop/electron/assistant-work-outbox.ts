import {
  createAssistantWorkOutboxPump, type AssistantWorkAdmission, type AssistantWorkOutboxContext,
  type AssistantWorkRpcClient,
} from '@gugu/core/cloud/assistantWorkOutbox'
import {
  ASSISTANT_WORK_DELIVERY_RPC, createAssistantWorkDeliveryReceiver,
  type AssistantWorkDeliveryEvent, type AssistantWorkDeliveryReference,
} from '@gugu/core/cloud/assistantWorkDelivery'
import type { DeviceRpcHandlers } from '@gugu/core/cloud/deviceRpcResponder'
import type { DeviceRpcResponse } from '@gugu/core/cloud/deviceRpcProtocol'
import { assistantWorkDeliveryTarget } from '@gugu/core/cloud/assistantWorkRouting'

export type AssistantWorkHostContext = AssistantWorkOutboxContext & { client: AssistantWorkRpcClient }

/** The host owns only transport. Task creation/terminal commits are installed by the ledger bridge. */
export function createAssistantWorkOutboxHost(deps: {
  context(): Promise<AssistantWorkHostContext | null>
  deliverLocal(event: AssistantWorkDeliveryEvent, signal?: AbortSignal): Promise<{ admitted: boolean; messageId: string; receipt?: Record<string, unknown> }>
  prepareRemote(deviceId: string, signal: AbortSignal): Promise<void>
  requestRemote(deviceId: string, type: string, payload: unknown, signal: AbortSignal): Promise<DeviceRpcResponse<unknown>>
  subscribe(ownerId: string, changed: () => void): Promise<() => void>
  afterDrain?: () => Promise<void>
  warn(detail: { code: string; messageId?: string }): void
  unavailable?(context: AssistantWorkOutboxContext, failure: {code: string}, signal: AbortSignal): Promise<void>
}) {
  let subscriptionOwner: string | null = null
  let unsubscribe: (() => void) | null = null
  let subscribeFlight: Promise<void> | null = null
  let stopped = false
  const rpc = async (name: string, args: Record<string, unknown>, claimed: AssistantWorkOutboxContext) => {
    const current = await deps.context()
    if (!current || current.ownerId !== claimed.ownerId || current.runtimeInstanceId !== claimed.runtimeInstanceId) {
      throw Object.assign(new Error('Outbox owner changed'), { code: 'OWNER_CHANGED' })
    }
    return current.client.rpc(name, args)
  }
  const receiver = createAssistantWorkDeliveryReceiver({
    context: deps.context,
    read: async (ref) => {
      const current = await deps.context()
      if (!current) return null
      let after = '0'
      for (let page = 0; page < 10; page++) {
        const { data, error } = await current.client.rpc('assistant_work_history', {
          p_assistant: ref.assistant_id, p_work_id: ref.work_id, p_after: after, p_limit: 100,
        })
        if (error) throw Object.assign(new Error(error.message), { code: error.code })
        const history = data as { events?: AssistantWorkDeliveryEvent[]; next_after?: string | null }
        if (!Array.isArray(history.events)) throw Object.assign(new Error('Invalid work history'), { code: 'INVALID_WORK_HISTORY' })
        const event = history.events.find(event => event.message_id === ref.message_id)
        if (event) return event
        if (!history.next_after) return null
        after = history.next_after
      }
      throw Object.assign(new Error('Work history needs a narrower read'), { code: 'WORK_HISTORY_LIMIT' })
    },
    deliver: deps.deliverLocal,
  })
  const pump = createAssistantWorkOutboxPump({
    context: deps.context, rpc, warn: deps.warn, unavailable: deps.unavailable,
    deliver: async (event, signal): Promise<AssistantWorkAdmission> => {
      const current = await deps.context()
      if (!current || !event.assistant_user_id) throw Object.assign(new Error('Outbox context unavailable'), { code: 'OUTBOX_CONTEXT_UNAVAILABLE' })
      const reference: AssistantWorkDeliveryReference = {
        assistant_id: event.assistant_user_id, work_id: event.work_id, message_id: event.message_id,
      }
      const target = assistantWorkDeliveryTarget(event)
      if (!target) return { status: 'pending' }
      if (target.device_id === current.deviceId) return receiver.receive(reference, current.ownerId, signal)
      await deps.prepareRemote(target.device_id, signal)
      signal.throwIfAborted()
      const response = await deps.requestRemote(target.device_id, ASSISTANT_WORK_DELIVERY_RPC, reference, signal)
      if (response.error) throw Object.assign(new Error(response.error.message), {
        code: response.error.code === 'unknown_method' ? 'DELIVERY_HOST_OUTDATED' : response.error.code,
      })
      const receipt = response.result as AssistantWorkAdmission | undefined
      return receipt?.status === 'admitted' && receipt.messageId === event.message_id ? receipt : { status: 'pending' }
    },
  })
  const ensureSubscription = async () => {
    const current = await deps.context()
    if (stopped || !current || subscriptionOwner === current.ownerId) return
    if (subscribeFlight) return subscribeFlight
    unsubscribe?.(); unsubscribe = null
    const owner = current.ownerId
    subscribeFlight = deps.subscribe(owner, () => { void pump.kick() }).then(off => {
      if (stopped) { off(); return }
      unsubscribe = off; subscriptionOwner = owner
    }).finally(() => { subscribeFlight = null })
    await subscribeFlight
  }
  return {
    context: deps.context,
    async kick(): Promise<void> {
      if (stopped) return
      try {
        void ensureSubscription().catch(() => deps.warn({code:'WORK_EVENTS_UNAVAILABLE'}))
        await pump.kick(); await deps.afterDrain?.()
      }
      catch { deps.warn({ code: 'WORK_OUTBOX_UNAVAILABLE' }) }
    },
    rpcHandlers(): DeviceRpcHandlers {
      return { 'assistantWork.reconcile': async (_payload, ctx) => {
        const current = await deps.context()
        if (!current || current.ownerId !== ctx.request.user_id) return {error:{code:'OWNER_CHANGED',message:'Account changed'}}
        void this.kick()
        return {result:{accepted:true}}
      }, [ASSISTANT_WORK_DELIVERY_RPC]: async (payload, ctx) => {
        try { return { result: await receiver.receive(payload, ctx.request.user_id) } }
        catch (error) {
          const code = (error as { code?: unknown })?.code
          return { error: { code: typeof code === 'string' ? code : 'WORK_DELIVERY_FAILED', message: 'Task result could not be admitted' } }
        }
      } }
    },
    stop(): void { stopped = true; unsubscribe?.(); unsubscribe = null; pump.stop() },
  }
}

export type AssistantWorkOutboxHost = ReturnType<typeof createAssistantWorkOutboxHost>
