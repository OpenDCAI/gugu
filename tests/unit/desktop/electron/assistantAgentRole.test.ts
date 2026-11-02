import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ filters: [] as [string, string][], error: null as null | { message: string }, role: true, signal: undefined as AbortSignal | undefined }));
vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: () => ({
  from: (table: string) => {
    expect(table).toBe('agent_provisions');
    const query = { select: () => query, eq: (key: string, value: string) => { state.filters.push([key, value]); return query; },
      limit: () => query, abortSignal: async (signal: AbortSignal) => { state.signal = signal; return { data: state.role ? [{ agent_user_id: 'assistant' }] : [], error: state.error }; } };
    return query;
  },
}) }));
import { isPersonalAssistantAgent } from '../../../../apps/desktop/electron/sessionpage/assistant-agent-role';
beforeEach(() => { state.filters = []; state.error = null; state.role = true; state.signal = undefined; });
it('identifies the assistant by owner and provision role, independently of its name or directory', async () => {
  expect(await isPersonalAssistantAgent({ userId: 'owner', accessToken: 'fixture' }, 'assistant')).toBe(true);
  expect(state.filters).toEqual([['owner_user_id', 'owner'], ['agent_user_id', 'assistant'], ['member_key', 'assistant']]);
  expect(state.signal).toBeInstanceOf(AbortSignal);
});
it('keeps an ordinary agent on its existing project-selection path', async () => {
  state.role = false;
  expect(await isPersonalAssistantAgent({ userId: 'owner', accessToken: 'fixture' }, 'ordinary')).toBe(false);
});
it('does not turn a failed authorization/role query into permission to create a directory project', async () => {
  state.error = { message: 'denied' };
  await expect(isPersonalAssistantAgent({ userId: 'owner', accessToken: 'fixture' }, 'assistant')).rejects.toThrow('ASSISTANT_ROLE_UNAVAILABLE');
});
