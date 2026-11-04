import { rpcQuery } from '../../../../../../tests/support/rpcQuery';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 摩擦单 F16 An App's program opening a file one of this person's agents handed it: the file is read as that agent
 * (`workspace_get_as` — the agent must be in the group itself; the person may not be), granted with the agent's
 * identity so its sync rides the relay's connection acting as the agent, and the open file's `self` is the agent.
 * The person's own opens (no `asAgent`) read the table with their own token, as before.
 */

const PERSON = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const CHAT = '33333333-3333-4333-8333-333333333333';
const ITEM = '44444444-4444-4444-8444-444444444444';
const row = {
  id: ITEM, chat_id: CHAT, kind: 'document', filename: 'board.json', content_type: 'application/json', size_bytes: 2,
  created_at: null, updated_at: null, created_by: AGENT, source_message_ids: [], pointer: null, epoch: 3,
};

/** What each agent may read (its own groups); what the person reads as themselves is `personSees`. */
let agentSees = new Map<string, typeof row>();
let personSees: (typeof row)[] = [];
const rpcCalls: unknown[] = [];

vi.mock('@gugu/core/cloud/supabase', () => ({
  createGuguSupabaseClient: () => ({
    rpc: rpcQuery(async (name: string, args: { p_item_id: string; p_as_user_id: string }) => {
      // Who may delete what is the folder's to say; here, everyone may delete everything.
      if (name === 'workspace_deletable_as') return { data: (args as unknown as { p_item_ids: string[] }).p_item_ids, error: null };
      rpcCalls.push({ name, args });
      const seen = args.p_as_user_id === PERSON ? personSees.find((r) => r.id === args.p_item_id) : agentSees.get(args.p_as_user_id);
      return seen?.id === args.p_item_id
        ? { data: [{ ...seen, parent_id: null, system_role: null, path: seen.filename }], error: null }
        : { data: null, error: { message: `workspace item not found: ${args.p_item_id}`, hint: 'workspace_item_not_found' } };
    }),
  }),
}));

const { createAppFiles } = await import('./app-files-core');

const grants: unknown[] = [];
const files = createAppFiles({
  account: async () => ({ token: 'token', userId: PERSON }),
  hasCapability: () => false,
  sync: { ensureFor: () => undefined, pageFor: () => ({}), grant: (_page: unknown, grant: unknown) => void grants.push(grant), revoke: () => undefined, ungrant: () => undefined } as never,
  identities: async (_token, ids) => ids.map((id) => ({ id, name: 'Helper', avatar: null, kind: 'agent' as const })),
  faces: async () => ({}),
  filesUrl: () => 'http://files.invalid',
  warn: () => undefined,
});

beforeEach(() => {
  agentSees = new Map();
  personSees = [];
  rpcCalls.length = 0;
  grants.length = 0;
});

describe('a program opening a handed file as the agent that handed it (F16)', () => {
  it('reads it as the agent, even in a group the person is not in; grants it as the agent; self is the agent', async () => {
    agentSees.set(AGENT, row);
    const opened = await files.open({ pageId: -1, extensionId: 'board', itemId: ITEM, asAgent: AGENT }, { ref: { id: ITEM } });
    expect(rpcCalls).toEqual([{ name: 'workspace_get_as', args: { p_item_id: ITEM, p_as_user_id: AGENT } }]);
    expect(grants).toEqual([{ docName: `${ITEM}@3`, itemId: ITEM, access: 'rw', needs: null, asAgent: AGENT }]);
    expect(opened.self).toEqual({ userId: `user:${AGENT}`, name: 'Helper' });
  });

  it('a file the agent cannot read is not-found — and nothing is granted', async () => {
    personSees = [row]; // the person could read it; the agent it is opened for cannot
    await expect(files.open({ pageId: -1, extensionId: 'board', itemId: ITEM, asAgent: AGENT }, { ref: { id: ITEM } }))
      .rejects.toMatchObject({ code: 'not-found' });
    expect(grants).toEqual([]);
  });

  it('control: the person\'s own open reads through the same door as themselves and grants with no agent', async () => {
    personSees = [row];
    await files.open({ pageId: 7, extensionId: 'board', itemId: ITEM }, { ref: { chat: CHAT, id: ITEM } });
    expect(rpcCalls).toEqual([{ name: 'workspace_get_as', args: { p_item_id: ITEM, p_as_user_id: PERSON } }]);
    expect(grants).toEqual([{ docName: `${ITEM}@3`, itemId: ITEM, access: 'rw', needs: null }]);
  });
});
