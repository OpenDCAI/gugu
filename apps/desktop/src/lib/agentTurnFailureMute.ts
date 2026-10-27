// 额度/模型类回合失败的「关掉就别再提醒」。
//
// 失败条原本只按 commandId 记关闭、且只记在组件内存里：额度用完的 agent 每收到一条消息就再失败一次，
// 每次都是一条新命令 ⇒ 关掉立刻又冒出来；切聊天组件重挂 ⇒ 关闭记录也丢了。额度是账号级的状态，
// 不是某一条投递的事，所以关闭落到 (本机用户, agent, 失败类别) 上、存 localStorage、跨聊天生效；
// 直到这位 agent 有一次投递成功（额度恢复 / 换了模型）才解除，之后再失败照常提醒。
// 限流、通用失败不在这里：它们仍是一次性的，按命令关闭。

import { agentModelUnavailable, agentQuotaReason } from '@gugu/core/shared/agentQuotaReason'
import type { AgentTurnFailure } from './agentTurnFailure'

export type AgentTurnFailureMuteKind = 'weekly' | 'monthly' | 'exhausted' | 'model-unavailable'
export type AgentTurnFailureMutes = Record<string, AgentTurnFailureMuteKind>

const STORAGE_PREFIX = 'gugu.agent-turn-failure-mute.'
const KINDS: readonly string[] = ['weekly', 'monthly', 'exhausted', 'model-unavailable']

export function agentTurnFailureMuteKind(raw: string | null | undefined): AgentTurnFailureMuteKind | null {
  const reason = agentQuotaReason(raw)
  if (reason && reason !== 'rate-limited') return reason
  return agentModelUnavailable(raw) ? 'model-unavailable' : null
}

export function agentTurnFailureMuted(mutes: AgentTurnFailureMutes, failure: Pick<AgentTurnFailure, 'agentUserId' | 'rawMessage'>): boolean {
  const kind = agentTurnFailureMuteKind(failure.rawMessage)
  return kind !== null && mutes[failure.agentUserId] === kind
}

export function readAgentTurnFailureMutes(userId: string): AgentTurnFailureMutes {
  const raw = window.localStorage.getItem(STORAGE_PREFIX + userId)
  if (!raw) return {}
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object') throw new Error(`agent turn failure mutes for ${userId} is not an object`)
  const mutes: AgentTurnFailureMutes = {}
  for (const [agentId, kind] of Object.entries(parsed)) if (typeof kind === 'string' && KINDS.includes(kind)) mutes[agentId] = kind as AgentTurnFailureMuteKind
  return mutes
}

export function writeAgentTurnFailureMutes(userId: string, mutes: AgentTurnFailureMutes): void {
  if (Object.keys(mutes).length === 0) window.localStorage.removeItem(STORAGE_PREFIX + userId)
  else window.localStorage.setItem(STORAGE_PREFIX + userId, JSON.stringify(mutes))
}
