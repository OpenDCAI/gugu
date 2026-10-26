import { DeviceRpcTimeoutError, DeviceRpcChannelError } from './deviceRpcRequester'
import { assistantWorkDeliveryTarget, type AssistantWorkAddress } from './assistantWorkRouting'

/** Account events are the only durable delivery queue. This module keeps no local message copy. */
export type AssistantWorkRpcClient = {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>
}

export type AssistantWorkEventInput = {
  message_id: string
  kind: 'dispatch' | 'progress' | 'question' | 'completed' | 'cancelled' | 'failed' | 'blocked'
  from_session_id: string
  from_device_id: string
  to_session_id: string
  to_device_id: string
  content?: string | null
  attachment_refs?: unknown[]
  source_chat_id?: string
  source_message_id?: string
  executor_session_id?: string
  reason_code?: string
}
export type AssistantWorkTaskInput = {
  title: string
  coordinator_session_id: string
  executors: Array<{ session_id: string; device_id: string; agent_user_id?: string }>
  source_link?: string
}
export type AssistantWorkEnqueueInput = {
  assistantId: string
  runtimeInstanceId: string
  operationId: string
  workId: string
  task: AssistantWorkTaskInput | null
  events: AssistantWorkEventInput[]
}
export type AssistantWorkAcceptance = {
  status: 'accepted'
  work_id: string
  event_ids: string[]
  outcome: string
  terminal_version: string
}

async function call(client: AssistantWorkRpcClient, name: string, args: Record<string, unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const { data, error } = await Promise.race([
      Promise.resolve(client.rpc(name, args)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Work RPC deadline exceeded'), { code: 'WORK_RPC_TIMEOUT' })), 8000) }),
    ])
    if (error) throw Object.assign(new Error(error.message), { code: error.code })
    return data
  } finally { if (timer !== undefined) clearTimeout(timer) }
}

/** Acceptance is a committed cloud event, never a claim that the receiver or its owner has read it. */
export async function enqueueAssistantWorkDelivery(client: AssistantWorkRpcClient, input: AssistantWorkEnqueueInput): Promise<AssistantWorkAcceptance> {
  const result = await call(client, 'assistant_work_commit', {
    p_assistant: input.assistantId, p_runtime_instance_id: input.runtimeInstanceId, p_operation_id: input.operationId,
    p_work_id: input.workId, p_task: input.task, p_events: input.events,
  }) as Omit<AssistantWorkAcceptance, 'status'> | null
  if (!result || result.work_id !== input.workId || !Array.isArray(result.event_ids)
    || result.event_ids.some(id => typeof id !== 'string') || typeof result.outcome !== 'string'
    || !['string', 'number'].includes(typeof result.terminal_version)) throw new Error('Invalid work acceptance receipt')
  return { ...result, status: 'accepted', terminal_version: String(result.terminal_version) }
}

export type ClaimedAssistantWorkEvent = AssistantWorkEventInput & {
  delivery_target?: AssistantWorkAddress | null
  work_id: string
  assistant_user_id?: string
  lease_token: string
  lease_until: string
  lease_remaining_ms: number
  age_ms: number
  platform_received_at: string
  source_available: boolean
  failed_attempts: number
  attempts: number
  last_error_code?: string | null
  terminal_version: string
}
export type AssistantWorkOutboxContext = { ownerId: string; runtimeInstanceId: string; deviceId: string }
export type AssistantWorkAdmission = { status: 'admitted'; messageId: string; receipt?: Record<string, unknown> } | { status: 'pending' }
export const ASSISTANT_WORK_DELIVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const ASSISTANT_WORK_DELIVERY_BUDGET_MS = 45_000

function errorCode(error: unknown): string {
  if(error instanceof DeviceRpcTimeoutError) return 'DELIVERY_TIMEOUT'
  if(error instanceof DeviceRpcChannelError) {
    if(error.reason==='outdated') return 'DELIVERY_HOST_OUTDATED'
    if(error.reason==='signInRequired') return 'AUTHENTICATION_REQUIRED'
    if(error.reason==='unreachable') return 'DEVICE_UNREACHABLE'
  }
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(code) ? code.toUpperCase() : 'DELIVERY_FAILED'
}

export function createAssistantWorkOutboxPump(deps: {
  context(): Promise<AssistantWorkOutboxContext | null>
  rpc(name: string, args: Record<string, unknown>, context: AssistantWorkOutboxContext): ReturnType<AssistantWorkRpcClient['rpc']>
  /** Uses the existing session delivery route with this exact message ID, including any necessary cloud wake. */
  deliver(event: ClaimedAssistantWorkEvent, signal: AbortSignal): Promise<AssistantWorkAdmission>
  warn?(detail: { code: string; messageId?: string }): void
  now?: () => number
}) {
  let flight: Promise<void> | null = null
  let again = false
  let stopped = false
  const active = new Set<AbortController>()

  const settle = async (ctx: AssistantWorkOutboxContext, event: ClaimedAssistantWorkEvent, stage: string, code?: string, receipt?: Record<string, unknown>) => {
    // Owner changes or stopped runtime instances cannot settle a previous owner's claim.
    const current = await deps.context()
    if (stopped || current?.ownerId !== ctx.ownerId || current.runtimeInstanceId !== ctx.runtimeInstanceId) return
    const observedFailure = stage === 'retry' && !new Set([
      'NOT_ADMITTED', 'SESSION_DIRECT_OUTCOME_UNKNOWN', 'SESSION_DIRECT_QUEUED', 'SESSION_DIRECT_NOT_LIVE', 'QUEUED', 'DEVICE_UNREACHABLE', 'DEVICE_OFFLINE',
      'SESSION_DEVICE_OFFLINE', 'SESSION_DEVICE_UNREACHABLE', 'SESSION_DEVICE_NO_ANSWER', 'DELIVERY_NOT_READY', 'SESSION_HOST_NOT_READY', 'DELIVERY_TIMEOUT', 'WORK_RPC_TIMEOUT',
    ]).has(code ?? '')
    const backoffAttempts = observedFailure ? event.failed_attempts : Math.max(0, event.attempts - 1)
    await call({ rpc: (name, args) => deps.rpc(name, args, ctx) }, 'assistant_work_outbox_settle', {
      p_runtime_instance_id: ctx.runtimeInstanceId, p_message_id: event.message_id, p_lease_token: event.lease_token,
      p_stage: stage, ...(code ? { p_error_code: code } : {}),
      p_retry_after_seconds: Math.min(300, 5 * 2 ** Math.min(6, backoffAttempts)),
      p_receipt: stage === 'retry' ? { failure_observed: observedFailure } : receipt ?? {},
    })
  }

  const deliverOne = async (ctx: AssistantWorkOutboxContext, event: ClaimedAssistantWorkEvent, claimStartedAt: number):Promise<boolean> => {
    if (stopped) return false
    const invalid = !event.message_id || !event.lease_token || !event.to_device_id || !event.to_session_id
      || !Number.isFinite(event.lease_remaining_ms) || event.lease_remaining_ms < 0
      || !Number.isFinite(event.age_ms) || event.age_ms < 0
      || !Number.isInteger(event.failed_attempts) || event.failed_attempts < 0
    if (invalid) { deps.warn?.({ code: 'INVALID_OUTBOX_EVENT' }); return false }
    if (!event.source_available) { await settle(ctx,event,'abandoned','SOURCE_UNAVAILABLE');return true }
    // Older deployed servers count deferred/offline retries as failures too. Only the server age decides expiry.
    if (event.age_ms + Math.max(0, performance.now() - claimStartedAt) >= ASSISTANT_WORK_DELIVERY_MAX_AGE_MS) { await settle(ctx,event,'abandoned','DELIVERY_EXPIRED');return true }
    if (!assistantWorkDeliveryTarget(event)) { await settle(ctx,event,'retry','DELIVERY_NOT_READY');return false }
    const budget = Math.min(ASSISTANT_WORK_DELIVERY_BUDGET_MS, event.lease_remaining_ms - Math.max(0, performance.now() - claimStartedAt) - 5000)
    // Insufficient remaining lease is not a failed delivery attempt. Let a fresh claim take it.
    if (budget <= 0) return false
    const controller = new AbortController()
    active.add(controller)
    let timer: ReturnType<typeof setTimeout> | undefined
    let result: AssistantWorkAdmission
    try {
      result = await Promise.race([
        deps.deliver(event, controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = Object.assign(new Error('Work delivery deadline exceeded'), { code: 'DELIVERY_TIMEOUT' })
            controller.abort(error); reject(error)
          }, budget)
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
        }),
      ])
    } catch (error) {
      if (stopped) return false
      const code = errorCode(error)
      deps.warn?.({ code, messageId: event.message_id })
      await settle(ctx, event, code === 'SOURCE_UNAVAILABLE' ? 'abandoned' : 'retry', code)
      return code==='SOURCE_UNAVAILABLE'
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      active.delete(controller)
    }
    // A lost settlement leaves the existing lease to expire. Do not label an admitted message failed.
    if (result.status !== 'admitted' || result.messageId !== event.message_id) { await settle(ctx,event,'retry','NOT_ADMITTED');return false }
    await settle(ctx, event, event.kind === 'dispatch' ? 'executor_admitted' : 'assistant_admitted', undefined, event.kind === 'dispatch' ? result.receipt : undefined)
    return true
  }

  const drain = async () => {
    do {
      again = false
      const ctx = await deps.context()
      if (stopped || !ctx) return
      const claimStartedAt = performance.now()
      const result = await call({ rpc: (name, args) => deps.rpc(name, args, ctx) }, 'assistant_work_outbox_claim', {
        p_runtime_instance_id: ctx.runtimeInstanceId, p_limit: 20, p_lease_seconds: 60,
      }) as { events?: ClaimedAssistantWorkEvent[] } | null
      if (!Array.isArray(result?.events)) throw Object.assign(new Error('Invalid outbox claim'), { code: 'INVALID_OUTBOX_CLAIM' })
      // A target's next message cannot overtake an unadmitted predecessor. Separate targets keep two lanes.
      const targets=new Map<string,ClaimedAssistantWorkEvent[]>()
      for(const event of result.events) {
        const target=assistantWorkDeliveryTarget(event)
        const key=JSON.stringify(target ? [target.device_id,target.session_id] : [null,event.message_id])
        const group=targets.get(key)??[];group.push(event);targets.set(key,group)
      }
      const pending=[...targets.values()]
      await Promise.all([0, 1].map(async () => {
        while (!stopped && pending.length) {
          for(const event of pending.shift()!) {
            try { if(!await deliverOne(ctx,event,claimStartedAt)) break;again=true }
            catch(error) {deps.warn?.({code:errorCode(error),messageId:event.message_id});break}
          }
        }
      }))
      if (result.events.length === 20) again = true
    } while (again && !stopped)
  }

  return {
    /** Called on the account event, reconnect and the existing runtime reconciliation cadence. */
    kick(): Promise<void> {
      if (stopped) return Promise.resolve()
      again = true
      if (flight) return flight
      const running = drain().catch(error => { deps.warn?.({ code: errorCode(error) }) })
      flight = running.finally(() => { flight = null })
      return flight
    },
    stop(): void { stopped = true; for (const controller of active) controller.abort(new Error('Work outbox stopped')) },
  }
}
