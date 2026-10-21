/**
 * 设备动作的「被调用方」(#7199 第二步):一台设备收到「请执行」之后的那一整套 —— 回「收到」、每 15 秒报「还在跑」、
 * 交结果、没收到「结果收到」就重推、按 call_id 去重;授权在开始前、每次报进度时、交结果前各查一次,撤销立刻生效。
 *
 * 只管收发规矩,不碰 node / electron:动作本身怎么做、授权存在哪,由 `provider` 给(桌面 = 主进程,手机 = 原生层)。
 * 合同见 shared/deviceActions.ts 与 #7199 的协议评论。
 */
import {
  DEVICE_ACTION_PROGRESS_EVENT,
  DEVICE_ACTION_PROGRESS_INTERVAL_MS,
  DEVICE_ACTION_PROTOCOL_VERSION,
  DEVICE_ACTION_RESULT_BACKUP_LIMIT,
  DEVICE_ACTION_RESULT_BACKUP_MS,
  DEVICE_ACTION_RESULT_EVENT,
  DEVICE_ACTION_RESULT_RESEND_FOR_MS,
  DEVICE_ACTION_RESULT_RESEND_MS,
  parseDeviceActionCallPayload,
  type DeviceActionAccepted,
  type DeviceActionCallPayload,
  type DeviceActionErrorCode,
  type DeviceActionManifestEntry,
  type DeviceActionResult,
} from '../shared/deviceActions'
import type { DeviceRpcResponse } from './deviceRpcProtocol'

/** 动作做完的样子(还没盖 v / call_id)。 */
export type DeviceActionOutcome =
  | { ok: true; data: unknown }
  | { ok: false; code: DeviceActionErrorCode; message: string; confirm?: { question: string; details?: unknown } }

/** 授权检查的答案:能做,或为什么不能(not_granted / os_permission / unknown_action / unsupported)。 */
export type DeviceActionPermit = { ok: true } | { ok: false; code: DeviceActionErrorCode; message: string }

export interface DeviceActionRunContext {
  callId: string
  /** 谁调的(调用方自报,只用来分开各自的操作现场、给人看是谁在动;❌ 当授权依据)。 */
  caller?: { agent_user_id?: string; name?: string }
  signal: AbortSignal
  /** Host execution budget, independent of the transport's ACK deadline. */
  remainingMs?(): number
  /** 告诉调用方正在做什么(写进下一次「还在跑」)。 */
  note(text: string): void
}

/** 「最近调用」的一条(设置页给人看)。 */
export interface DeviceActionCallRecord {
  callId: string
  action: string
  caller?: { agent_user_id?: string; name?: string }
  startedAt: string
  finishedAt?: string
  ok?: boolean
  code?: DeviceActionErrorCode
  message?: string
}

export interface DeviceActionProvider {
  /** 这一刻的登记清单(授权 / 系统权限算进 available)。 */
  manifest(): DeviceActionManifestEntry[]
  /** 这一刻能不能做这个动作(开始前、每次报进度时、交结果前各问一次)。 */
  permit(action: string): Promise<DeviceActionPermit> | DeviceActionPermit
  /** 开工前的检查:参数不对、要确认(confirm = always 且没带 confirmed)⇒ 回终局结果;没问题回 null。 */
  preflight?(action: string, args: Record<string, unknown>): Promise<DeviceActionOutcome | null> | DeviceActionOutcome | null
  run(action: string, args: Record<string, unknown>, ctx: DeviceActionRunContext): Promise<DeviceActionOutcome>
  /** 「最近调用」:开始一条、结束更新同一条(同一个 callId)。 */
  record?(entry: DeviceActionCallRecord): void
}

export interface DeviceActionHostOptions {
  provider: DeviceActionProvider
  /** 往这台设备的频道推事件(进度 / 结果)。 */
  publishEvent(payload: unknown): Promise<unknown> | unknown
  log?: { info(fields: Record<string, unknown>, msg: string): void; warn(fields: Record<string, unknown>, msg: string): void }
  now?: () => number
}

export interface DeviceActionHost {
  /** `device.action` 的 RPC 处理器:回「收到」,或开工前就判出来的终局结果。 */
  handleCall(payload: unknown): Promise<DeviceRpcResponse<unknown>>
  /** `device.action.result_ack` 的 RPC 处理器。 */
  handleResultAck(payload: unknown): DeviceRpcResponse<unknown>
  dispose(): void
}

type Finished = { result: DeviceActionResult; at: number; resend?: ReturnType<typeof setInterval>; resendUntil: number }

export function createDeviceActionHost(options: DeviceActionHostOptions): DeviceActionHost {
  const { provider } = options
  const now = options.now ?? (() => Date.now())
  const log = options.log
  const running = new Map<string, Promise<void>>()
  const finished = new Map<string, Finished>()
  let disposed = false

  const stamp = (callId: string, outcome: DeviceActionOutcome): DeviceActionResult =>
    outcome.ok
      ? { v: DEVICE_ACTION_PROTOCOL_VERSION, ok: true, call_id: callId, data: outcome.data }
      : {
          v: DEVICE_ACTION_PROTOCOL_VERSION,
          ok: false,
          call_id: callId,
          code: outcome.code,
          message: outcome.message,
          ...(outcome.confirm ? { confirm: outcome.confirm } : {}),
        }

  const publish = (payload: unknown) => {
    try {
      void Promise.resolve(options.publishEvent(payload)).catch((error: unknown) =>
        log?.warn({ err: error instanceof Error ? error.message : String(error) }, 'device action event publish failed'))
    } catch (error) {
      log?.warn({ err: error instanceof Error ? error.message : String(error) }, 'device action event publish failed')
    }
  }

  const prune = () => {
    const cutoff = now() - DEVICE_ACTION_RESULT_BACKUP_MS
    for (const [callId, entry] of finished) {
      if (entry.at < cutoff && !entry.resend) finished.delete(callId)
    }
    while (finished.size > DEVICE_ACTION_RESULT_BACKUP_LIMIT) {
      const oldest = finished.keys().next().value as string | undefined
      if (!oldest) break
      const entry = finished.get(oldest)
      if (entry?.resend) clearInterval(entry.resend)
      finished.delete(oldest)
    }
  }

  const deliver = (result: DeviceActionResult) => {
    const entry: Finished = { result, at: now(), resendUntil: now() + DEVICE_ACTION_RESULT_RESEND_FOR_MS }
    finished.set(result.call_id, entry)
    prune()
    const send = () => publish({ type: DEVICE_ACTION_RESULT_EVENT, v: DEVICE_ACTION_PROTOCOL_VERSION, call_id: result.call_id, result })
    send()
    // 没收到「结果收到」就每 5 秒再推一次,最多 10 分钟(广播会丢,调用方也可能刚重连)。
    entry.resend = setInterval(() => {
      if (disposed || now() > entry.resendUntil) {
        clearInterval(entry.resend)
        entry.resend = undefined
        return
      }
      send()
    }, DEVICE_ACTION_RESULT_RESEND_MS)
    ;(entry.resend as { unref?: () => void }).unref?.()
  }

  const execute = async (call: DeviceActionCallPayload): Promise<void> => {
    const executionStarted = now()
    const startedAt = new Date(executionStarted).toISOString()
    const remainingMs = () => Math.max(0, executionStarted + call.timeout_ms - now())
    let lastNote: string | undefined
    const controller = new AbortController()
    // 放在对象里:定时器回调里改它,TS 的收窄看不见闭包里的赋值。
    const stop: { code: 'timeout' | 'revoked' | null; message: string } = { code: null, message: '' }
    const record = (patch: Partial<DeviceActionCallRecord>) => {
      try {
        provider.record?.({ callId: call.call_id, action: call.action, ...(call.caller ? { caller: call.caller } : {}), startedAt, ...patch })
      } catch {
        // 「最近调用」只是给人看的,记不下 ❌ 影响动作本身
      }
    }
    record({})
    const timeout = setTimeout(() => {
      stop.code = 'timeout'
      stop.message = `${Math.round(call.timeout_ms / 1000)} 秒内没做完；已请求取消，操作可能部分执行，结果未确认，请先检查结果`
      controller.abort(new Error('timeout'))
    }, remainingMs())
    ;(timeout as { unref?: () => void }).unref?.()
    // 每 15 秒:先查一次授权(撤销立刻生效),再报「还在跑」。
    const progress = setInterval(() => {
      void (async () => {
        const permit = await Promise.resolve(provider.permit(call.action)).catch((): DeviceActionPermit => ({ ok: false, code: 'execution_failed', message: '查不到授权' }))
        if (!permit.ok) {
          stop.code = 'revoked'
          stop.message = `执行中授权被撤销:${permit.message}；已请求取消，操作可能部分执行，结果未确认`
          controller.abort(new Error('revoked'))
          return
        }
        publish({
          type: DEVICE_ACTION_PROGRESS_EVENT,
          v: DEVICE_ACTION_PROTOCOL_VERSION,
          state: 'running',
          call_id: call.call_id,
          started_at: startedAt,
          progress_at: new Date(now()).toISOString(),
          ...(lastNote ? { note: lastNote } : {}),
        })
      })()
    }, DEVICE_ACTION_PROGRESS_INTERVAL_MS)
    ;(progress as { unref?: () => void }).unref?.()

    let outcome: DeviceActionOutcome
    try {
      const work = provider.run(call.action, call.args, {
        callId: call.call_id,
        ...(call.caller ? { caller: call.caller } : {}),
        signal: controller.signal,
        remainingMs,
        note: (text) => { lastNote = text },
      })
      // 动作自己不理 signal 时,到点也不再等它:超时 / 撤销以这里为准。
      const stopped = new Promise<DeviceActionOutcome>((resolve) => {
        controller.signal.addEventListener('abort', () => resolve({ ok: false, code: stop.code ?? 'execution_failed', message: stop.message || '已请求取消，操作可能部分执行，结果未确认' }), { once: true })
      })
      outcome = await Promise.race([work, stopped])
    } catch (error) {
      outcome = stop.code
        ? { ok: false, code: stop.code, message: stop.message }
        : { ok: false, code: 'execution_failed', message: error instanceof Error ? error.message : String(error) }
    } finally {
      clearTimeout(timeout)
      clearInterval(progress)
    }
    if (stop.code && outcome.ok) outcome = { ok: false, code: stop.code, message: stop.message }
    // 交结果前再查一次:做完的那一刻授权已经撤了,结果不交出去(动作本身可能已经做了 —— 如实说)。
    if (outcome.ok) {
      const permit = await Promise.resolve(provider.permit(call.action)).catch((): DeviceActionPermit => ({ ok: false, code: 'execution_failed', message: '查不到授权' }))
      if (!permit.ok) outcome = { ok: false, code: 'revoked', message: `动作已执行,但交结果前授权被撤销,结果不交出:${permit.message}` }
    }
    const result = stamp(call.call_id, outcome)
    record({
      finishedAt: new Date(now()).toISOString(),
      ok: result.ok,
      ...(result.ok ? {} : { code: result.code, message: result.message }),
    })
    log?.info({ callId: call.call_id, action: call.action, ok: result.ok, ...(result.ok ? {} : { code: result.code }) }, 'device action finished')
    if (!disposed) deliver(result)
  }

  return {
    async handleCall(payload) {
      const call = parseDeviceActionCallPayload(payload)
      if (!call) {
        const callId = payload && typeof payload === 'object' && typeof (payload as { call_id?: unknown }).call_id === 'string'
          ? (payload as { call_id: string }).call_id
          : ''
        return { result: stamp(callId, { ok: false, code: 'invalid_args', message: '请求不完整(缺 call_id / action / deadline_at)' }) }
      }
      // 同一个 call_id 再来(调用方没收到「收到」重发了一次 / 重连后补问):在跑就再说一次收到,做完了就回那份结果。
      const done = finished.get(call.call_id)
      if (done) return { result: done.result }
      if (running.has(call.call_id)) return { result: accepted(call.call_id) }
      // 开工前就判出来的(过期 / 没授权 / 参数不对 / 要先确认)也记进「最近调用」:人得看得到助理试过什么、为什么没做。
      const refuse = (outcome: DeviceActionOutcome) => {
        const result = stamp(call.call_id, outcome)
        const at = new Date(now()).toISOString()
        try {
          provider.record?.({
            callId: call.call_id,
            action: call.action,
            ...(call.caller ? { caller: call.caller } : {}),
            startedAt: at,
            finishedAt: at,
            ok: result.ok,
            ...(result.ok ? {} : { code: result.code, message: result.message }),
          })
        } catch {
          // 同 execute 里的 record:给人看的,记不下 ❌ 影响回话
        }
        return { result }
      }
      if (now() > Date.parse(call.deadline_at)) {
        return refuse({ ok: false, code: 'expired', message: '这次调用到这台设备时已经过了最晚开始时刻,没有执行' })
      }
      const permit = await Promise.resolve(provider.permit(call.action))
      if (!permit.ok) return refuse({ ok: false, code: permit.code, message: permit.message })
      const early = await Promise.resolve(provider.preflight?.(call.action, call.args) ?? null)
      if (early) return refuse(early)
      const job = execute(call)
        .catch((error: unknown) => log?.warn({ callId: call.call_id, err: error instanceof Error ? error.message : String(error) }, 'device action crashed'))
        .finally(() => running.delete(call.call_id))
      running.set(call.call_id, job)
      return { result: accepted(call.call_id) }
    },
    handleResultAck(payload) {
      const callId = payload && typeof payload === 'object' ? (payload as { call_id?: unknown }).call_id : undefined
      if (typeof callId !== 'string' || !callId) return { error: { code: 'invalid_args', message: 'call_id is required' } }
      const entry = finished.get(callId)
      if (entry?.resend) {
        clearInterval(entry.resend)
        entry.resend = undefined
      }
      return { result: { call_id: callId, acknowledged: Boolean(entry) } }
    },
    dispose() {
      disposed = true
      for (const entry of finished.values()) if (entry.resend) clearInterval(entry.resend)
      finished.clear()
    },
  }
}

function accepted(callId: string): DeviceActionAccepted {
  return { v: DEVICE_ACTION_PROTOCOL_VERSION, call_id: callId, state: 'accepted' }
}
