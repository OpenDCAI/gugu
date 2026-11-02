import { AGENT_FAILURE_REASONS } from '@gugu/core/shared/agentQuotaReason'
import type { AgentTurnFailure } from './agentTurnFailure'
import { identityDb } from './supabase'

export type StoredAgentTurnFailure = AgentTurnFailure & { revision: string }

/** 每位 Agent 只认当前聊天/话题的最新投递；后来的成功或重试会盖掉以前的失败。 */
export function storedAgentTurnFailures(rows: unknown[], agentIds: readonly string[]): StoredAgentTurnFailure[] {
  const seen = new Set<string>()
  const failures: StoredAgentTurnFailure[] = []
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    const payload = row.payload && typeof row.payload === 'object' ? row.payload as Record<string, unknown> : null
    const id = payload?.agent_user_id
    if (typeof id !== 'string' || !agentIds.includes(id) || seen.has(id)) continue
    seen.add(id)
    if (row.status !== 'error' || typeof row.id !== 'string') continue
    const result = row.result && typeof row.result === 'object' ? row.result as Record<string, unknown> : null
    // 宿主在聊天里说过的（in-chat）由聊天说；只认它留给 composer 的（context），原因是宿主落的码。
    // 没记原因的旧宿主行不显示：宿主升级后它的新失败自然带上。
    const reason = AGENT_FAILURE_REASONS.find((known) => known === result?.reason)
    if (result?.reply_notice !== 'context' || !reason) continue
    const revision = typeof row.completed_at === 'string' ? row.completed_at : String(row.created_at ?? '')
    failures.push({ agentUserId: id, commandId: row.id, reason, at: Date.parse(revision), revision })
  }
  return failures
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

export async function readStoredAgentTurnFailures(chatId: string, threadRootId: string | null, agentIds: readonly string[]) {
  const { data, error } = await identityDb.rpc('read_agent_turn_outcomes', {
    p_chat_id: chatId,
    p_thread_root_id: threadRootId || null,
  })
  if (error) throw new Error(error.message)
  return { failures: storedAgentTurnFailures(data ?? [], agentIds), recovered: storedAgentRecoveries(data ?? [], agentIds) }
}
