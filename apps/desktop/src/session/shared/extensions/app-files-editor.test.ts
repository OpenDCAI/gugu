import { beforeEach, expect, it, vi } from 'vitest';

const HUMAN = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const CHAT = '33333333-3333-4333-8333-333333333333';
const row = (id: string, creator: string | null, editor: string | null) => ({
  id, chat_id: CHAT, kind: 'document', filename: `${id}.md`, content_type: 'text/markdown', size_bytes: 1,
  pointer: null, parent_id: null, system_role: null, path: `${id}.md`, source_message_ids: [],
  version: 1, epoch: 0, created_at: '2026-10-25T01:00:00Z', updated_at: '2026-10-25T02:00:00Z',
  created_by: creator, updated_by: editor,
});
let rows: ReturnType<typeof row>[] = [];
const rpc = vi.fn(async (name: string) => ({ data: name === 'workspace_deletable_as' ? [] : rows, error: null }));
vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: () => ({ rpc }) }));
const identities = vi.fn(async (_token: string, ids: readonly string[]) => ids.map((id) => ({
  id, name: id === AGENT ? 'Editor agent' : 'Human creator', avatar: null, kind: id === AGENT ? 'agent' as const : 'human' as const,
})));
const { createAppFiles } = await import('./app-files-core');
const files = createAppFiles({
  account: async () => ({ token: 'token', userId: HUMAN }),
  hasCapability: () => true, sync: {} as never, identities, faces: async () => ({}),
  filesUrl: () => 'http://files.invalid', warn: () => undefined,
});

beforeEach(() => { identities.mockClear(); rpc.mockClear(); });

it('resolves creators and human/agent editors in the same deduplicated identity read', async () => {
  rows = [row('a', HUMAN, AGENT), row('b', AGENT, HUMAN), row('c', HUMAN, AGENT)];
  const entries = await files.groupFiles(CHAT);
  expect(entries.map(({ createdBy, updatedBy }) => [createdBy, updatedBy])).toEqual([
    [{ id: `user:${HUMAN}`, name: 'Human creator', kind: 'human' }, { id: `user:${AGENT}`, name: 'Editor agent', kind: 'agent' }],
    [{ id: `user:${AGENT}`, name: 'Editor agent', kind: 'agent' }, { id: `user:${HUMAN}`, name: 'Human creator', kind: 'human' }],
    [{ id: `user:${HUMAN}`, name: 'Human creator', kind: 'human' }, { id: `user:${AGENT}`, name: 'Editor agent', kind: 'agent' }],
  ]);
  expect(identities.mock.calls).toEqual([['token', [HUMAN, AGENT]]]);
  expect(rpc.mock.calls.map(([name]) => name)).toEqual(['workspace_list_as', 'workspace_deletable_as']);
});

it('keeps an unknown editor null rather than assigning the creator', async () => {
  rows = [row('historical', HUMAN, null)];
  expect((await files.groupFiles(CHAT))[0]).toMatchObject({ createdBy: { id: `user:${HUMAN}` }, updatedBy: null });
  expect(identities.mock.calls).toEqual([['token', [HUMAN]]]);
});
