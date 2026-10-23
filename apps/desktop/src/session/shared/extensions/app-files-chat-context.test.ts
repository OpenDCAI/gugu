import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 「在本群打开」(app-redesign §5, 统筹 10-05): `getContext().chat` — the chat a page is drawn for, read once for both hosts
 * (`extensionChatOf`). A group is its own group; a topic goes by the group it grew out of; a topic of a private chat
 * belongs to no group. 主人 10-05「私聊也是得有面板的」: a private chat is a chat a page is drawn for too — of no group,
 * named for whoever looks by the other one in it. Control (the parent commit): a private chat was null.
 */

const GROUP = '11111111-1111-4111-8111-111111111111';
const TOPIC = '22222222-2222-4222-8222-222222222222';
const DM = '33333333-3333-4333-8333-333333333333';
const DM_TOPIC = '44444444-4444-4444-8444-444444444444';
const MISSING = '55555555-5555-4555-8555-555555555555';
const AI = '66666666-6666-4666-8666-666666666666';

const chats = [
  { id: GROUP, kind: 'group', name: '周末出游', source_chat_id: null },
  { id: TOPIC, kind: 'topic', name: '周六路线', source_chat_id: GROUP },
  { id: DM, kind: 'dm', name: null, source_chat_id: null },
  { id: DM_TOPIC, kind: 'topic', name: '私聊里的话题', source_chat_id: DM },
  { id: AI, kind: 'ai', name: null, source_chat_id: null },
];

const A = '0a000000-0000-4000-8000-00000000000a';
const B = '0a000000-0000-4000-8000-00000000000b';
const members = [{ chat_id: GROUP, user_id: A }, { chat_id: GROUP, user_id: B }, { chat_id: DM, user_id: A }, { chat_id: DM, user_id: B }];
const NAMES: Record<string, string> = { [A]: '阿青', [B]: '小北' };
/** What `identities` answers: each one's own name — the one they gave themselves. */
const people = { identities: async (_token: string, ids: readonly string[]) => ids.map((id) => ({ id, name: NAMES[id] ?? null, avatar: null, kind: 'human' as const })) };

function table(name: string) {
  const filters: [string, unknown][] = [];
  const matching = <T>(rows: T[]) => rows.filter((row) => filters.every(([key, value]) => (row as Record<string, unknown>)[key] === value));
  const query = {
    select: () => query,
    eq: (key: string, value: unknown) => (filters.push([key, value]), query),
    maybeSingle: async () => ({ data: name === 'chats' ? (matching(chats)[0] ?? null) : null, error: null }),
    then: (resolve: (result: unknown) => void) => resolve({ data: name === 'chat_members' ? matching(members) : [], error: null }),
  };
  return query;
}

// A chat's members come through the door `message_members` takes (`list_member_ids`): app-files-chats.test.ts keeps its rule.
const rpc = async (_name: string, args: { p_chat_id: string }) => ({ data: members.filter((row) => row.chat_id === args.p_chat_id), error: null });
vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: () => ({ from: table, rpc }) }));

const { createAppFiles, extensionChatOf, rosterMoved } = await import('./app-files-core');

/**
 * 统筹 10-05 (画廊车道 §6): every update of a member row sends `chat_members_changed` — a read mark, a pin, mute — and the
 * host read the members again and pushed the whole context for each. Only a change of who is there is one: someone left,
 * or an id not among them came. Control (the parent commit): no such check, every row pushed.
 */
describe('a member row changed: did that move who is in the chat (rosterMoved)', () => {
  const members = [{ id: 'user:a' }, { id: 'user:b' }];
  it('a read mark, a pin, mute of someone already there moves nobody', () => {
    expect(rosterMoved(members, [{ memberId: 'a', left: false }, { memberId: 'b', left: false }])).toBe(false);
  });
  it('someone left, someone new came, or who is unknown: it moved', () => {
    expect(rosterMoved(members, [{ memberId: 'b', left: true }])).toBe(true);
    expect(rosterMoved(members, [{ memberId: 'a', left: false }, { memberId: 'c', left: false }])).toBe(true);
    expect(rosterMoved(members, [{ memberId: null, left: false }])).toBe(true);
  });
  it('members not read yet: read them', () => {
    expect(rosterMoved(null, [{ memberId: 'a', left: false }])).toBe(true);
  });
});

describe('getContext().chat (extensionChatOf)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a group is its own group', async () => {
    await expect(extensionChatOf('token', GROUP, A, people)).resolves.toEqual({ id: GROUP, name: '周末出游', kind: 'group', groupId: GROUP });
  });

  it('a topic goes by the group it grew out of', async () => {
    await expect(extensionChatOf('token', TOPIC, A, people)).resolves.toEqual({ id: GROUP, name: '周末出游', kind: 'group', groupId: GROUP });
  });

  it('a topic of a private chat belongs to no group', async () => {
    await expect(extensionChatOf('token', DM_TOPIC, A, people)).resolves.toEqual({ id: DM, name: '小北', kind: 'dm', groupId: null });
  });

  it('a private chat is a chat of no group, called by the other one in it — each side sees the other', async () => {
    await expect(extensionChatOf('token', DM, A, people)).resolves.toEqual({ id: DM, name: '小北', kind: 'dm', groupId: null });
    await expect(extensionChatOf('token', DM, B, people)).resolves.toEqual({ id: DM, name: '阿青', kind: 'dm', groupId: null });
  });

  it("'ai' has no workspace: no chat a page is drawn for", async () => {
    await expect(extensionChatOf('token', AI, A, people)).resolves.toBeNull();
  });

  it('a chat the person cannot read is said, not left out', async () => {
    await expect(extensionChatOf('token', MISSING, A, people)).rejects.toThrow('This chat could not be read');
  });

  it('the files API reads it for a surface, as it reads the members — a private chat as the signed-in person, or the agent it acts as', async () => {
    const files = createAppFiles({
      account: async () => ({ token: 'token', userId: A }),
      hasCapability: () => true,
      sync: {} as never,
      identities: people.identities,
      faces: async () => ({}),
      filesUrl: () => 'http://files.invalid',
      warn: () => undefined,
    });
    await expect(files.chat(TOPIC)).resolves.toMatchObject({ id: GROUP, kind: 'group', groupId: GROUP });
    await expect(files.chat(DM)).resolves.toMatchObject({ kind: 'dm', name: '小北' });
  });
});

/**
 * 统筹 10-05 (画廊车道 §6): `members[].avatar` — the face the host draws for each member, small, as a `data:` URL. Asked
 * for the chat's own members only, by their upload (a new upload is a new URL: the face's version). Control (the parent
 * commit): members had no face; an App drew initials for everyone.
 */
describe('getContext().chat.members[].avatar', () => {
  it("each member carries the face the host drew for them; faces are asked for this chat's members only", async () => {
    const faces = vi.fn(async (people: readonly { id: string; avatar: string | null }[]) =>
      Object.fromEntries(people.filter((person) => person.id === A).map((person) => [person.id, `data:image/webp;base64,${person.avatar}`])),
    );
    const files = createAppFiles({
      account: async () => ({ token: 'token', userId: A }),
      hasCapability: () => true,
      sync: {} as never,
      identities: async (_token, ids) => ids.map((id) => ({ id, name: id === A ? 'A' : 'B', avatar: id === A ? 'upload-1' : null, kind: 'human' as const })),
      faces,
      filesUrl: () => 'http://files.invalid',
      warn: () => undefined,
    });
    const read = await files.members(GROUP);
    expect(faces).toHaveBeenCalledWith([{ id: A, avatar: 'upload-1' }, { id: B, avatar: null }]);
    // B's face could not be drawn: B is there by name, with no avatar — never someone else's.
    expect(read).toEqual([
      { id: `user:${A}`, name: 'A', kind: 'human', avatar: 'data:image/webp;base64,upload-1' },
      { id: `user:${B}`, name: 'B', kind: 'human' },
    ]);
  });
});
