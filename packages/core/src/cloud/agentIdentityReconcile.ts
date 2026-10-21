import { createGuguSupabaseClient } from './supabase'

export interface CloudOwnedAgent {
  agentUserId: string
  deviceId: string | null
  providerSessionId: string | null
  displayName: string | null
  /** identity.users.created_at(ISO)。回收器用它放过刚铸出来、名册还没写上的身份。 */
  createdAt?: string | null
}

/**
 * 账号名下的云端 agent 清单 —— 社交侧「投影」的枚举面。
 *
 * 会话页是唯一真源,通讯录里的 agent 是它的投影(product spec「单向真源」);对账要能把
 * 投影按会话页现状重建,枚举面就必须是投影本身,而不是本机名册那份第三方索引:名册一丢(重装、
 * 清目录、换 GUGU_HOME),按名册枚举的对账对云端那些行就永远看不见了。
 *
 * 两次读(users + agent_sessions)在 JS 里 join —— 不依赖 PostgREST 的嵌套关系探测。两张表的 RLS 都只回
 * 调用者拥有/控制的 agent;显式 owner_user_id 过滤把范围钉到「自己名下」。
 */
export async function listOwnedCloudAgentsViaSupabase(input: {
  ownerUserId: string
  accessToken: string
  fetch?: typeof fetch
  /**
   * 启动提速 —— 只要名字面(会话页铸身份的重名闸)时不必把 `agent_sessions` 整表拉回来:
   * 那一查随 agent 数线性增长,MBP 实测 1.4~1.5s;省掉后只剩一次往返。false ⇒ providerSessionId 一律 null。
   */
  includeSessions?: boolean
}): Promise<CloudOwnedAgent[]> {
  const client = createGuguSupabaseClient({
    schema: 'identity',
    headers: { Authorization: `Bearer ${input.accessToken}` },
    fetch: input.fetch
  })
  const includeSessions = input.includeSessions ?? true
  const [usersRes, sessionsRes] = await Promise.all([
    client
      .from('users')
      .select('id, device_id, display_name, created_at')
      .eq('type', 'agent')
      .eq('owner_user_id', input.ownerUserId),
    includeSessions
      ? client.from('agent_sessions').select('agent_user_id, provider_session_id')
      : Promise.resolve({ data: [], error: null })
  ])
  if (usersRes.error) throw new Error(usersRes.error.message)
  if (sessionsRes.error) throw new Error(sessionsRes.error.message)
  const sessionByAgent = new Map(
    (sessionsRes.data as Array<{ agent_user_id: string; provider_session_id: string }> | null ?? []).map(
      (s) => [s.agent_user_id, s.provider_session_id]
    )
  )
  const users = (usersRes.data as Array<{
    id: string; device_id: string | null; display_name: string | null; created_at: string | null
  }> | null) ?? []
  return users.map((u) => ({
    agentUserId: u.id,
    deviceId: u.device_id ?? null,
    providerSessionId: sessionByAgent.get(u.id) ?? null,
    displayName: u.display_name ?? null,
    createdAt: u.created_at ?? null
  }))
}

/**
 * #6396 这个账号每个名字前缀(`Claude` / `Codex` …)**用过的**最大序号 —— identity.agent_name_serials,
 * 服务端在 agent 行写入/改名时记账,删掉的 agent 用过的号也在里面。RLS 只回调用者自己的行。
 * 本机起号拿它当起点,起出来的名字就是服务端会认的名字,会话起来之后不再被改名。
 */
export async function listAgentNameSerialsViaSupabase(input: {
  accessToken: string
  fetch?: typeof fetch
}): Promise<Map<string, number>> {
  const client = createGuguSupabaseClient({
    schema: 'identity',
    headers: { Authorization: `Bearer ${input.accessToken}` },
    fetch: input.fetch
  })
  const { data, error } = await client.from('agent_name_serials').select('base, high_water')
  if (error) throw new Error(error.message)
  return new Map(((data as Array<{ base: string; high_water: number }> | null) ?? []).map((row) => [row.base, row.high_water]))
}
