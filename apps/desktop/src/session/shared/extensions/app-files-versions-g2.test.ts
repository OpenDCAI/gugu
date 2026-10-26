import { rpcQuery } from '../../../../../../tests/helpers/rpcQuery';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * G2: a chat file's kept versions — a text file's each round of changes (the file service records them), a stored
 * file's each replaced content — read through `workspace_versions_as` / `workspace_version_as`, the person or the agent an
 * App's program acts for on one path. The database is a fake in memory; the rounds themselves are judged in
 * gugu-supabase (filesG2Versions.test.ts, rounds.test.ts).
 */
const ITEM = '44444444-4444-4444-8444-444444444444';
const CHAT = '33333333-3333-4333-8333-333333333333';
const ME = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const rpcs: { name: string; args: Record<string, unknown> }[] = [];
let row: Record<string, unknown>;
const kept = [
  { n: 3, made_by: AGENT, made_at: '2026-10-11T01:00:03Z', size_bytes: 9, pointer: null, inline_text: '定稿·A1', content_type: 'text/markdown' },
  { n: 2, made_by: ME, made_at: '2026-10-11T01:00:02Z', size_bytes: 9, pointer: null, inline_text: '初稿·A1', content_type: 'text/markdown' },
  { n: 1, made_by: null, made_at: '2026-10-11T01:00:01Z', size_bytes: 6, pointer: null, inline_text: '初稿', content_type: 'text/markdown' },
];

vi.mock('@gugu/core/cloud/supabase', () => ({
  createGuguSupabaseClient: () => ({
    from: () => {
      const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: row, error: null }) };
      return query;
    },
    rpc: rpcQuery(async (name: string, args: Record<string, unknown>) => {
      // Who may delete what is the folder's to say; here, everyone may delete everything.
      if (name === 'workspace_deletable_as') return { data: args.p_item_ids, error: null };
      if (name === 'workspace_get_as') return { data: [row], error: null };
      rpcs.push({ name, args });
      if (name === 'workspace_versions_as') return { data: kept.map(({ n, made_by, made_at, size_bytes }) => ({ n, made_by, made_at, size_bytes })), error: null };
      const one = kept.find((version) => version.n === args.p_n);
      return one ? { data: [one], error: null } : { data: null, error: { message: `workspace item ${ITEM} has no version ${args.p_n}`, hint: 'workspace_no_version' } };
    }),
  }),
}));

const { createAppFiles } = await import('./app-files-core');
const files = createAppFiles({
  account: async () => ({ token: 'token', userId: ME }),
  hasCapability: () => true,
  sync: { ensureFor: () => undefined,} as never,
  identities: async (_token, ids) => ids.map((id) => ({ id, name: id === ME ? 'Me' : 'Agent', avatar: null, kind: id === ME ? 'human' : 'agent' })),
  faces: async () => ({}),
  filesUrl: () => 'http://files.invalid',
  warn: () => undefined,
});
const surface = (extra: Record<string, unknown> = {}) => ({ pageId: 1, extensionId: 'workspace', itemId: null, ...extra }) as never;

beforeEach(() => {
  rpcs.length = 0;
  row = { id: ITEM, chat_id: CHAT, kind: 'document', filename: '计划.md', content_type: 'text/markdown', epoch: 0 };
});

describe('files.versions / files.readVersion (G2)', () => {
  it('newest first, each with who made it (null when no one is known) and when', async () => {
    expect(await files.versions(surface(), { ref: { id: ITEM } })).toEqual([
      { n: 3, by: { id: `user:${AGENT}`, name: 'Agent', kind: 'agent' }, at: '2026-10-11T01:00:03Z', size: 9 },
      { n: 2, by: { id: `user:${ME}`, name: 'Me', kind: 'human' }, at: '2026-10-11T01:00:02Z', size: 9 },
      { n: 1, by: null, at: '2026-10-11T01:00:01Z', size: 6 },
    ]);
    expect(rpcs).toEqual([{ name: 'workspace_versions_as', args: { p_item_id: ITEM, p_as_user_id: ME } }]);
  });

  it('a text file\'s version is its text; one that is not kept is not-found, said', async () => {
    expect(await files.readVersion(surface(), { ref: { id: ITEM }, n: 2 })).toEqual({ n: 2, text: '初稿·A1' });
    await expect(files.readVersion(surface(), { ref: { id: ITEM }, n: 9 })).rejects.toMatchObject({ code: 'not-found', message: expect.stringMatching(/has no version 9/) });
    await expect(files.readVersion(surface(), { ref: { id: ITEM }, n: 1.5 })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('an App\'s program acting for an agent reads as the agent', async () => {
    await files.versions(surface({ itemId: ITEM, asAgent: AGENT }), { ref: { id: ITEM } });
    expect(rpcs[0]!.args.p_as_user_id).toBe(AGENT);
  });
});
