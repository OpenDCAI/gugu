import { describe, expect, it, vi } from 'vitest';
import { BRIDGE_VERBS } from './bridge-protocol';

/**
 * `gugu.chats` (`chat:read`, owner 10-19: an App's own page anywhere, not only a chat's side panel): the chats whoever
 * reads is in, and who is in one — read through the doors an agent's `message_conversations` / `message_members` take
 * (`list_my_chats_as`, `list_member_ids`), as the person or as the agent. `getContext().chat.members` reads the same door.
 *
 * The fake database below keeps the rules those doors and the table's row policy have (gugu-supabase
 * 20260926005500_list_my_chats_as, 20261016231621_topic_members_visible_from_source_line, 002 `members_select_peer`), with
 * the person's token as the caller. Control (the parent commit): `gugu.chats` absent; `chat.members` read the table, as
 * `tableMembers` below does.
 */

const P = '0a000000-0000-4000-8000-00000000000a'; // the person, whose token every read carries
const AG = '0a000000-0000-4000-8000-0000000000a9'; // one of P's agents
const X = '0a000000-0000-4000-8000-00000000000b';
const Y = '0a000000-0000-4000-8000-00000000000c';
const GROUP = '11111111-1111-4111-8111-111111111111';
const TOPIC = '22222222-2222-4222-8222-222222222222'; // of GROUP, P in it
const TOPIC_AGENT = '33333333-3333-4333-8333-333333333333'; // of GROUP, AG in it and not P
const DM = '44444444-4444-4444-8444-444444444444';
const AGENT_DM = '55555555-5555-4555-8555-555555555555';
const FAR = '66666666-6666-4666-8666-666666666666'; // a group of AG's that P is not in
const TOPIC_FAR = '77777777-7777-4777-8777-777777777777'; // of FAR, AG in it and not P
const AI = '88888888-8888-4888-8888-888888888888';

const chats = [
  { id: GROUP, kind: 'group', name: '周末出游', source_chat_id: null, last_message_at: '2026-10-19T09:00:00Z' },
  { id: TOPIC, kind: 'topic', name: '周六路线', source_chat_id: GROUP, last_message_at: '2026-10-19T08:00:00Z' },
  { id: TOPIC_AGENT, kind: 'topic', name: '订酒店', source_chat_id: GROUP, last_message_at: '2026-10-19T07:00:00Z' },
  { id: DM, kind: 'dm', name: null, source_chat_id: null, last_message_at: '2026-10-19T06:00:00Z' },
  // A private chat with an agent keeps the agent's name from when it was made (gugu-supabase 20260626114009).
  { id: AGENT_DM, kind: 'dm', name: 'Codex 1', source_chat_id: null, last_message_at: '2026-10-19T05:00:00Z' },
  { id: FAR, kind: 'group', name: '别的群', source_chat_id: null, last_message_at: '2026-10-19T04:00:00Z' },
  { id: TOPIC_FAR, kind: 'topic', name: '别的话题', source_chat_id: FAR, last_message_at: null },
  { id: AI, kind: 'ai', name: null, source_chat_id: null, last_message_at: '2026-10-19T10:00:00Z' },
];
const memberRows: [string, string][] = [
  [GROUP, P], [GROUP, AG], [GROUP, X],
  [TOPIC, P], [TOPIC, X],
  [TOPIC_AGENT, AG], [TOPIC_AGENT, X],
  [DM, P], [DM, X],
  [AGENT_DM, P], [AGENT_DM, AG],
  [FAR, AG], [FAR, Y],
  [TOPIC_FAR, AG], [TOPIC_FAR, Y],
  [AI, P],
];
const NAMES: Record<string, string> = { [P]: '阿青', [AG]: 'Codex 1', [X]: '小北', [Y]: '老周' };
const isMember = (chat: string, user: string) => memberRows.some(([c, u]) => c === chat && u === user);
const chatRow = (id: string) => chats.find((chat) => chat.id === id)!;

/** `chat.chat_members` read with P's token: `members_select_peer` = `chat.is_member(chat_id)`, P's own membership. */
const tableMembers = (chat: string) => (isMember(chat, P) ? memberRows.filter(([c]) => c === chat).map(([, u]) => u) : []);

function rpc(name: string, args: Record<string, unknown>) {
  if (name === 'list_my_chats_as') {
    const actor = args.p_as_user_id as string;
    const data = chats
      .filter((chat) => isMember(chat.id, actor))
      .sort((a, b) => (b.last_message_at ?? '').localeCompare(a.last_message_at ?? ''))
      .map((chat) => ({ chat_id: chat.id, public_id: 1, kind: chat.kind, status: 'active', name: chat.name, role: 'member', listen_mode: 'active', last_message_at: chat.last_message_at, last_message_preview: '' }));
    return { data, error: null };
  }
  if (name === 'list_member_ids') {
    const chat = args.p_chat_id as string;
    const actor = (args.p_as_user_id as string | null) ?? P;
    const row = chatRow(chat);
    const sees = isMember(chat, actor) || isMember(chat, P)
      || (row.kind === 'topic' && !!row.source_chat_id && (isMember(row.source_chat_id, actor) || isMember(row.source_chat_id, P)));
    const data = sees ? memberRows.filter(([c]) => c === chat).map(([, user_id]) => ({ user_id, role: 'member', listen_mode: 'active' })) : [];
    return { data, error: null };
  }
  throw new Error(`no rpc ${name} here`);
}

function from(table: string) {
  if (table !== 'chat_members') throw new Error(`no table ${table} here`);
  let ids: readonly string[] = [];
  const query = {
    select: () => query,
    in: (_key: string, values: readonly string[]) => ((ids = values), query),
    then: (resolve: (result: unknown) => void) =>
      resolve({ data: ids.flatMap((chat) => tableMembers(chat).map((user_id) => ({ chat_id: chat, user_id }))), error: null }),
  };
  return query;
}

const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
vi.mock('@gugu/core/cloud/supabase', () => ({
  createGuguSupabaseClient: () => ({ from, rpc: async (name: string, args: Record<string, unknown>) => (rpcCalls.push({ name, args }), rpc(name, args)) }),
}));

const { createAppFiles } = await import('./app-files-core');
const files = createAppFiles({
  account: async () => ({ token: 'token', userId: P }),
  hasCapability: () => true,
  sync: { ensureFor: () => undefined,} as never,
  identities: async (_token, ids) => ids.map((id) => ({ id, name: NAMES[id] ?? null, avatar: null, kind: id === AG ? 'agent' as const : 'human' as const })),
  faces: async () => ({}),
  filesUrl: () => 'http://files.invalid',
  warn: () => undefined,
});
const ids = (members: readonly { id: string }[]) => members.map((member) => member.id.replace(/^user:/, ''));

describe('gugu.chats', () => {
  it('both verbs need chat:read', () => {
    expect(BRIDGE_VERBS.chatsList.needs).toBe('chat:read');
    expect(BRIDGE_VERBS.chatsMembers.needs).toBe('chat:read');
  });

  it("list: the person's chats, last spoken first, as message_conversations reads them; a private chat by the other one; no 'ai'", async () => {
    rpcCalls.length = 0;
    expect(await files.chats()).toEqual([
      { id: GROUP, name: '周末出游', kind: 'group', lastMessageAt: '2026-10-19T09:00:00Z' },
      { id: TOPIC, name: '周六路线', kind: 'topic', lastMessageAt: '2026-10-19T08:00:00Z' },
      { id: DM, name: '小北', kind: 'dm', lastMessageAt: '2026-10-19T06:00:00Z' },
      { id: AGENT_DM, name: 'Codex 1', kind: 'dm', lastMessageAt: '2026-10-19T05:00:00Z' },
    ]);
    expect(rpcCalls).toEqual([{ name: 'list_my_chats_as', args: { p_as_user_id: P } }]);
  });

  it("list as an agent: its own chats — the person's or not — and its private chat with the person goes by the person", async () => {
    expect((await files.chats({ asAgent: AG })).map((chat) => [chat.id, chat.name])).toEqual([
      [GROUP, '周末出游'], [TOPIC_AGENT, '订酒店'], [AGENT_DM, '阿青'], [FAR, '别的群'], [TOPIC_FAR, '别的话题'],
    ]);
  });

  it('members as an agent: through list_member_ids as it, so a chat of its own the person is not in has its members', async () => {
    rpcCalls.length = 0;
    expect(ids(await files.members(FAR, { asAgent: AG }))).toEqual([AG, Y]);
    expect(rpcCalls).toEqual([{ name: 'list_member_ids', args: { p_chat_id: FAR, p_as_user_id: AG } }]);
    expect(await files.members(FAR)).toEqual([]);
  });

  it('a member as getContext().chat.members has one: id, name, kind', async () => {
    expect(await files.members(AGENT_DM)).toEqual([
      { id: `user:${P}`, name: '阿青', kind: 'human' },
      { id: `user:${AG}`, name: 'Codex 1', kind: 'agent' },
    ]);
  });
});

/**
 * 170 10-19: `getContext().chat.members` now reads `list_member_ids` too — one door for both. Row by row against the
 * table read it replaced, in a group, a topic, a private chat, and a topic an agent of the person's is in and they are not.
 */
describe('getContext().chat.members, before (the table) and now (list_member_ids)', () => {
  it.each([
    ['a group', GROUP],
    ['a topic the person is in', TOPIC],
    ['a private chat', DM],
    ['a topic neither the person nor its line are theirs (their agent is in it)', TOPIC_FAR],
  ])('%s: the same members', async (_what, chat) => {
    expect(ids(await files.members(chat))).toEqual(tableMembers(chat));
  });

  it('a topic their agent is in, they are not, grown out of a group they are in: before none, now its members', async () => {
    // The person sees this topic (its line is theirs) and can open its panel: the table read it as empty, while the door
    // agents read members by already answered them (gugu-supabase 20261016231621: who may see a topic sees its members).
    expect(tableMembers(TOPIC_AGENT)).toEqual([]);
    expect(ids(await files.members(TOPIC_AGENT))).toEqual([AG, X]);
  });
});
