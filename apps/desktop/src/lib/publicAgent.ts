// #1231 PR1 — load a public agent's landing data for the /join/agent/<id> page.
//
// Calls identity.get_public_agent_join (SECURITY DEFINER, granted anon+authenticated),
// which returns rows ONLY for an opt-in public agent (users.agent_public = true). Works for
// LOGGED-OUT visitors because identityDb uses the public anon key. A non-public / unknown
// agent yields 0 rows -> null (the landing renders a "not available" state, no leak).

import { identityDb } from './supabase'
import { resolvePublicAssetUrl } from '@gugu/core/shared/ui/publicAssets'
import type { AgentJoinInfo } from '../pages/AgentJoinPage'

interface PublicAgentJoinRow {
  id: string
  display_name: string | null
  avatar: string | null
  bio: string | null
  category: string | null
  owner_display_name: string | null
  owner_avatar: string | null
}

/**
 * Fetch the public landing info for an agent by id. Returns null when the agent is not
 * public (or does not exist) — the caller renders the unavailable state, never a leak.
 * Throws on an unexpected transport/DB error so the caller can fail loud.
 */
export async function fetchPublicAgentJoin(agentId: string): Promise<AgentJoinInfo | null> {
  const { data, error } = await identityDb.rpc('get_public_agent_join', { p_agent_id: agentId })
  if (error) throw new Error(error.message)
  const row = (Array.isArray(data) ? data[0] : data) as PublicAgentJoinRow | undefined
  if (!row) return null
  return {
    id: row.id,
    displayName: row.display_name ?? '',
    // Resolve stored asset refs (preset avatars carry `./assets/…`) to the runtime-correct
    // base so they load under the deep `/join/agent/<id>` route, not just at the root (#1285).
    avatar: resolvePublicAssetUrl(row.avatar),
    bio: row.bio ?? null,
    ownerDisplayName: row.owner_display_name ?? null,
    ownerAvatar: resolvePublicAssetUrl(row.owner_avatar),
    category: row.category ?? null,
  }
}
