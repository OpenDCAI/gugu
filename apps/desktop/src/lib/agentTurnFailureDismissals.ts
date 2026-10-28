// 失败条「关掉」的记录：按命令记（commandId → 关掉时那一版 revision），存 localStorage。
//
// 失败条读的是这位 agent 在这个聊天里最新的那条投递命令；之后没人再找它，这条命令就一直是最新的（owner 10-28：
// Codex 91 一条 10-25 的旧失败，关掉、切走再回来又出现）。所以关掉要比组件活得久：重挂、重开 App 都认得。
// 同一命令重试后的新失败（revision 变了）、或一条新命令，照旧再提醒。

export type AgentTurnFailureDismissals = Record<string, { revision: string | null; at: number }>

const STORAGE_PREFIX = 'gugu.agent-turn-failure-dismissed.'
const MAX_ENTRIES = 200
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export function readAgentTurnFailureDismissals(userId: string): AgentTurnFailureDismissals {
  const raw = window.localStorage.getItem(STORAGE_PREFIX + userId)
  if (!raw) return {}
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object') throw new Error(`agent turn failure dismissals for ${userId} is not an object`)
  const dismissals: AgentTurnFailureDismissals = {}
  for (const [commandId, entry] of Object.entries(parsed)) {
    const { revision, at } = (entry ?? {}) as { revision?: unknown; at?: unknown }
    if ((typeof revision === 'string' || revision === null) && typeof at === 'number') dismissals[commandId] = { revision, at }
  }
  return dismissals
}

/** 只留 30 天内、最近的 200 条：一条命令关掉之后很快就会被更新的投递盖过，旧记录不必无限攒。 */
export function writeAgentTurnFailureDismissals(userId: string, dismissals: AgentTurnFailureDismissals, now = Date.now()): void {
  const kept = Object.entries(dismissals)
    .filter(([, entry]) => now - entry.at < MAX_AGE_MS)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_ENTRIES)
  if (kept.length === 0) window.localStorage.removeItem(STORAGE_PREFIX + userId)
  else window.localStorage.setItem(STORAGE_PREFIX + userId, JSON.stringify(Object.fromEntries(kept)))
}
