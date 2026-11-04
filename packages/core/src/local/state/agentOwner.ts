type AgentRosterRecord = { cache?: Record<string, unknown> | null; ownerId?: string; status?: string | null }

// #4277 会话不带账号,但 agent 身份有主人:名册行在 cache 里记着它归哪个咕咕账号(缓存云端
// identity.users.owner_user_id 这个既有事实)。同一台机器上换账号时,别家的行**留着**(它的主人回来
// 还要用),只是本账号的运行时巡扫(标在线 / 发活动 / 刷 token / 下线)一律跳过它。
// 没记 owner 的是老行,归属未知:照旧当本账号的处理(单账号机器上永远正确;多账号机器上首次被打开
// 时会被 provisioning 问一次云端并补上)。
export const AGENT_OWNER_CACHE_KEY = 'sessionpage_owner_user_id'

export function agentOwnerUserId(record: AgentRosterRecord | null | undefined): string {
  const value = record?.ownerId ?? record?.cache?.[AGENT_OWNER_CACHE_KEY]
  return typeof value === 'string' ? value : ''
}

/** 这行可能归这个账号吗:记了 owner 就比对,没记的按「可能」。 */
export function agentMayBelongTo(
  record: AgentRosterRecord | null | undefined,
  ownerUserId: string | null | undefined
): boolean {
  const recorded = agentOwnerUserId(record)
  if (!recorded || !ownerUserId) return true
  return recorded === ownerUserId
}

/** 运行时巡扫的候选行:只留可能归这个账号的。 */
export function agentsForOwner<T extends AgentRosterRecord>(
  agents: readonly T[],
  ownerUserId: string | null | undefined,
  options: { includeArchived?: boolean } = {},
): T[] {
  return agents.filter((agent) => agentMayBelongTo(agent, ownerUserId) && (options.includeArchived || agent.status !== 'archived'))
}

/** The single roster archival mutation; each host retains its existing persistence. */
export function archiveAgentRecord<T extends AgentRosterRecord>(record: T): T {
  record.status = 'archived'
  return record
}
