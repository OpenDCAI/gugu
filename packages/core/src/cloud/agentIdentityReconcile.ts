import { createGuguSupabaseClient } from './supabase'

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
