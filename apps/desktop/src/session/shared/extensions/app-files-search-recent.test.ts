import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_VERBS } from './bridge-protocol';

/**
 * `files.search` / `files.recent` (gugu-supabase 20261017024605): one door each — `files:read`, as any other chat file
 * read — and whoever the page works as is the one the database reads for: the person (no `p_as_user_id`), or the agent
 * (`p_as_user_id`, judged by `workspace_actor_for`). A private chat goes by the other one in it.
 */

const PERSON = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const PEER = '55555555-5555-4555-8555-555555555555';
const GROUP = '33333333-3333-4333-8333-333333333333';
const DM = '66666666-6666-4666-8666-666666666666';
const found = (id: string, chat: string, kind: string, name: string | null) => ({
  id, chat_id: chat, kind: 'document', filename: `${id}.md`, content_type: 'text/markdown', size_bytes: 1, pointer: null,
  source_message_ids: [], created_by: null, version: 1, created_at: null, updated_at: null, parent_id: null, system_role: null,
  path: `${id}.md`, epoch: 0, chat_name: name, chat_kind: kind, opened_at: '2026-10-17T03:00:00Z',
});
const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];

vi.mock('@gugu/core/cloud/supabase', () => ({
  createGuguSupabaseClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      // Who may delete what is the folder's to say; here, everyone may delete everything.
      if (name === 'workspace_deletable_as') return { data: args.p_item_ids, error: null };
      rpcCalls.push({ name, args });
      return { data: [found('a', GROUP, 'group', '办公甲'), found('b', DM, 'dm', null)], error: null };
    },
    from: () => {
      const query = {
        select: () => query,
        in: () => query,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [{ chat_id: DM, user_id: PERSON }, { chat_id: DM, user_id: PEER }], error: null }).then(resolve),
      };
      return query;
    },
  }),
}));

const { createAppFiles } = await import('./app-files-core');
const files = createAppFiles({
  account: async () => ({ token: 'token', userId: PERSON }),
  hasCapability: () => true,
  sync: { ensureFor: () => undefined,} as never,
  identities: async (_token: string, ids: readonly string[]) => ids.map((id) => ({ id, name: id === PEER ? 'Bob' : 'Someone', avatar: null, kind: 'human' as const })),
  faces: async () => ({}),
  filesUrl: () => 'http://files.invalid',
  warn: () => undefined,
} as never);

beforeEach(() => {
  rpcCalls.length = 0;
});

describe('files.search / files.recent', () => {
  it('both need files:read — the same door as any other chat file a page reads', () => {
    expect(BRIDGE_VERBS.filesSearch.needs).toBe('files:read');
    expect(BRIDGE_VERBS.filesRecent.needs).toBe('files:read');
  });

  it('as the agent the page works for: p_as_user_id is that agent', async () => {
    await files.search({ query: '周报', suffixes: ['.md'], limit: 20 }, { asAgent: AGENT });
    await files.recent({ limit: 5 }, { asAgent: AGENT });
    expect(rpcCalls).toEqual([
      { name: 'workspace_search', args: { p_query: '周报', p_suffixes: ['.md'], p_limit: 20, p_as_user_id: AGENT } },
      { name: 'workspace_recent', args: { p_limit: 5, p_as_user_id: AGENT } },
    ]);
  });

  it('control: the person\'s own page asks for no one else', async () => {
    await files.search({}, {});
    await files.recent({});
    expect(rpcCalls).toEqual([
      { name: 'workspace_search', args: { p_query: null, p_suffixes: null, p_limit: 50, p_as_user_id: null } },
      { name: 'workspace_recent', args: { p_limit: 50, p_as_user_id: null } },
    ]);
  });

  it('each entry says its chat: a group by its name, a private chat by the other one in it; when it was opened', async () => {
    const entries = await files.recent({});
    expect(entries.map((entry) => [entry.chat, entry.chatName, entry.openedAt])).toEqual([
      [GROUP, '办公甲', '2026-10-17T03:00:00Z'],
      [DM, 'Bob', '2026-10-17T03:00:00Z'],
    ]);
  });
});
