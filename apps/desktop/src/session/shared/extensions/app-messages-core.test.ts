import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_VERBS } from './bridge-protocol';

/**
 * `gugu.messages` (`chat:read`): the doors an agent's message_history / message_search take, as whoever reads — the person
 * (no `p_as_user_id`) or the agent (`p_as_user_id`) — and every file link in a message read for the App (`refs`).
 */

const CHAT = '33333333-3333-4333-8333-333333333333';
const AGENT = '22222222-2222-4222-8222-222222222222';
const SENDER = '11111111-1111-4111-8111-111111111111';
const PDF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const row = (seq: number, content: string) => ({
  id: `0000000${seq}-0000-4000-8000-000000000000`, seq, sender_user_id: SENDER, sender_name: 'Alice', content,
  content_type: 'text', thread_root_id: null, created_at: '2026-10-19T01:00:00Z',
});
const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
let answer: { data: unknown; error: { message: string } | null } = { data: [], error: null };

vi.mock('@gugu/core/cloud/supabase', () => ({
  createGuguSupabaseClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return answer;
    },
  }),
}));

const { createAppMessages } = await import('./app-messages-core');
const messages = createAppMessages({ account: async () => ({ token: 'token' }) });

beforeEach(() => {
  rpcCalls.length = 0;
  answer = { data: [], error: null };
});

describe('gugu.messages', () => {
  it('both verbs need chat:read', () => {
    expect(BRIDGE_VERBS.messagesHistory.needs).toBe('chat:read');
    expect(BRIDGE_VERBS.messagesSearch.needs).toBe('chat:read');
  });

  it('history reads the timeline through message_history_as, as the person or as the agent', async () => {
    await messages.history({ chat: CHAT.toUpperCase() });
    await messages.history({ chat: CHAT, thread: 'root', before: 40, limit: 10 }, { asAgent: AGENT });
    expect(rpcCalls).toEqual([
      { name: 'message_history_as', args: { p_chat_id: CHAT, p_as_user_id: null, p_thread_root_id: null, p_before_seq: null, p_limit: 50 } },
      { name: 'message_history_as', args: { p_chat_id: CHAT, p_as_user_id: AGENT, p_thread_root_id: 'root', p_before_seq: 40, p_limit: 10 } },
    ]);
  });

  it('search by file looks for its link; each message carries every file link in it, read as gugu reads one', async () => {
    answer = {
      data: [
        row(9, `看这句 @[paper.pdf · 第 3 页](gugu-file://${PDF}?v=2#page=3&h=h1) 和 [表](gugu-file://${OTHER})`),
        row(8, `no link here`),
      ],
      error: null,
    };
    const page = await messages.search({ chat: CHAT, file: { id: PDF.toUpperCase(), chat: CHAT }, limit: 2 });
    expect(rpcCalls).toEqual([
      { name: 'message_search_as', args: { p_chat_id: CHAT, p_query: `gugu-file://${PDF}`, p_as_user_id: null, p_before_seq: null, p_limit: 2 } },
    ]);
    expect(page.next).toBe(8);
    expect(page.messages[0]).toMatchObject({
      seq: 9,
      chat: CHAT,
      sender: { id: `user:${SENDER}`, name: 'Alice' },
      refs: [{ file: PDF, version: 2, at: { page: '3', h: 'h1' } }, { file: OTHER }],
    });
    expect(page.messages[1]!.refs).toEqual([]);
  });

  it('a short page has no next', async () => {
    answer = { data: [row(3, 'hi')], error: null };
    expect((await messages.search({ chat: CHAT, query: 'hi' })).next).toBeNull();
  });

  it('a line gugu wrote itself (someone joined) has no sender', async () => {
    answer = { data: [{ ...row(7, 'Codex 1 加入了群聊'), sender_user_id: null, sender_name: '未知用户', content_type: 'system' }, row(8, 'hi')], error: null };
    const page = await messages.history({ chat: CHAT });
    expect(page.messages.map((m) => m.sender)).toEqual([null, { id: `user:${SENDER}`, name: 'Alice' }]);
    expect(page.messages[0]!.contentType).toBe('system');
  });

  it('says what is wrong with a call, and what the door said', async () => {
    await expect(messages.history({})).rejects.toMatchObject({ code: 'invalid' });
    await expect(messages.history({ chat: '211178' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(messages.history({ chat: CHAT, limit: 101 })).rejects.toMatchObject({ code: 'invalid' });
    await expect(messages.search({ chat: CHAT })).rejects.toMatchObject({ code: 'invalid' });
    await expect(messages.search({ chat: CHAT, query: 'x', file: PDF })).rejects.toMatchObject({ code: 'invalid' });
    expect(rpcCalls).toEqual([]);
    answer = { data: null, error: { message: 'Not allowed to act as x' } };
    await expect(messages.history({ chat: CHAT })).rejects.toMatchObject({ code: 'failed', message: 'Not allowed to act as x' });
  });
});
