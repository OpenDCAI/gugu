import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A1 `handedChatsAs` — the door a chat goes through before a program may act in it as the calling agent: a public id is
 * changed to the chat's id through the actor's list (even when its owner is outside), and the agent itself must be in the chat (`workspace_status_as`, as
 * the agent). The gateway's tests fake this door, so the door is judged here. The token and the client are fakes.
 */

const AGENT = '22222222-2222-4222-8222-222222222222';
const CHAT = '33333333-3333-4333-8333-333333333333';

let token: string | null = 'owner-token';
let publicRows: { chat_id: string; public_id: number }[] = [];
let statusError: { message: string; hint?: string } | null = null;
const lookups: { table: string; column: string; value: unknown }[] = [];
const doors: { name: string; args: Record<string, unknown> }[] = [];

const client = {
  from: (table: string) => { throw new Error(`The owner reads no chat table: ${table}`); },
  rpc: async (name: string, args: Record<string, unknown>) => {
    if (name === 'list_my_chats_as') {
      lookups.push({ table: name, column: 'p_as_user_id', value: args.p_as_user_id });
      return { data: publicRows, error: null };
    }
    doors.push({ name, args });
    if (name === 'chat_facts') return { data: [{ id: args.p_chat_id, kind: 'group', source_chat_id: null }], error: null };
    return statusError ? { data: null, error: statusError } : { data: [{ total: 0, documents: 0, files: 0 }], error: null };
  },
};

vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: () => client }));
vi.mock('@gugu/core', () => ({ userIdFromSupabaseAccessToken: (value: string) => (value ? '11111111-1111-4111-8111-111111111111' : null) }));
vi.mock('@main/core/extensions/account-token', () => ({ currentAccountAccessToken: async () => token }));
vi.mock('./file-sync', () => ({ fileSync: {} }));
vi.mock('@main/lib/logger', () => ({ log: { warn: () => {} } }));

const { handedChatsAs } = await import('./extension-program-surface');

beforeEach(() => {
  token = 'owner-token';
  publicRows = [];
  statusError = null;
  lookups.length = 0;
  doors.length = 0;
});

describe('handedChatsAs: a chat is handed only as the agent, and only one the agent is in', () => {
  it('① the agent is not in it (its door refuses): refused, naming the chat — the program is never handed it', async () => {
    statusError = { message: `workspace: ${CHAT} is not a chat you are a member of`, hint: 'workspace_not_member' };
    await expect(handedChatsAs(AGENT, [CHAT])).rejects.toThrow(`${CHAT}: not a chat you are in, so it was not handed over`);
    expect(doors).toEqual([{ name: 'workspace_status_as', args: { p_chat_id: CHAT, p_as_user_id: AGENT } }]);
  });

  it('② a public id that names no chat, or two: refused, and no door is asked', async () => {
    publicRows = [];
    await expect(handedChatsAs(AGENT, ['207957'])).rejects.toThrow('207957: not a chat you are in, so it was not handed over');
    publicRows = [{ chat_id: CHAT, public_id: 207957 }, { chat_id: '44444444-4444-4444-8444-444444444444', public_id: 207957 }];
    await expect(handedChatsAs(AGENT, ['207957'])).rejects.toThrow('207957: not a chat you are in');
    expect(doors).toEqual([]);
  });

  it('③ a chat\'s own id as it is, a public id that names one chat as that chat\'s id: the door asked as the agent — never the person', async () => {
    expect(await handedChatsAs(AGENT, [CHAT])).toEqual([{ chatId: CHAT, resourceChatId: CHAT, agentUserId: AGENT }]);
    expect(lookups).toEqual([]);
    expect(doors).toEqual([{ name: 'workspace_status_as', args: { p_chat_id: CHAT, p_as_user_id: AGENT } }, { name: 'chat_facts', args: { p_chat_id: CHAT, p_as_user_id: AGENT } }]);
    publicRows = [{ chat_id: CHAT, public_id: 207957 }];
    expect(await handedChatsAs(AGENT, ['207957'])).toEqual([{ chatId: CHAT, resourceChatId: CHAT, agentUserId: AGENT }]);
    expect(lookups).toEqual([{ table: 'list_my_chats_as', column: 'p_as_user_id', value: AGENT }]);
    const door = { name: 'workspace_status_as', args: { p_chat_id: CHAT, p_as_user_id: AGENT } };
    expect(doors).toEqual([door, { name: 'chat_facts', args: { p_chat_id: CHAT, p_as_user_id: AGENT } }, door, { name: 'chat_facts', args: { p_chat_id: CHAT, p_as_user_id: AGENT } }]);
  });

  it('④ a door that could not answer (an expired token): said as what it was — never as "not a chat you are in"', async () => {
    statusError = { message: 'JWT expired' };
    const refused = handedChatsAs(AGENT, [CHAT]);
    await expect(refused).rejects.toThrow(`${CHAT}: could not check that you are in this chat: JWT expired`);
    await expect(refused).rejects.not.toThrow('not a chat you are in');
  });

  it('nobody signed in: nothing is handed over', async () => {
    token = null;
    await expect(handedChatsAs(AGENT, [CHAT])).rejects.toThrow('Not signed in, so no chat can be handed over');
    expect(doors).toEqual([]);
  });
});
