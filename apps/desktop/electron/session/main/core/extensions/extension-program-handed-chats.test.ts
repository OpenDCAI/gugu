import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A1 `handedChatsAs` — the door a chat goes through before a program may act in it as the calling agent: a public id is
 * changed to the chat's id with the person's token, and the agent itself must be in the chat (`workspace_status_as`, as
 * the agent). The gateway's tests fake this door, so the door is judged here. The token and the client are fakes.
 */

const AGENT = '22222222-2222-4222-8222-222222222222';
const CHAT = '33333333-3333-4333-8333-333333333333';

let token: string | null = 'owner-token';
let publicRows: { id: string }[] = [];
let statusError: { message: string } | null = null;
const lookups: { table: string; column: string; value: unknown }[] = [];
const doors: { name: string; args: Record<string, unknown> }[] = [];

const client = {
  from: (table: string) => {
    const lookup = { table, column: '', value: undefined as unknown };
    const query = {
      select: () => query,
      eq: (column: string, value: unknown) => {
        Object.assign(lookup, { column, value });
        lookups.push(lookup);
        return query;
      },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: publicRows, error: null }).then(resolve),
    };
    return query;
  },
  rpc: async (name: string, args: Record<string, unknown>) => {
    doors.push({ name, args });
    return statusError ? { data: null, error: statusError } : { data: [{ total: 0, documents: 0, files: 0 }], error: null };
  },
};

vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: () => client }));
vi.mock('@gugu/core', () => ({ userIdFromSupabaseAccessToken: (value: string) => (value ? '11111111-1111-4111-8111-111111111111' : null) }));
vi.mock('@main/core/extensions/account-token', () => ({ currentAccountAccessToken: async () => token }));
vi.mock('./file-sync', () => ({ fileSync: {} }));

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
    statusError = { message: `workspace: ${CHAT} is not a chat you are a member of` };
    await expect(handedChatsAs(AGENT, [CHAT])).rejects.toThrow(`${CHAT}: not a chat you are in, so it was not handed over`);
    expect(doors).toEqual([{ name: 'workspace_status_as', args: { p_chat_id: CHAT, p_as_user_id: AGENT } }]);
  });

  it('② a public id that names no chat, or two: refused, and no door is asked', async () => {
    publicRows = [];
    await expect(handedChatsAs(AGENT, ['207957'])).rejects.toThrow('207957: not a chat you are in, so it was not handed over');
    publicRows = [{ id: CHAT }, { id: '44444444-4444-4444-8444-444444444444' }];
    await expect(handedChatsAs(AGENT, ['207957'])).rejects.toThrow('207957: not a chat you are in');
    expect(doors).toEqual([]);
  });

  it('③ a chat\'s own id as it is, a public id that names one chat as that chat\'s id: the door asked as the agent — never the person', async () => {
    expect(await handedChatsAs(AGENT, [CHAT])).toEqual([{ chatId: CHAT, agentUserId: AGENT }]);
    expect(lookups).toEqual([]);
    expect(doors).toEqual([{ name: 'workspace_status_as', args: { p_chat_id: CHAT, p_as_user_id: AGENT } }]);
    publicRows = [{ id: CHAT }];
    expect(await handedChatsAs(AGENT, ['207957'])).toEqual([{ chatId: CHAT, agentUserId: AGENT }]);
    expect(lookups).toEqual([{ table: 'chats', column: 'public_id', value: '207957' }]);
    const door = { name: 'workspace_status_as', args: { p_chat_id: CHAT, p_as_user_id: AGENT } };
    expect(doors).toEqual([door, door]);
  });

  it('nobody signed in: nothing is handed over', async () => {
    token = null;
    await expect(handedChatsAs(AGENT, [CHAT])).rejects.toThrow('Not signed in, so no chat can be handed over');
    expect(doors).toEqual([]);
  });
});
