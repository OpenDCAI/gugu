import { dbPayload } from '@gugu/core/cloud/supabase'
import { identityDb } from './supabase'

export async function updateDisplayAlias(
  ownerId: string,
  target: { kind: 'contact' | 'group'; id: string },
  alias: string,
): Promise<void> {
  const next = alias.trim()
  if (!next) {
    const { error } = await identityDb.from('contact_overrides').delete()
      .eq('owner_user_id', ownerId).eq('target_kind', target.kind).eq('target_id', target.id)
    if (error) throw error
    return
  }
  const { error } = await identityDb.from('contact_overrides').upsert(dbPayload({
    owner_user_id: ownerId,
    target_kind: target.kind,
    contact_user_id: target.kind === 'contact' ? target.id : null,
    group_chat_id: target.kind === 'group' ? target.id : null,
    alias: next,
    updated_at: new Date().toISOString(),
  }), { onConflict: 'owner_user_id,target_kind,target_id' })
  if (error) throw error
}
