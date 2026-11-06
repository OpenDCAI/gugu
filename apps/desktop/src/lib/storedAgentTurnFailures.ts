import { AGENT_FAILURE_REASONS, agentFailureNeedsModelChoice, agentFailureReason, type AgentFailureReason } from '@gugu/core/shared/agentQuotaReason'
import type { AgentTurnFailure } from './agentTurnFailure'
import { identityDb } from './supabase'

export type StoredAgentTurnFailure = AgentTurnFailure & { revision: string }

/** What happened to a message sent to an agent that has since left this chat. Its other failures left with it. */
function departedAgentStillOwes(reason: AgentFailureReason): boolean {
  return reason === 'deliveryRejected' || reason === 'outcomeUnknown'
}

/**
 * 每位 Agent 只认当前聊天/话题的最新投递；后来的成功或重试会盖掉以前的失败。
 * `includeDeparted`: the rows of one chat name every agent it delivered to, current member or not, so a removed agent's undelivered message still reaches its owner.
 */
export function storedAgentTurnFailures(rows: unknown[], agentIds: readonly string[], includeDeparted = false): StoredAgentTurnFailure[] {
  const seen = new Set<string>()
  const failures: StoredAgentTurnFailure[] = []
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    const payload = row.payload && typeof row.payload === 'object' ? row.payload as Record<string, unknown> : null
    const id = payload?.agent_user_id
    const departed = !agentIds.includes(id as string)
    if (typeof id !== 'string' || (departed && !includeDeparted) || seen.has(id)) continue
    seen.add(id)
    if (row.status !== 'error' || typeof row.id !== 'string') continue
    const result = row.result && typeof row.result === 'object' ? row.result as Record<string, unknown> : null
    // 宿主在聊天里说过的（in-chat）由聊天说；只认它留给 composer 的（context），原因是宿主落的码。
    const recorded = AGENT_FAILURE_REASONS.find((known) => known === result?.reason)
    const reason = recorded ? (result?.reply_notice === 'context' ? recorded : null) : olderHostReason(row, result)
    if (!reason || (departed && !departedAgentStillOwes(reason))) continue
    const revision = typeof row.completed_at === 'string' ? row.completed_at : String(row.created_at ?? '')
    failures.push({ agentUserId: id, commandId: row.id, reason, at: Date.parse(revision), revision, departed })
  }
  return failures
}

/**
 * 向下兼容一档 —— 下一档删除:宿主 ≤ 0.3.1 落失败命令时不记 `reason`,只有原文(`error`)和 `reply_notice`(更老的连它也没有)。
 * 0.3.2 起宿主都记原因码;0.3.3 删掉这个函数和 `olderHostReason` 的调用(届时也不再需要 RPC 投影 `error`)。
 * 判据照旧:留给 composer 的(context)按原文分类;额度/模型类就算旧宿主在聊天里写过行、或没标位置,也是 agent 的状态位。
 */
function olderHostReason(row: Record<string, unknown>, result: Record<string, unknown> | null): AgentFailureReason | null {
  // A projection may carry the key with null (read_agent_turn_outcomes builds it for every row): null is "not recorded".
  if (result?.reason != null) return null
  const reason = agentFailureReason(typeof row.error === 'string' ? row.error : '') ?? 'generic'
  return result?.reply_notice === 'context' || agentFailureNeedsModelChoice(reason) ? reason : null
}

/** 最新一次投递已成功的 Agent：额度/模型类的「关掉别再提醒」到这里解除。 */
export function storedAgentRecoveries(rows: unknown[], agentIds: readonly string[]): string[] {
  const seen = new Set<string>()
  const recovered: string[] = []
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    const payload = row.payload && typeof row.payload === 'object' ? row.payload as Record<string, unknown> : null
    const id = payload?.agent_user_id
    if (typeof id !== 'string' || !agentIds.includes(id) || seen.has(id)) continue
    seen.add(id)
    if (row.status === 'done') recovered.push(id)
  }
  return recovered
}

/** Where the failures are read: one chat line (the chat's composer), or every line of these agents (their task page). */
export type StoredFailureScope = { chatId: string; threadRootId: string | null } | 'any-chat'

export async function readStoredAgentTurnFailures(scope: StoredFailureScope, agentIds: readonly string[]) {
  // A null chat reads the latest delivery per agent over every chat (gugu-supabase: read_agent_turn_outcomes with p_chat_id null).
  const { data, error } = await identityDb.rpc('read_agent_turn_outcomes', {
    p_chat_id: scope === 'any-chat' ? null : scope.chatId,
    p_thread_root_id: scope === 'any-chat' ? null : scope.threadRootId || null,
  })
  if (error) throw new Error(error.message)
  return { failures: storedAgentTurnFailures(data ?? [], agentIds, scope !== 'any-chat'), recovered: storedAgentRecoveries(data ?? [], agentIds) }
}
