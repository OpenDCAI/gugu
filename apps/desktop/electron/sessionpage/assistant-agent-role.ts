import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase';

/** The owner-checked provision role, never a display name or a directory-name guess. */
export async function isPersonalAssistantAgent(auth: { userId: string; accessToken: string }, agentId: string): Promise<boolean> {
  const client = createGuguSupabaseClient({ schema: 'identity', headers: { Authorization: `Bearer ${auth.accessToken}` } });
  const { data, error } = await client.from('agent_provisions').select('agent_user_id').eq('owner_user_id', auth.userId)
    .eq('agent_user_id', agentId).eq('member_key', 'assistant').limit(1).abortSignal(AbortSignal.timeout(2000));
  if (error) throw new Error('ASSISTANT_ROLE_UNAVAILABLE');
  return Boolean(data?.length);
}
