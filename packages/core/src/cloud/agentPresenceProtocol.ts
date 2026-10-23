import { unwrapPayload } from './payload'
import {
  isAgentAccountStatus,
  isAgentActivityStatus,
} from '../shared/ui/agentConversationStatusModels'
import type {
  AgentAccountStatus,
  AgentActivityStatus,
  AgentType,
} from '../shared/types/chat'
import { parseAgentStatus, parseAgentStatusDetail, type AgentStatusView } from '../shared/agentStatus'
import { VALID_AGENT_TYPES } from '../agentTypes'

// @@@agent-presence-protocol - Parse the unified presence payload emitted by identity.broadcast_agent_presence_from_runtime

export type AgentPresencePayload = {
  agentUserId: string
  accountStatus: AgentAccountStatus
  // 在不在线 = 设备行(deviceStatus)+ owner 意图(desiredStatus)。载荷里的 runtime_status / derived_status 不读:
  // desired=online 时它们的 offline 本来就改不了结果,后端也已不再计算 / 不再听它们。
  desiredStatus: 'online' | 'offline' | null
  activityStatus: AgentActivityStatus
  /**
   * 跑这个 agent 的宿主写下的读数(spec agent-status-vocabulary:基础态 + 附属态)。`activityStatus` 是它的
   * running/idle 投影,留给老客户端;`null` = 这一行没有读数(老宿主写的、下线 / 建 / 停这类说不出读数的写),
   * 读方退回 `activityStatus`。
   */
  status: AgentStatusView | null
  runtimeKind: string | null
  runtimeLabel: string | null
  // @@@agent-engine (#994b) - the agent's static LLM engine (agent_profiles.agent_type), joined into the
  // unified presence payload so every surface (单聊头 / 成员卡 / 群面板) reads engine from one source — no
  // per-component fetch. null 的含义按生命周期分流(#2262):accountStatus='removed' 时 null 是 #2219 tombstone
  // 的契约形状(removed 无 live 引擎);'active' 时 null = no agent_profiles row(数据异常) or unknown value →
  // 消费方对 active 载荷 fail loud(不静默省略),对 removed 不误报。
  agentType: AgentType | null
  // @@@recent-actions (#518) - the agent's recent tool-action sequence (names only) for the presence
  recentActions: string[]
  // @@@last-action-at (#437) - the agent's real newest tool-action time (ISO), from the shared runtime
  lastActionAt: string | null
  windowTitle: string | null
  pid: number | null
  deviceId: string | null
  deviceStatus: 'online' | 'offline' | null
  // @@@host-runtime-capability (#647) - the agent host's gugu runtime capability level. The renderer
  // @@@1402 null = 未上报/未知（旧主机或 payload 未带该字段）→ badge 不亮（不当成 0=已知旧）。
  hostRuntimeCapability: number | null
  // @@@2175 连续异常 deliver 回合计数(payload 单源函数 COALESCE 到 0);渲染按阈值派生「异常」态。
  // 缺字段(旧 payload)→ 0 = 不判异常,向后兼容。
  consecutiveDeliverFailures: number
  updatedAt: string
}

type RawPresence = {
  agent_user_id?: unknown
  account_status?: unknown
  desired_status?: unknown
  activity_status?: unknown
  agent_status?: unknown
  agent_status_detail?: unknown
  runtime_kind?: unknown
  runtime_label?: unknown
  agent_type?: unknown
  recent_actions?: unknown
  last_action_at?: unknown
  window_title?: unknown
  pid?: unknown
  device_id?: unknown
  device_status?: unknown
  device_last_seen_at?: unknown
  host_runtime_capability?: unknown
  consecutive_deliver_failures?: unknown
  updated_at?: unknown
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function asTimestamp(value: unknown): string | null {
  const text = asString(value)
  return text && Number.isFinite(Date.parse(text)) ? text : null
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

// @@@2175 计数字段:非负整数才可信,其余(缺失/负数/小数/非数)→ null 由调用侧定语义。
function asNonNegativeInt(value: unknown): number | null {
  const n = asNumber(value)
  return n !== null && Number.isInteger(n) && n >= 0 ? n : null
}

// 库里这两列有 CHECK 约束,词表外的值到不了这里;真到了是协议被破坏 ⇒ `undefined`,整份载荷作废(与其它必填字段
// 坏掉同一个结局:调用方记成读错),❌ 当成「没有读数」静默退回 activity。
function asStatusView(status: unknown, detail: unknown): AgentStatusView | null | undefined {
  try {
    const base = parseAgentStatus(status)
    return base === null ? null : { status: base, detail: parseAgentStatusDetail(detail, base) }
  } catch {
    return undefined
  }
}

function asDeviceStatus(value: unknown): 'online' | 'offline' | null {
  return value === 'online' || value === 'offline' ? value : null
}

function asOnlineOffline(value: unknown): 'online' | 'offline' | null {
  return value === 'online' || value === 'offline' ? value : null
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
}

// @@@agent-engine (#994b/#3816) - 透传 identity.agent_profiles 的完整声明白名单。
// session-page harness identities（例如 pi、droid、oh-my-pi）现在也会持久化到该表；把它们
// 在这里丢成 null 会让 active presence 被 UI 误报成「缺 agent_type」，并掩盖真实投递结果。
// 具体是否在 header 展示友好引擎名由 agentEngineDisplayName 决定；协议层不能丢失已通过
// normalizeAgentType + DB CHECK 的值。未知/畸形值仍返回 null，绝不默认成某个引擎。
function asAgentType(value: unknown): AgentType | null {
  return typeof value === 'string' && VALID_AGENT_TYPES.includes(value as AgentType)
    ? value as AgentType
    : null
}

export function parseAgentPresencePayload(raw: unknown): AgentPresencePayload | null {
  const unwrapped = unwrapPayload(raw)
  const presence = (unwrapped.presence ?? unwrapped) as RawPresence | undefined
  if (!presence || typeof presence !== 'object') return null
  const agentUserId = asString(presence.agent_user_id)
  if (!agentUserId) return null
  if (!isAgentAccountStatus(presence.account_status)) return null
  const updatedAt = asTimestamp(presence.updated_at)
  if (!updatedAt) return null
  const status = asStatusView(presence.agent_status, presence.agent_status_detail)
  if (status === undefined) return null

  return {
    agentUserId,
    accountStatus: presence.account_status,
    desiredStatus: asOnlineOffline(presence.desired_status),
    activityStatus: isAgentActivityStatus(presence.activity_status) ? presence.activity_status : 'idle',
    status,
    runtimeKind: asString(presence.runtime_kind),
    runtimeLabel: asString(presence.runtime_label),
    agentType: asAgentType(presence.agent_type),
    recentActions: asStringArray(presence.recent_actions),
    lastActionAt: asString(presence.last_action_at),
    windowTitle: asString(presence.window_title),
    pid: asNumber(presence.pid),
    deviceId: asString(presence.device_id),
    deviceStatus: asDeviceStatus(presence.device_status),
    // @@@1402 不要 `?? 0`：未上报 → null（未知）透传，而非伪装成 0（已知旧）→ 否则旧主机/缺字段永远误报 stale。
    hostRuntimeCapability: asNumber(presence.host_runtime_capability),
    // @@@2175 与 #1402 相反这里 `?? 0` 是对的:0 与缺失同义(都 = 无异常证据,不点灯),不存在误报面。
    // 负数/非整(畸形)也归 0——灯只由可信计数点亮。
    consecutiveDeliverFailures: asNonNegativeInt(presence.consecutive_deliver_failures) ?? 0,
    updatedAt,
  }
}
