import { listAgents, type LocalAgentRecord } from '@gugu/core'
import { AGENT_OWNER_CACHE_KEY, agentMayBelongTo } from '@gugu/core/local/state/agentOwner'

/** Roster cache keys written by the host's session-page provisioning flow. */
export const SESSIONPAGE_SESSION_CACHE_KEY = 'emdash_session_id'
export const SESSIONPAGE_PROJECT_CACHE_KEY = 'emdash_project_id'
export const SESSIONPAGE_GROUP_CHAT_CACHE_KEY = 'sessionpage_group_chat_id'
/**
 * #4277 会话不带账号:这两格让同一条会话在不同账号名下各有各的 agent。
 * - owner:这条记录的 agent 归哪个咕咕账号(缓存云端 identity.users.owner_user_id 这个既有事实;
 *   老记录没有这格,首次被打开时补上)。
 * - parked:别的账号驱动这条会话时,这条记录的绑定从 emdash_session_id 挪到这里「停放」——所有按
 *   emdash_session_id 找 agent 的读者于是只看得见当前活动的那一行;原账号回来时再挪回去。
 */
export const SESSIONPAGE_OWNER_CACHE_KEY: typeof AGENT_OWNER_CACHE_KEY = AGENT_OWNER_CACHE_KEY
export const SESSIONPAGE_PARKED_SESSION_CACHE_KEY = 'sessionpage_parked_session_id'

function cached(record: LocalAgentRecord | null, key: string): string {
  const value = record?.cache?.[key]
  return typeof value === 'string' ? value : ''
}

/** Resolve the local roster identity for a session-page conversation without importing host modules.
 *  #4277 传了 ownerUserId 就按当下账号看:活动行归别家 ⇒ 对这个账号「还没有身份」,返回 null。 */
export async function localAgentForSession(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  ownerUserId?: string | null,
): Promise<LocalAgentRecord | null> {
  const agents = await listAgents(env, { includeGuests: true })
  const candidates = agents.filter((agent) => agent.cache?.[SESSIONPAGE_SESSION_CACHE_KEY] === sessionId)
  const owned = ownerUserId
    ? candidates.filter((agent) => agentMayBelongTo(agent, ownerUserId))
    : candidates
  if (owned.length > 1) {
    throw new Error(
      `session-page identity lookup: session ${sessionId} maps to ${owned.length} canonical identities`,
    )
  }
  return owned[0] ?? null
}

/**
 * Every session-page conversation here that has an agent identity → that agent's id, `user:<uuid>`: one roster read. The
 * one id an App names an agent by (F35), as members, presence and a tool call's `ctx.agent` do; the session id stays here.
 */
export async function agentIdsBySession(env: NodeJS.ProcessEnv): Promise<Map<string, string>> {
  const ids = new Map<string, string>()
  for (const agent of await listAgents(env, { includeGuests: true })) {
    const sessionId = cached(agent, SESSIONPAGE_SESSION_CACHE_KEY)
    if (sessionId && agent.gugu_user_id) ids.set(sessionId, `user:${agent.gugu_user_id}`)
  }
  return ids
}

/** Project removal archives every retained task, including another account's parked binding. */
export async function countSessionAgents(sessionIds: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const sessions = new Set(sessionIds)
  const agents = new Set<string>()
  for (const agent of await listAgents(env, { includeGuests: true })) {
    const sessionId = cached(agent, SESSIONPAGE_SESSION_CACHE_KEY) || cached(agent, SESSIONPAGE_PARKED_SESSION_CACHE_KEY)
    if (sessions.has(sessionId) && agent.gugu_user_id) agents.add(agent.gugu_user_id)
  }
  return agents.size
}

export async function guguAgentUserIdForSession(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  ownerUserId?: string | null,
): Promise<string | null> {
  return (await localAgentForSession(sessionId, env, ownerUserId))?.gugu_user_id ?? null
}

/**
 * 这条会话所属的项目群（spec ⑨「项目 = 群」）。
 *
 * 读的是 provisioning 盖在花名册记录上的那对绑定 —— 与注入进这条会话自己 system prompt 的
 * `<gugu_project_context>` 块**同一个事实源**，两处的在场判据也逐字相同（项目 id 与群 chat_id
 * 都非空才算有群）。所以「提示词说的默认通道」与「工具回执给的通道」不可能各说各的。
 *
 * ⚠️ 「没有群」有三种,调用方**不该把它们读成同一件事**:无项目（task-home / 隐式 sentinel 项目,
 * provisioning 两格都写空串）是合法常态;而**根本查不到这条会话的花名册记录**是另一回事 ——
 * 那更可能是这条会话还没供给身份、或键名分了家。两者都退回点对点,但只有前者是对的,所以把
 * 原因一起交出去,让读的人能在日志里把它们分开(❌ 不折成一个 `hasGroup:false`)。
 */
export type SessionpageProjectGroup =
  | { kind: 'group'; projectId: string; groupChatId: string }
  | { kind: 'none'; reason: 'no-roster-record' | 'no-project' | 'no-group-yet' }

export async function sessionpageProjectGroupForSession(
  sessionId: string,
  env: NodeJS.ProcessEnv,
): Promise<SessionpageProjectGroup> {
  const record = await localAgentForSession(sessionId, env)
  if (!record) return { kind: 'none', reason: 'no-roster-record' }
  const projectId = cached(record, SESSIONPAGE_PROJECT_CACHE_KEY)
  if (!projectId) return { kind: 'none', reason: 'no-project' }
  const groupChatId = cached(record, SESSIONPAGE_GROUP_CHAT_CACHE_KEY)
  if (!groupChatId) return { kind: 'none', reason: 'no-group-yet' }
  return { kind: 'group', projectId, groupChatId }
}
