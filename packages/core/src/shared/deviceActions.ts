/**
 * 设备动作(#7199 第二步):云端的 agent 调用户某台设备上的「单个动作」—— 建一条日程、发一个通知、读一个文件。
 * 收发规矩:设备把自己能做的动作登记在心跳里(`gugu_devices.capabilities.actions`,没授权的也登记、标不可用);
 * 调用走那台设备的设备 RPC 频道(`gugu:{device_id}:rpc`):请执行 → 收到 → 每 15 秒「还在跑」→ 结果 → 结果收到。
 * ❌ 不走 `gugu_device_commands`:type 有白名单(加类型要迁移库)、没有进度列,「掉线重领」还会把建日程做两遍。
 *
 * 这一份是**线上合同**:桌面、咕咕 server、手机(安卓壳)三端都按它收发;改字段 = 改合同,三端一起改。
 * 协议原文贴在 #7199 的评论里。
 */

/** 请执行(RPC 请求 type);设备的 `device.action:reply` = 收到(或开工前就判出来的终局结果)。 */
export const DEVICE_ACTION_RPC_TYPE = 'device.action'
/** 结果收到(RPC 请求 type,payload `{ call_id }`):设备据此停止重推结果。 */
export const DEVICE_ACTION_RESULT_ACK_RPC_TYPE = 'device.action.result_ack'
/** 设备推的事件(频道上的广播,没有 request_id)。 */
export const DEVICE_ACTION_PROGRESS_EVENT = 'device.action.progress'
export const DEVICE_ACTION_RESULT_EVENT = 'device.action.result'
/** 「收到」的等待:10 秒没回就用同一个 call_id 重发一次,再没有就是 no_answer。 */
export const DEVICE_ACTION_ACK_TIMEOUT_MS = 10_000
/** 没收到「结果收到」时重推结果的间隔与最长时长。 */
export const DEVICE_ACTION_RESULT_RESEND_MS = 5_000
export const DEVICE_ACTION_RESULT_RESEND_FOR_MS = 10 * 60_000
/** 设备留着的结果备份:最近 200 条、10 分钟内(同一个 call_id 重来时回它,❌ 再执行一次)。 */
export const DEVICE_ACTION_RESULT_BACKUP_LIMIT = 200
export const DEVICE_ACTION_RESULT_BACKUP_MS = 10 * 60_000
/** 所有动作共用的保留参数:用户已在聊天里点过头。 */
export const DEVICE_ACTION_CONFIRMED_ARG = 'confirmed'
export const DEVICE_ACTION_PROTOCOL_VERSION = 1
/** 默认 30 秒,最长 300 秒(调用方给的 timeout_ms 超出就按 300 秒算)。 */
export const DEVICE_ACTION_DEFAULT_TIMEOUT_MS = 30_000
export const DEVICE_ACTION_MAX_TIMEOUT_MS = 300_000
/** 执行中报「还在跑」的间隔。调用方连续 2 个间隔(30 秒)收不到进度,就当设备在执行中失联。 */
export const DEVICE_ACTION_PROGRESS_INTERVAL_MS = 15_000

export type DeviceActionRisk = 'low' | 'medium' | 'high'

/**
 * 不可用的原因:
 * - `not_granted`  用户在咕咕里没开(或关了)这一组动作;
 * - `os_permission` 系统权限没给(macOS 隐私与安全性 / 安卓运行时权限);
 * - `unsupported`  这台设备上做不了(系统版本、平台不支持)。
 */
export type DeviceActionUnavailableReason = 'not_granted' | 'os_permission' | 'unsupported'

/**
 * 什么时候要用户先在聊天里点头:
 * - `never`        直接执行;
 * - `always`       不带 `confirmed: true` 一律回 needs_confirmation(高风险、有副作用);
 * - `on_conflict`  先查冲突 / 重复,有才回 needs_confirmation(建日程撞了时间)。
 */
export type DeviceActionConfirmPolicy = 'never' | 'always' | 'on_conflict'

/** 登记清单里的一条(写在 `gugu_devices.capabilities.actions` 里)。 */
export interface DeviceActionManifestEntry {
  /** 动作名,`<组>.<动作>`,三端同一个名字指同一件事(如 `calendar.events.create`)。 */
  name: string
  /** 授权分组:设置里一组一个开关(如 `calendar`、`files`)。 */
  group: string
  /** 给人看的一句话(中文)。 */
  title: string
  /** 给 agent 看的说明:做什么、参数怎么填、回什么。 */
  description: string
  risk: DeviceActionRisk
  confirm: DeviceActionConfirmPolicy
  /** 参数的 JSON Schema(object)。 */
  input_schema: Record<string, unknown>
  available: boolean
  unavailable_reason?: DeviceActionUnavailableReason
  /** 不可用时给人看的一句话(如「在咕咕的 设置 → 设备 → 这台电脑能做的事 里打开「日历」」)。 */
  unavailable_detail?: string
}

/** `gugu_devices.capabilities.actions` 整块。 */
export interface DeviceActionsCapability {
  v: number
  /** 这台设备的时区(IANA,如 Asia/Shanghai):agent 算「明天下午 3 点」要用设备的时区,❌ 用自己机器的。 */
  timezone?: string
  actions: DeviceActionManifestEntry[]
  /**
   * 这台设备有、但被它的 App 关掉的分组(电脑控制 = Computer Use 没装或停用,#7317):名下动作不登记(agent 不读、
   * 不占 token),点名调用其中一个时回 detail,如实说没装或停用了,❌ 只回「没有登记这个动作」。
   */
  switched_off?: DeviceActionsSwitchedOff[]
}

export interface DeviceActionsSwitchedOff {
  group: string
  /** 给 agent 看的一句话:哪个 App 没装或停用了、去哪打开。 */
  detail: string
}

/** 调用方写进命令 payload 的那一份。 */
export interface DeviceActionCallPayload {
  v: number
  /** 这次调用的 id(uuid)。设备按它去重:同一个 call_id 重领到,回已有的结果,❌ 再执行一次。 */
  call_id: string
  action: string
  args: Record<string, unknown>
  timeout_ms: number
  /** 过了这个时刻(ISO)还没开始执行的,设备不再执行、回 `expired`(掉线很久后重领到的旧命令)。 */
  deadline_at: string
  /** Display-only caller metadata. task_title is the host's actual task title,
   * independent of the Agent's canonical name; older senders may omit it. */
  caller?: { agent_user_id?: string; name?: string; task_title?: string }
}

/** 「收到」:`device.action:reply` 的 result(开工前就判出来的,reply 里直接是终局的 DeviceActionResult)。 */
export interface DeviceActionAccepted {
  v: number
  call_id: string
  state: 'accepted'
}

/** 执行中每 15 秒推的事件(`type = device.action.progress`)。 */
export interface DeviceActionProgress {
  v: number
  state: 'running'
  call_id: string
  /** 设备开始执行的时刻 / 最近一次报进度的时刻(ISO)。 */
  started_at: string
  progress_at: string
  /** 可选:正在做什么(给人和 agent 看)。 */
  note?: string
}

export type DeviceActionErrorCode =
  /** 设备离线(调用方发之前就判出来,命令根本没发)。 */
  | 'device_offline'
  /** 不是这个账号名下的设备。 */
  | 'unknown_device'
  /** Device actions are executed only by an Agent on that device. */
  | 'device_scope_mismatch'
  /** 发出去了,但设备没回「收到」(重发一次仍没有),或执行中 30 秒收不到进度。 */
  | 'no_answer'
  /** 这台设备没登记这个动作(拼错了,或这台设备做不了)。 */
  | 'unknown_action'
  /** 用户在咕咕里没开这一组。 */
  | 'not_granted'
  /** 系统权限没给。 */
  | 'os_permission'
  /** 参数不对(缺字段、类型不对、路径不在授权的文件夹里……)。 */
  | 'invalid_args'
  /** 要用户先在聊天里点头:带着 `confirm` 说明,用户同意后带 `confirmed: true` 再调一次。 */
  | 'needs_confirmation'
  /** 执行失败(原文进设备日志,这里是一句人话 + 简短原因)。 */
  | 'execution_failed'
  /** 执行超时(timeout_ms 到了还没结果)。 */
  | 'timeout'
  /** 执行中授权被撤销。 */
  | 'revoked'
  /** 命令过了 deadline_at 才被领到,没执行。 */
  | 'expired'
  /** 设备上的咕咕太旧,不认这个协议版本。 */
  | 'unsupported'

export type DeviceActionResult =
  | { v: number; ok: true; call_id: string; data: unknown }
  | {
      v: number
      ok: false
      call_id: string
      code: DeviceActionErrorCode
      message: string
      /** needs_confirmation 时:要用户确认什么。 */
      confirm?: { question: string; details?: unknown }
    }

export function clampDeviceActionTimeout(timeoutMs: unknown): number {
  const n = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? Math.round(timeoutMs) : DEVICE_ACTION_DEFAULT_TIMEOUT_MS
  return Math.min(Math.max(n, 1_000), DEVICE_ACTION_MAX_TIMEOUT_MS)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** 解析命令 payload;不像就回 null(调用方据此回 `unsupported` / `invalid_args`)。 */
export function parseDeviceActionCallPayload(raw: unknown): DeviceActionCallPayload | null {
  if (!isRecord(raw)) return null
  const callId = typeof raw.call_id === 'string' ? raw.call_id.trim() : ''
  const action = typeof raw.action === 'string' ? raw.action.trim() : ''
  if (!callId || !action) return null
  const deadline = typeof raw.deadline_at === 'string' && Number.isFinite(Date.parse(raw.deadline_at)) ? raw.deadline_at : ''
  if (!deadline) return null
  const caller = isRecord(raw.caller)
    ? {
        ...(typeof raw.caller.agent_user_id === 'string' ? { agent_user_id: raw.caller.agent_user_id } : {}),
        ...(typeof raw.caller.name === 'string' ? { name: raw.caller.name } : {}),
        ...(typeof raw.caller.task_title === 'string' && raw.caller.task_title.trim() ? { task_title: raw.caller.task_title.trim() } : {}),
      }
    : undefined
  return {
    v: typeof raw.v === 'number' ? raw.v : DEVICE_ACTION_PROTOCOL_VERSION,
    call_id: callId,
    action,
    args: isRecord(raw.args) ? raw.args : {},
    timeout_ms: clampDeviceActionTimeout(raw.timeout_ms),
    deadline_at: deadline,
    ...(caller ? { caller } : {}),
  }
}

const ERROR_CODES: ReadonlySet<string> = new Set<DeviceActionErrorCode>([
  'device_offline', 'unknown_device', 'no_answer', 'unknown_action', 'not_granted', 'os_permission', 'invalid_args', 'needs_confirmation',
  'execution_failed', 'timeout', 'revoked', 'expired', 'unsupported', 'device_scope_mismatch',
])

export function isDeviceActionAccepted(raw: unknown): raw is DeviceActionAccepted {
  return isRecord(raw) && raw.state === 'accepted' && typeof raw.call_id === 'string'
}

/** 读一份终局结果(reply 里的,或 `device.action.result` 事件里的);不像就回 null。 */
export function readDeviceActionResult(raw: unknown): DeviceActionResult | null {
  if (!isRecord(raw) || typeof raw.ok !== 'boolean') return null
  const callId = typeof raw.call_id === 'string' ? raw.call_id : ''
  const v = typeof raw.v === 'number' ? raw.v : DEVICE_ACTION_PROTOCOL_VERSION
  if (raw.ok) return { v, ok: true, call_id: callId, data: raw.data ?? null }
  const code = typeof raw.code === 'string' && ERROR_CODES.has(raw.code) ? (raw.code as DeviceActionErrorCode) : 'execution_failed'
  const confirm = isRecord(raw.confirm) && typeof raw.confirm.question === 'string'
    ? { question: raw.confirm.question, ...(raw.confirm.details !== undefined ? { details: raw.confirm.details } : {}) }
    : undefined
  return {
    v,
    ok: false,
    call_id: callId,
    code,
    message: typeof raw.message === 'string' ? raw.message : code,
    ...(confirm ? { confirm } : {}),
  }
}

export function readDeviceActionProgress(raw: unknown): DeviceActionProgress | null {
  if (!isRecord(raw) || raw.state !== 'running') return null
  const progressAt = typeof raw.progress_at === 'string' ? raw.progress_at : ''
  const startedAt = typeof raw.started_at === 'string' ? raw.started_at : progressAt
  if (!progressAt) return null
  return {
    v: typeof raw.v === 'number' ? raw.v : DEVICE_ACTION_PROTOCOL_VERSION,
    state: 'running',
    call_id: typeof raw.call_id === 'string' ? raw.call_id : '',
    started_at: startedAt,
    progress_at: progressAt,
    ...(typeof raw.note === 'string' && raw.note ? { note: raw.note } : {}),
  }
}

/** 读 `gugu_devices.capabilities.actions`;不是这个形状就回 null(老版本的设备不登记)。 */
export function normalizeDeviceActionsCapability(raw: unknown): DeviceActionsCapability | null {
  if (!isRecord(raw) || !Array.isArray(raw.actions)) return null
  const actions: DeviceActionManifestEntry[] = []
  for (const item of raw.actions) {
    if (!isRecord(item)) continue
    const name = typeof item.name === 'string' ? item.name : ''
    if (!name) continue
    const risk = item.risk === 'low' || item.risk === 'high' ? item.risk : 'medium'
    const confirm = item.confirm === 'always' || item.confirm === 'on_conflict' ? item.confirm : 'never'
    const reason = item.unavailable_reason === 'not_granted' || item.unavailable_reason === 'os_permission' || item.unavailable_reason === 'unsupported'
      ? item.unavailable_reason
      : undefined
    actions.push({
      name,
      group: typeof item.group === 'string' ? item.group : name.split('.')[0] ?? name,
      title: typeof item.title === 'string' ? item.title : name,
      description: typeof item.description === 'string' ? item.description : '',
      risk,
      confirm,
      input_schema: isRecord(item.input_schema) ? item.input_schema : { type: 'object' },
      available: item.available === true,
      ...(reason ? { unavailable_reason: reason } : {}),
      ...(typeof item.unavailable_detail === 'string' && item.unavailable_detail ? { unavailable_detail: item.unavailable_detail } : {}),
    })
  }
  return {
    v: typeof raw.v === 'number' ? raw.v : DEVICE_ACTION_PROTOCOL_VERSION,
    ...(typeof raw.timezone === 'string' && raw.timezone ? { timezone: raw.timezone } : {}),
    actions,
    ...withSwitchedOff(raw.switched_off),
  }
}

function withSwitchedOff(raw: unknown): { switched_off?: DeviceActionsSwitchedOff[] } {
  if (!Array.isArray(raw)) return {}
  const off = raw.filter(isRecord).flatMap((item) =>
    typeof item.group === 'string' && item.group && typeof item.detail === 'string' && item.detail ? [{ group: item.group, detail: item.detail }] : []
  )
  return off.length > 0 ? { switched_off: off } : {}
}

/** 这个动作所在的分组被它的 App 关掉了:回那一条,否则 null。 */
export function switchedOffGroupOf(capability: DeviceActionsCapability, action: string): DeviceActionsSwitchedOff | null {
  return capability.switched_off?.find((off) => action.startsWith(`${off.group}.`)) ?? null
}

/** Built by the receiving host, never from caller-supplied device claims. */
export function deviceScopeError(deviceId: string) {
  return { code: 'device_scope_mismatch' as const, message: `设备能力只能由这台设备上的任务 Agent 使用。请在这台设备上创建任务 Agent：session_spawn device="device:${deviceId}"。若任务宿主未启用，请主人先到那台设备开启任务宿主；不能由其他设备代调。` }
}
