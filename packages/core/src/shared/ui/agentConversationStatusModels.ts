import type { AgentStatusView } from '../agentStatus'
import {
  agentStatusColorVar,
  type AgentReachability,
  type AgentStatusLabel,
  type AgentStatusTone,
} from '../agentStatusPresentation'
import type {
  AgentAccountStatus,
  AgentActivityStatus,
  AgentConversationActivityStatus,
  AgentDesiredStatus,
  AgentDisplayStatus,
  AgentRuntimeStatus,
} from '../types/chat'

export const AGENT_ACCOUNT_STATUSES: AgentAccountStatus[] = ['active', 'removed']
export const AGENT_RUNTIME_STATUSES: AgentRuntimeStatus[] = ['starting', 'online', 'offline']
export const AGENT_ACTIVITY_STATUSES: AgentActivityStatus[] = ['idle', 'running']

export const DEFAULT_AGENT_RUNTIME_STATUS: AgentRuntimeStatus = 'offline'
export const DEFAULT_AGENT_ACTIVITY_STATUS: AgentActivityStatus = 'idle'
export const DEFAULT_AGENT_DISPLAY_STATUS: AgentDisplayStatus = 'offline'

export const STARTING_AGENT_RUNTIME_STATUS: Extract<AgentRuntimeStatus, 'starting'> = 'starting'

export function isAgentAccountStatus(value: unknown): value is AgentAccountStatus {
  return typeof value === 'string' && AGENT_ACCOUNT_STATUSES.includes(value as AgentAccountStatus)
}

export function isAgentRuntimeStatus(value: unknown): value is AgentRuntimeStatus {
  return typeof value === 'string' && AGENT_RUNTIME_STATUSES.includes(value as AgentRuntimeStatus)
}

export function isAgentActivityStatus(value: unknown): value is AgentActivityStatus {
  return typeof value === 'string' && AGENT_ACTIVITY_STATUSES.includes(value as AgentActivityStatus)
}

export function normalizeAgentRuntimeStatus(value: unknown): AgentRuntimeStatus {
  return isAgentRuntimeStatus(value) ? value : DEFAULT_AGENT_RUNTIME_STATUS
}

export function normalizeAgentActivityStatus(value: unknown): AgentActivityStatus {
  return isAgentActivityStatus(value) ? value : DEFAULT_AGENT_ACTIVITY_STATUS
}

export function normalizeAgentConversationStatus(value: unknown): AgentConversationActivityStatus {
  return value === STARTING_AGENT_RUNTIME_STATUS ? STARTING_AGENT_RUNTIME_STATUS : normalizeAgentActivityStatus(value)
}

/** 有一轮在飞(运行条、忙态、头像脉冲按它)。后台在跑不是:回合已经关了,照收投递。 */
export function isTransientAgentConversationStatus(status: AgentDisplayStatus): boolean {
  return status === 'working'
}

/**
 * 可达(三根轴的第一根,只来自云端):账号生命周期(removed)> 设备可达(offline)> owner 意图(offline)。
 * 设备可达但没有活会话仍是在线:not-live 会话收到消息会被宿主恢复(#6168),进程在不在内存不让用户感知。
 * ❌ 每一档都要有证据;载荷缺失 = 从未观测过,由 store 的 pending 表达,不进这个函数。
 */
export function deriveAgentReachability(input: {
  accountStatus: AgentAccountStatus
  desiredStatus?: AgentDesiredStatus | null
  runtimeStatus: AgentRuntimeStatus
  deviceOnline: boolean
}): Exclude<AgentReachability, 'pending'> {
  if (input.accountStatus === 'removed') return 'removed'
  if (!input.deviceOnline) return 'offline'
  if (input.desiredStatus === 'offline') return 'offline'
  if (input.runtimeStatus === 'offline') return input.desiredStatus === 'online' ? 'online' : 'offline'
  return 'online'
}

/**
 * 云端那一行没有读数时(老宿主只写得出 running/idle 投影,或会话正在起)能陈述的那一句:正在起 / 在跑 = 一轮在飞,
 * 否则没有读数。❌ 从连续投递失败的计数推「出错」—— 出错只认宿主写入者(owner 2026-09-25)。
 */
export function readingOfPresenceProjection(input: {
  runtimeStatus: AgentRuntimeStatus
  activityStatus: AgentActivityStatus
}): AgentStatusView | null {
  return input.runtimeStatus === 'starting' || input.activityStatus === 'running'
    ? { status: 'working', detail: 'running' }
    : null
}

/** presentation 折成聊天侧的粗分类。 */
export function displayStatusOf(tone: AgentStatusTone): AgentDisplayStatus {
  switch (tone) {
    case 'running':
      return 'working'
    case 'parked':
    case 'needs_user':
    case 'error':
    case 'offline':
    case 'removed':
    case 'pending':
      return tone
    case 'done':
    case 'idle':
    case 'online':
    case 'none':
      return 'idle'
  }
}

/** 粗分类的那一句(群汇总、多个 agent 的一格用;单个 agent 读完整 presentation 的 `label`)。 */
export function labelOfDisplayStatus(status: AgentDisplayStatus): AgentStatusLabel {
  switch (status) {
    case 'working':
      return 'running'
    case 'needs_user':
      return 'needsAction'
    case 'idle':
      return 'online'
    case 'parked':
    case 'error':
    case 'offline':
    case 'removed':
    case 'pending':
      return status
  }
}

/** 粗分类的颜色(同一张 token 表)。 */
export function colorOfDisplayStatus(status: AgentDisplayStatus): string | null {
  return agentStatusColorVar(status === 'working' ? 'running' : status === 'idle' ? 'online' : status)
}
