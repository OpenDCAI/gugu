import { fetchInChunks } from '@gugu/core/shared/inChunks'
import { currentAuthSessionSignal } from './authSessionLoss'
import { displayIdentityFromRow, type DisplayIdentity } from './displayIdentity'
import { identityDb } from './supabase'
export const DISPLAY_IDENTITY_SELECT = 'id, gugu_number, display_name, avatar, bio, type, owner_user_id, agent_public, desired_status, device_id, category, is_official, local_path, created_at, updated_at, onboarded_at'
export async function readDisplayIdentities(ids: readonly string[], signal: AbortSignal = currentAuthSessionSignal()): Promise<DisplayIdentity[]> {
  const rows = await fetchInChunks([...new Set(ids.filter(Boolean))], async (chunk) => { const { data, error } = await identityDb.from('users').select(DISPLAY_IDENTITY_SELECT).in('id', chunk).abortSignal(signal); if (error) throw new Error(error.message); return data ?? [] })
  return rows.map(displayIdentityFromRow)
}
/** 社区积分(论坛):人的公开余额(identity.users.community_points);agent 的恒为 0,界面上不显示它。 */
export async function readCommunityPoints(id: string): Promise<number> { const { data, error } = await identityDb.from('users').select('community_points').eq('id', id).single(); if (error) throw new Error(error.message); return Number((data as { community_points: number }).community_points) }
export async function readRequiredDisplayIdentities(ids: readonly string[]): Promise<DisplayIdentity[]> {
  if (ids.some((id) => typeof id !== 'string' || id.trim() === '')) throw new Error('Canonical identity candidate has no id')
  const required = [...new Set(ids)]
  const identities = await readDisplayIdentities(required)
  const byId = new Map(identities.map((identity) => [identity.id, identity]))
  return required.map((id) => { const identity = byId.get(id); if (!identity) throw new Error(`Canonical identity ${id} was not returned`); return identity })
}
export async function readOwnedDisplayIdentities(ownerUserId: string, signal: AbortSignal = currentAuthSessionSignal()): Promise<DisplayIdentity[]> { const { data, error } = await identityDb.from('users').select(DISPLAY_IDENTITY_SELECT).eq('type', 'agent').eq('owner_user_id', ownerUserId).abortSignal(signal); if (error) throw new Error(error.message); return (data ?? []).map(displayIdentityFromRow) }
export async function readDeviceDisplayIdentities(deviceId: string): Promise<DisplayIdentity[]> { const { data, error } = await identityDb.from('users').select(DISPLAY_IDENTITY_SELECT).eq('type', 'agent').eq('device_id', deviceId).order('display_name'); if (error) throw new Error(error.message); return (data ?? []).map(displayIdentityFromRow) }
export async function readAgentProfileTypes(ownerId: string): Promise<{ id: string; agent_type: 'codex' | 'claude-code' | null }[]> { const { data, error } = await identityDb.from('agent_profiles').select('id, agent_type').eq('owner_id', ownerId); if (error) throw new Error(error.message); return data ?? [] }
/** #7348 首次引导走到哪:本人那一行的 onboarded_at(null = 还没走完)。读不到 = throw,门口如实说读不到。 */
export async function readOwnOnboardedAt(userId: string, signal: AbortSignal = currentAuthSessionSignal()): Promise<string | null> { const { data, error } = await identityDb.from('users').select('onboarded_at').eq('id', userId).abortSignal(signal).single(); if (error) throw new Error(error.message); return (data as { onboarded_at: string | null }).onboarded_at }
