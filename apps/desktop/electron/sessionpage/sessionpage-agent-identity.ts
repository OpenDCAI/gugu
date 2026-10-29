import { fetchInChunks } from '@gugu/core/shared/inChunks'
import { makeIdentityClient } from '../supabase'
import { SESSION_PRIVATE_AGENT_ERROR } from '../../src/session/shared/lib/ipc/shell-port'

/** The canonical identity fields shared by every session-page name surface. */
export interface SessionpageCanonicalAgentIdentity {
  id: string
  gugu_number: number | null
  display_name: string
  session_archived_at?: string | null
}

/**
 * Read session-page agent identities from the same cloud table used by contacts,
 * chat messages, and `session_peers`.
 *
 * The local roster remains the conversation → agent binding index. It is
 * deliberately not consulted for a display name here: the local-first startup
 * path can briefly contain a candidate name before the cloud provisioning RPC
 * applies the account-wide serial floor.
 */
export async function loadSessionpageCanonicalAgentIdentities(
  auth: { accessToken: string; userId: string },
  agentUserIds: readonly string[],
  reportPrivate = false,
): Promise<SessionpageCanonicalAgentIdentity[]> {
  const ids = [...new Set(agentUserIds.map((id) => id.trim()).filter(Boolean))]
  // 按块带 id 查(fetchInChunks,@@@1666):本机会话上百个时整张列表拼进一条 URL 撞网关上限,session_peers 整个 502。
  // ❌ 改成按主人整表取:那会撞 PostgREST 每次响应的行数上限,agent 身份多的账号会静默少行。每块只取要的那些行,
  // 可见域照旧由 RLS 与 owner 过滤定。
  const client = makeIdentityClient(auth.accessToken)
  const rows = await fetchInChunks(ids, async (chunk) => {
    const { data, error } = await client
      .from('users')
      .select('id,gugu_number,display_name,session_archived_at')
      .eq('type', 'agent')
      .eq('owner_user_id', auth.userId)
      .in('id', chunk)
    if (error) throw new Error(`session-page canonical identity lookup failed: ${error.message}`)
    return Array.isArray(data) ? data : []
  })
  const seen = new Set<string>()
  // Only a targeted drop needs a refusal reason; a filtered row must not break the full roster.
  const missing = reportPrivate ? ids.filter((id) => !rows.some((row) => row?.id === id)) : []
  const privateAgents = await fetchInChunks(missing, async (chunk) => {
    const { data, error } = await client.from('users').select('id')
      .eq('type', 'agent').neq('owner_user_id', auth.userId).eq('agent_public', false).in('id', chunk)
    if (error) throw new Error(`session-page identity visibility lookup failed: ${error.message}`)
    return Array.isArray(data) ? data : []
  })
  if (privateAgents.length) throw new Error(SESSION_PRIVATE_AGENT_ERROR)
  return rows.map((row) => {
    const id = typeof row?.id === 'string' ? row.id.trim() : ''
    const displayName = typeof row?.display_name === 'string' ? row.display_name.trim() : ''
    if (!id || !displayName) throw new Error('session-page canonical identity lookup returned an incomplete identity')
    if (seen.has(id)) throw new Error(`session-page canonical identity lookup returned duplicate identity ${id}`)
    seen.add(id)
    const guguNumber = row?.gugu_number
    if (guguNumber !== null && !Number.isInteger(guguNumber)) {
      throw new Error(`session-page canonical identity lookup returned invalid gugu_number for ${id}`)
    }
    return { id, gugu_number: guguNumber ?? null, display_name: displayName,
      ...(row.session_archived_at != null ? { session_archived_at: row.session_archived_at } : {}) }
  })
}
