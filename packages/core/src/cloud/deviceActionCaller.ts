/**
 * 设备动作的「调用方」(#7199 第二步):agent 的 device_call 从这里发。先查那台设备在不在,在才发「请执行」;
 * 10 秒没回「收到」用同一个 call_id 重发一次;执行中 30 秒收不到「还在跑」当失联;拿到结果回「结果收到」。
 * ❌ 设备不在线时排队、❌ 装作已经发出去 —— 当场说清是哪台、为什么。
 *
 * 不碰 node / electron:管道(设备 RPC 请求方)与设备清单由调用方给;设备推来的事件经 `onEvent` 交进来。
 */
import {
  DEVICE_ACTION_ACK_TIMEOUT_MS,
  DEVICE_ACTION_PROGRESS_EVENT,
  DEVICE_ACTION_PROGRESS_INTERVAL_MS,
  DEVICE_ACTION_PROTOCOL_VERSION,
  DEVICE_ACTION_RESULT_ACK_RPC_TYPE,
  DEVICE_ACTION_RESULT_EVENT,
  DEVICE_ACTION_RPC_TYPE,
  clampDeviceActionTimeout,
  deviceScopeError,
  isDeviceActionAccepted,
  normalizeDeviceActionsCapability,
  readDeviceActionResult,
  switchedOffGroupOf,
  type DeviceActionCallPayload,
  type DeviceActionErrorCode,
  type DeviceActionManifestEntry,
  type DeviceActionResult,
} from '../shared/deviceActions'
import type { DeviceRpcResponse } from './deviceRpcProtocol'
import { unwrapPayload } from './payload'

/** 调用方看到的一台设备(gugu_devices 那一行里用得上的几格)。 */
export interface DeviceActionTarget {
  device_id: string
  label: string
  platform?: string | null
  online: boolean
  last_seen_at: string | null
  /** `capabilities.actions`(原样,这里再解析)。 */
  actions?: unknown
  /** 是不是发起调用的这台机器自己。 */
  this_machine?: boolean
}

export interface DeviceActionCallerDeps {
  listDevices(): Promise<DeviceActionTarget[]>
  rpc(deviceId: string, type: string, payload: unknown, options: { timeoutMs: number; signal?: AbortSignal }): Promise<DeviceRpcResponse<unknown>>
  newCallId?: () => string
  now?: () => number
}

export interface DeviceActionCallInput {
  deviceId: string
  action: string
  args?: Record<string, unknown>
  timeoutMs?: number
  caller?: DeviceActionCallPayload['caller']
  signal?: AbortSignal
}

export interface DeviceActionCaller {
  call(input: DeviceActionCallInput): Promise<DeviceActionResult>
  /** 设备频道上收到的、不是应答的广播;是本模块的(进度 / 结果)就吃掉并回 true。 */
  onEvent(deviceId: string, payload: unknown): boolean
  /**
   * 我的设备与各自的动作清单(给 device_actions 工具)。不给 deviceId = 每台只列动作名 / 能不能用(紧凑,一台 Mac 的
   * 全量说明加参数 schema 有 8KB,几台设备一起列会被 harness 截坏 —— 实测 agent 读成了 actions:null);
   * 给 deviceId = 那一台的全量(说明、参数 schema、风险、确认方式)。
   */
  /**
   * 三层,省 agent 的上下文(一台 Mac 登记一百多个动作):
   * - 不带 deviceId:每台设备按分组汇总(组名、能不能用、名下动作名);
   * - 带 deviceId:那台的每个动作一行(名字、标题、能不能用、风险、确认策略),不带说明与参数;
   * - 再带 group 或 name:那一组 / 那一个动作的全量(说明 + input_schema)—— device_call 之前读它。
   */
  describe(deviceId?: string, filter?: { group?: string; name?: string }): Promise<DeviceActionDeviceView[]>
}

export interface DeviceActionDeviceView {
  device_id: string
  label: string
  platform: string | null
  online: boolean
  last_seen_at: string | null
  this_machine: boolean
  /** 这台设备的时区(IANA):「明天下午 3 点」按它算。 */
  timezone: string | null
  /** null = 这台设备上的咕咕还不登记动作(版本太旧,或手机还没接)。不带 device 时是分组汇总,见 describe。 */
  groups?: DeviceActionGroupBrief[] | null
  actions?: Array<DeviceActionManifestEntry | DeviceActionBrief> | null
}

export type DeviceActionBrief = Pick<DeviceActionManifestEntry, 'name' | 'title' | 'available' | 'risk' | 'confirm' | 'unavailable_reason' | 'unavailable_detail'>

export interface DeviceActionGroupBrief {
  group: string
  /** 这一组里有能用的动作。 */
  available: boolean
  /** 名下全部动作名(能不能用以 available 为准)。 */
  actions: string[]
  /** 整组都不能用时:为什么、去哪打开(取自组里第一个不可用动作)。 */
  unavailable_reason?: DeviceActionManifestEntry['unavailable_reason']
  unavailable_detail?: string
}

type Waiter = {
  deviceId: string
  onProgress(): void
  onResult(result: DeviceActionResult): void
}

function minutesAgo(iso: string | null, now: number): string {
  if (!iso) return '时间未知'
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (minutes < 1) return '不到 1 分钟前'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} 小时前` : `${Math.round(hours / 24)} 天前`
}

export function createDeviceActionCaller(deps: DeviceActionCallerDeps): DeviceActionCaller {
  const now = deps.now ?? (() => Date.now())
  const newCallId = deps.newCallId ?? (() => globalThis.crypto.randomUUID())
  const waiters = new Map<string, Waiter>()

  const fail = (callId: string, code: DeviceActionErrorCode, message: string): DeviceActionResult =>
    ({ v: DEVICE_ACTION_PROTOCOL_VERSION, ok: false, call_id: callId, code, message })

  const view = (device: DeviceActionTarget, depth: 'groups' | 'actions' | 'full', filter: { group?: string; name?: string } = {}): DeviceActionDeviceView => {
    const manifest = normalizeDeviceActionsCapability(device.actions)
    const brief = (a: DeviceActionManifestEntry): DeviceActionBrief => ({
      name: a.name,
      title: a.title,
      available: a.available,
      risk: a.risk,
      confirm: a.confirm,
      ...(a.unavailable_reason ? { unavailable_reason: a.unavailable_reason } : {}),
      ...(a.unavailable_detail ? { unavailable_detail: a.unavailable_detail } : {}),
    })
    const base = {
      device_id: device.device_id,
      label: device.label,
      platform: device.platform ?? null,
      online: device.online,
      last_seen_at: device.last_seen_at,
      this_machine: device.this_machine === true,
      timezone: manifest?.timezone ?? null,
    }
    if (!manifest) return { ...base, ...(depth === 'groups' ? { groups: null } : { actions: null }) }
    if (depth === 'groups') {
      const groups = new Map<string, DeviceActionManifestEntry[]>()
      for (const a of manifest.actions) groups.set(a.group, [...(groups.get(a.group) ?? []), a])
      return {
        ...base,
        groups: [...groups.entries()].map(([group, list]) => {
          const available = list.some((a) => a.available)
          const blocked = available ? undefined : list.find((a) => a.unavailable_reason)
          return {
            group,
            available,
            actions: list.map((a) => a.name),
            ...(blocked?.unavailable_reason ? { unavailable_reason: blocked.unavailable_reason } : {}),
            ...(blocked?.unavailable_detail ? { unavailable_detail: blocked.unavailable_detail } : {}),
          }
        }),
      }
    }
    if (depth === 'actions') return { ...base, actions: manifest.actions.map(brief) }
    const picked = manifest.actions.filter((a) => (filter.name ? a.name === filter.name : true) && (filter.group ? a.group === filter.group : true))
    return { ...base, actions: picked }
  }

  return {
    async describe(deviceId, filter = {}) {
      const devices = await deps.listDevices()
      if (!deviceId) return devices.map((d) => view(d, 'groups'))
      const device = devices.find((d) => d.device_id === deviceId)
      if (!device) throw new Error(`你的账号下没有设备 ${deviceId}(不带 device 调 device_actions 列出你的设备)`)
      if (!filter.group && !filter.name) return [view(device, 'actions')]
      const full = view(device, 'full', filter)
      if (full.actions && full.actions.length === 0) {
        const manifest = normalizeDeviceActionsCapability(device.actions)
        const off = manifest && switchedOffGroupOf(manifest, filter.name ?? `${filter.group}.`)
        if (off) throw new Error(`${device.label}: ${off.detail}`)
        throw new Error(`${device.label} 上没有${filter.name ? `动作 ${filter.name}` : `分组 ${filter.group}`}(带 device 不带 group / name 调 device_actions 看它有哪些)`)
      }
      return [full]
    },

    onEvent(deviceId, payload) {
      const inner = unwrapPayload(payload)
      const type = typeof inner.type === 'string' ? inner.type : ''
      if (type !== DEVICE_ACTION_PROGRESS_EVENT && type !== DEVICE_ACTION_RESULT_EVENT) return false
      const callId = typeof inner.call_id === 'string' ? inner.call_id : ''
      const waiter = waiters.get(callId)
      // 别人(同账号的另一台桌面 / 手机)发的调用的事件也会出现在这条频道上:只认自己在等的。
      if (!waiter || waiter.deviceId !== deviceId) return true
      if (type === DEVICE_ACTION_PROGRESS_EVENT) {
        waiter.onProgress()
        return true
      }
      const result = readDeviceActionResult(inner.result)
      if (result) waiter.onResult({ ...result, call_id: result.call_id || callId })
      return true
    },

    async call(input) {
      const callId = newCallId()
      const devices = await deps.listDevices()
      const device = devices.find((d) => d.device_id === input.deviceId)
      if (!device) return fail(callId, 'unknown_device', `你的账号下没有设备 ${input.deviceId}(用 device_actions 列出你的设备)`)
      // this_machine is computed by the host's device directory, not by model input.
      if (device.this_machine !== true) {
        const error = deviceScopeError(device.device_id)
        return fail(callId, error.code, error.message)
      }
      if (!device.online) {
        return fail(callId, 'device_offline', `「${device.label}」现在离线(最后在线:${minutesAgo(device.last_seen_at, now())}),这次没有发出去;那台设备上的咕咕开着、联网后再试`)
      }
      const manifest = normalizeDeviceActionsCapability(device.actions)
      if (!manifest) {
        return fail(callId, 'unsupported', `「${device.label}」上的咕咕还不支持被调用动作(版本太旧或还没接入),更新那台设备上的咕咕后再试`)
      }
      if (!manifest.actions.some((a) => a.name === input.action)) {
        // Its group is there but its App is off (#7317): say so, not "no such action".
        const off = switchedOffGroupOf(manifest, input.action)
        if (off) return fail(callId, 'not_granted', `「${device.label}」: ${off.detail}`)
        return fail(callId, 'unknown_action', `「${device.label}」没有登记动作 ${input.action};它能做的:${manifest.actions.map((a) => a.name).join(', ') || '无'}`)
      }
      const timeoutMs = clampDeviceActionTimeout(input.timeoutMs)
      const startedAt = now()
      const payload: DeviceActionCallPayload = {
        v: DEVICE_ACTION_PROTOCOL_VERSION,
        call_id: callId,
        action: input.action,
        args: input.args ?? {},
        timeout_ms: timeoutMs,
        // 最晚开始时刻:两次「收到」等待之内还没开始的,设备就不该再做(掉线后才收到的旧请求)。
        deadline_at: new Date(startedAt + 2 * DEVICE_ACTION_ACK_TIMEOUT_MS + 5_000).toISOString(),
        ...(input.caller ? { caller: input.caller } : {}),
      }

      // 先挂上等结果的位置:结果可能比「收到」的应答先到(快动作 + 广播乱序)。
      let lastSign = now()
      let earlyResult: DeviceActionResult | null = null
      let settleResult: ((result: DeviceActionResult) => void) | null = null
      waiters.set(callId, {
        deviceId: device.device_id,
        onProgress: () => { lastSign = now() },
        onResult: (result) => {
          if (settleResult) settleResult(result)
          else earlyResult = result
        },
      })
      try {
        // ② 请执行 → ③ 收到(10 秒;没回就同一个 call_id 再发一次)。
        let reply: DeviceRpcResponse<unknown> | null = null
        let lastError: unknown = null
        for (let attempt = 0; attempt < 2 && !reply; attempt += 1) {
          try {
            reply = await deps.rpc(device.device_id, DEVICE_ACTION_RPC_TYPE, payload, { timeoutMs: DEVICE_ACTION_ACK_TIMEOUT_MS, signal: input.signal })
          } catch (error) {
            // 超时与管道断了都再发一次(同一个 call_id,设备按它去重);结果已经先到了就不必。
            lastError = error
            if (earlyResult) break
          }
        }
        if (earlyResult) return ackAndReturn(earlyResult)
        if (!reply) {
          const why = lastError instanceof Error ? lastError.message : String(lastError ?? '')
          return fail(callId, 'no_answer', `「${device.label}」没有回应(${Math.round((2 * DEVICE_ACTION_ACK_TIMEOUT_MS) / 1000)} 秒内两次都没回「收到」),这次可能没有执行;可能是那台设备上的咕咕刚关掉或断网了${why ? `(${why})` : ''}`)
        }
        if (reply.error) {
          // 老版本不认这个类型:unknown_method。
          if (reply.error.code === 'unknown_method') {
            return fail(callId, 'unsupported', `「${device.label}」上的咕咕不认识这个调用,更新那台设备上的咕咕后再试`)
          }
          return fail(callId, reply.error.code === 'device_scope_mismatch' ? reply.error.code : 'execution_failed', `「${device.label}」回了错误:${reply.error.message}`)
        }
        if (!isDeviceActionAccepted(reply.result)) {
          const final = readDeviceActionResult(reply.result)
          return final ? { ...final, call_id: final.call_id || callId } : fail(callId, 'execution_failed', `「${device.label}」的应答看不懂`)
        }
        lastSign = now()
        // ④ 还在跑 → ⑤ 结果。
        return await new Promise<DeviceActionResult>((resolve) => {
          const finish = (result: DeviceActionResult) => {
            clearInterval(watch)
            input.signal?.removeEventListener('abort', onAbort)
            settleResult = null
            resolve(result)
          }
          const onAbort = () => finish(fail(callId, 'execution_failed', '调用方取消了这次调用(设备上可能已经开始执行)'))
          input.signal?.addEventListener('abort', onAbort, { once: true })
          settleResult = (result) => finish(ackAndReturn(result))
          if (earlyResult) {
            finish(ackAndReturn(earlyResult))
            return
          }
          const watch = setInterval(() => {
            const t = now()
            if (t - startedAt > timeoutMs + 5_000) {
              finish(fail(callId, 'timeout', `「${device.label}」${Math.round(timeoutMs / 1000)} 秒内没交结果`))
            } else if (t - lastSign > 2 * DEVICE_ACTION_PROGRESS_INTERVAL_MS) {
              finish(fail(callId, 'no_answer', `「${device.label}」执行中失联(${Math.round((t - lastSign) / 1000)} 秒没报进度),不知道做完没有`))
            }
          }, 1_000)
          ;(watch as { unref?: () => void }).unref?.()
        })
      } finally {
        waiters.delete(callId)
      }

      function ackAndReturn(result: DeviceActionResult): DeviceActionResult {
        // ⑥ 结果收到:尽力而为,设备没收到就会再推几次,❌ 为它拖住这次调用。
        void deps.rpc(device!.device_id, DEVICE_ACTION_RESULT_ACK_RPC_TYPE, { call_id: callId }, { timeoutMs: DEVICE_ACTION_ACK_TIMEOUT_MS }).catch(() => undefined)
        return result
      }
    },
  }
}
