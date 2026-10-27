import { agentQuotaReason, agentTurnFailureNeedsModelChoice, type AgentTurnFailure } from './agentTurnFailure'
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
    if (result?.reply_notice === 'in-chat') continue
    const rawMessage = typeof row.error === 'string' ? row.error : ''
    // 老宿主没记披露位置：只补明确的额度/模型原因，避免把已在聊天披露的其他旧失败又叠一层。
    if (result?.reply_notice !== 'context' && !agentQuotaReason(rawMessage) && !agentTurnFailureNeedsModelChoice(rawMessage)) continue
    const revision = typeof row.completed_at === 'string' ? row.completed_at : String(row.created_at ?? '')
    failures.push({ agentUserId: id, commandId: row.id, rawMessage, at: Date.parse(revision), revision })
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

export async function readStoredAgentTurnFailures(userId: string, chatId: string, threadRootId: string | null, agentIds: readonly string[]) {
  let query = identityDb.from('gugu_device_commands')
    .select('id,status,error,result,payload,created_at,completed_at')
    .eq('user_id', userId).eq('type', 'agent.deliver').eq('payload->>chat_id', chatId)
    .in('payload->>agent_user_id', [...agentIds])
  query = threadRootId ? query.eq('payload->>thread_root_id', threadRootId) : query.is('payload->>thread_root_id', null)
  const { data, error } = await query.order('created_at', { ascending: false }).limit(50)
  if (error) throw new Error(error.message)
  return { failures: storedAgentTurnFailures(data ?? [], agentIds), recovered: storedAgentRecoveries(data ?? [], agentIds) }
}
