import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase';

/** The owner-checked provision role, never a display name or a directory-name guess. */
export async function isPersonalAssistantAgent(auth: { userId: string; accessToken: string }, agentId: string): Promise<boolean> {
  const client = createGuguSupabaseClient({ schema: 'identity', headers: { Authorization: `Bearer ${auth.accessToken}` } });
  const { data, error } = await client.from('agent_provisions').select('agent_user_id').eq('owner_user_id', auth.userId)
    .eq('agent_user_id', agentId).eq('member_key', 'assistant').limit(1).abortSignal(AbortSignal.timeout(2000));
  if (error) throw new Error('ASSISTANT_ROLE_UNAVAILABLE');
  return Boolean(data?.length);
}

/** Resolve restored local bindings by the same canonical role, including directories outside app-owned paths. */
export async function personalAssistantSessionBindings(
  auth: { userId: string; accessToken: string },
  roster: readonly { gugu_user_id?: string | null; cache?: Record<string, unknown> | null }[],
): Promise<{ assistantId: string; sessionId: string }[]> {
  const client = createGuguSupabaseClient({ schema: 'identity', headers: { Authorization: `Bearer ${auth.accessToken}` } });
  const { data, error } = await client.from('agent_provisions').select('agent_user_id').eq('owner_user_id', auth.userId)
    .eq('member_key', 'assistant').limit(1000).abortSignal(AbortSignal.timeout(2000));
  if (error) throw new Error('ASSISTANT_ROLE_UNAVAILABLE');
  const ids = new Set((data ?? []).map(row => row.agent_user_id).filter((id): id is string => typeof id === 'string'));
  const found = new Set<string>();
  return roster.flatMap(record => {
    const id = record.gugu_user_id, sessionId = record.cache?.emdash_session_id;
    if (!id || !ids.has(id) || typeof sessionId !== 'string' || !sessionId) return [];
    if (found.has(id)) throw new Error('ASSISTANT_BINDING_AMBIGUOUS');
    found.add(id);
    return [{ assistantId: id, sessionId }];
  });
}
