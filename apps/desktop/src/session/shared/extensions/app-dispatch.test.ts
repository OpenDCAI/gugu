import { describe, expect, it, vi } from 'vitest';

/**
 * `gugu.dispatch` (15, owner 10-25「全部统一」): one verb, one answer for the desktop and the phone (`app-send-core.ts`), the
 * platform bringing its sheet, composers and — where it has them — the person's agents. The door (the verb's row) asks the
 * capability the target needs, or none when the person picks; the desktop's agents are in `extension-send.test.ts`.
 */

const OWNER = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const GROUP = '44444444-4444-4444-8444-444444444444';
const rpcs: Array<Record<string, unknown>> = [];
let rpcError: { code: string; message: string } | null = null;

vi.mock('@gugu/core/cloud/supabase', () => ({
  createGuguSupabaseClient: () => ({
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: table === 'users' ? { id: AGENT, type: 'agent', display_name: '小咕' } : table === 'chats' ? { id: GROUP } : { user_id: AGENT }, error: null }),
      };
      return q;
    },
    rpc: async (_name: string, args: Record<string, unknown>) => {
      rpcs.push(args);
      return { error: rpcError };
    },
  }),
}));

const { dispatchFromApp } = await import('./app-send-core');
const { dispatchCallOf, dispatchNeeds, dispatchNeedsGesture, dispatchOffers } = await import('./app-dispatch-core');
const { EXTENSION_API_VERSION, callRefusal } = await import('./bridge-protocol');

const account = async () => ({ token: 'page-token', userId: OWNER });
const chat = { id: GROUP, name: 'A群', members: [{ id: `user:${AGENT}`, name: '小咕', kind: 'agent' as const }, { id: `user:${OWNER}`, name: '我', kind: 'human' as const }] };
/** The phone's platform: its sheet and the chat shell's composer, no agents of the person's. */
const phone = (picked: unknown = null) => {
  const asked: unknown[] = [];
  const drafts: unknown[] = [];
  return {
    asked,
    drafts,
    platform: {
      account,
      pick: async (ask: unknown) => {
        asked.push(ask);
        return picked as never;
      },
      draftInChat: async (detail: unknown) => void drafts.push(detail),
    },
  };
};

describe('the verb row: what a call needs', () => {
  it('this build is 23', () => expect(EXTENSION_API_VERSION).toBe(23));

  it('the person picks, or only a draft goes down: no capability, but their gesture; a named target: what its delivery needed', () => {
    expect(dispatchNeeds({})).toBeNull();
    expect(dispatchNeeds({ draft: true, to: { chat: GROUP } })).toBeNull();
    expect(dispatchNeeds({ to: { chat: GROUP, member: `user:${AGENT}` } })).toBe('chat:relay');
    expect(dispatchNeeds({ to: { agent: `user:${AGENT}` } })).toBe('agents:control');
    expect(dispatchNeeds({ to: { new: true } })).toBe('agents:control');
    expect(dispatchNeedsGesture({})).toBe(true);
    expect(dispatchNeedsGesture({ draft: true, to: { chat: GROUP } })).toBe(true);
    expect(dispatchNeedsGesture({ to: { agent: `user:${AGENT}` } })).toBe(false);
  });

  it('at the door: no chat:relay refuses a named member, not the sheet; a program never opens the sheet', () => {
    const has = () => false;
    expect(callRefusal('dispatch', { to: { chat: GROUP, member: `user:${AGENT}` }, text: 'x' }, { kind: 'page', has })).toMatchObject({ code: 'denied', message: expect.stringContaining('chat:relay') });
    expect(callRefusal('dispatch', { text: 'x' }, { kind: 'page', has, gesture: true })).toBeNull();
    expect(callRefusal('dispatch', { text: 'x' }, { kind: 'page', has, gesture: false })).toMatchObject({ code: 'denied', message: expect.stringContaining('gesture') });
    expect(callRefusal('dispatch', { text: 'x' }, { kind: 'program', has })).toMatchObject({ code: 'denied' });
    expect(callRefusal('dispatch', { to: { agent: `user:${AGENT}` }, text: 'x' }, { kind: 'program', has: () => true })).toBeNull();
    // The old verbs are not verbs any more.
    for (const gone of ['compose', 'send', 'messageAgent', 'spawnAgent']) expect(callRefusal(gone, {}, { kind: 'page', has })).toMatchObject({ code: 'invalid' });
  });

  it('what goes with which target is said where it does not', () => {
    expect(() => dispatchCallOf({ text: '' })).toThrow(/text is empty/);
    expect(() => dispatchCallOf({ text: 'x', to: { chat: GROUP } })).toThrow(/A chat as such is told nothing/);
    expect(() => dispatchCallOf({ text: 'x', draft: true, to: { new: true } })).toThrow(/A draft goes into a composer/);
    expect(() => dispatchCallOf({ text: 'x', visible: true, to: { agent: `user:${AGENT}` } })).toThrow(/visible is for a member/);
    expect(() => dispatchCallOf({ text: 'x', delivery: 'queue', to: { chat: GROUP, member: `user:${AGENT}` } })).toThrow(/delivery and key are for one of your agents/);
    expect(() => dispatchCallOf({ text: 'x', images: [] })).toThrow(/images go only into a chat/);
    expect(() => dispatchCallOf({ text: 'x', to: { agent: AGENT } })).toThrow(/user:<uuid>/);
    expect(() => dispatchCallOf({ text: 'x', offer: ['everyone'] })).toThrow(/offer is a list/);
    // A new agent's words: a wrong one is refused, never quietly dropped (C lane 10-26: spawn.chat as { id, name }).
    expect(() => dispatchCallOf({ text: 'x', to: { new: true }, spawn: { chat: { id: GROUP, name: 'A群' } } })).toThrow(/spawn.chat is a chat's id, a string/);
    expect(() => dispatchCallOf({ text: 'x', to: { new: true }, spawn: { transport: 'tty' } })).toThrow(/spawn.transport/);
    expect(() => dispatchCallOf({ text: 'x', to: { new: true }, spawn: { title: 7 } })).toThrow(/spawn.title is a non-empty string/);
    expect(() => dispatchCallOf({ text: 'x', to: { new: true }, spawn: { birthGroup: GROUP } })).toThrow(/no birthGroup/);
    expect(dispatchCallOf({ text: 'x', to: { new: true }, spawn: { chat: GROUP, title: 'Card', transport: 'acp', model: null } }).spawn).toEqual({ chat: GROUP, title: 'Card', transport: 'acp' });
  });

  it('what the sheet offers by default, and what a host without the person’s agents leaves out', () => {
    const send = dispatchCallOf({ text: 'x' });
    expect(dispatchOffers(send, { inChat: true, agents: true })).toEqual(['agent-in-chat', 'person-in-chat', 'my-agent', 'new-agent']);
    expect(dispatchOffers(send, { inChat: true, agents: false })).toEqual(['agent-in-chat', 'person-in-chat']);
    expect(dispatchOffers(send, { inChat: false, agents: true })).toEqual(['my-agent', 'new-agent']);
    expect(dispatchOffers(dispatchCallOf({ text: 'x', draft: true }), { inChat: true, agents: true })).toEqual(['chat', 'my-agent']);
  });
});

describe('dispatchFromApp (the shared answer)', () => {
  it('a member named: a whisper, as the person, via this App', async () => {
    const { platform } = phone();
    const sent = await dispatchFromApp(platform, 'dinner-vote', { text: 'done', to: { chat: GROUP, member: `user:${AGENT}` } }, { chat, preselect: null });
    expect(sent).toMatchObject({ to: { chat: GROUP, member: `user:${AGENT}` }, id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(rpcs.at(-1)).toMatchObject({ p_chat_id: GROUP, p_sender_user_id: OWNER, p_to_user_ids: [AGENT], p_is_whisper: true, p_via_app: 'dinner-vote', p_content: 'done' });
  });

  it('visible (owner 10-25「允许」): a message the chat sees, @ the member, still marked as this App’s', async () => {
    const { platform } = phone();
    await dispatchFromApp(platform, 'dinner-vote', { text: 'your move', visible: true, to: { chat: GROUP, member: `user:${AGENT}` } }, { chat, preselect: null });
    expect(rpcs.at(-1)).toMatchObject({ p_to_user_ids: [AGENT], p_is_whisper: false, p_via_app: 'dinner-vote', p_content: '@小咕 your move' });
  });

  it('worked by the person’s agent (owner 10-14): written as that agent', async () => {
    const WORKER = '33333333-3333-4333-8333-333333333333';
    const { platform } = phone();
    await dispatchFromApp(platform, 'dinner-vote', { text: 'done', to: { chat: GROUP, member: `user:${AGENT}` } }, { chat, preselect: null, as: WORKER });
    expect(rpcs.at(-1)).toMatchObject({ p_sender_user_id: WORKER });
  });

  it('no target: the sheet is asked with what will go; the person’s pick and their text are what goes', async () => {
    const { platform, asked } = phone({ to: { chat: GROUP, member: `user:${AGENT}` }, visible: false, text: 'host this round' });
    const sent = await dispatchFromApp(platform, 'turtle-soup', { text: 'host', offer: ['agent-in-chat'] }, { chat, preselect: null });
    expect(asked.at(-1)).toMatchObject({ draft: false, offers: ['agent-in-chat'], text: 'host', chat: { id: GROUP } });
    // The person is not offered to themselves.
    expect((asked.at(-1) as { chat: { members: { id: string }[] } }).chat.members.map((member) => member.id)).toEqual([`user:${AGENT}`]);
    expect(sent).toMatchObject({ to: { chat: GROUP, member: `user:${AGENT}` } });
    expect(rpcs.at(-1)).toMatchObject({ p_content: 'host this round', p_is_whisper: true });
  });

  it('cancelled in the sheet: nothing goes, the App hears so', async () => {
    const { platform } = phone(null);
    const before = rpcs.length;
    await expect(dispatchFromApp(platform, 'x', { text: 'hi' }, { chat, preselect: null })).resolves.toEqual({ cancelled: true });
    expect(rpcs.length).toBe(before);
  });

  it('a draft into a chat: the chat shell takes it, nothing is sent', async () => {
    const { platform, drafts } = phone();
    const before = rpcs.length;
    await expect(dispatchFromApp(platform, 'x', { text: 'hello', draft: true, to: { chat: GROUP } }, { chat, preselect: null })).resolves.toEqual({ to: { chat: GROUP } });
    expect(drafts.at(-1)).toMatchObject({ chatId: GROUP, text: 'hello\n' });
    expect(rpcs.length).toBe(before);
  });

  it('a platform without the person’s agents (the phone): the sheet offers none, a named one is not found here', async () => {
    const { platform, asked } = phone(null);
    await dispatchFromApp(platform, 'x', { text: 'hi' }, { chat: null, preselect: null }).catch((error: unknown) => error);
    expect(asked).toHaveLength(0);
    await expect(dispatchFromApp(platform, 'x', { text: 'hi' }, { chat: null, preselect: null })).rejects.toMatchObject({ code: 'not-found' });
    await expect(dispatchFromApp(platform, 'x', { text: 'hi', to: { agent: `user:${AGENT}` } }, { chat, preselect: null })).rejects.toMatchObject({ code: 'not-found' });
  });

  it('the person’s agents, where the platform has them: told, started, drafted into — each answering by its agent', async () => {
    const calls: unknown[] = [];
    const platform = {
      ...phone().platform,
      agents: {
        draft: async (agent: unknown, text: string) => (calls.push(['draft', agent, text]), `user:${AGENT}`),
        tell: async (agent: unknown, text: string, how: unknown) => (calls.push(['tell', agent, text, how]), { agent: `user:${AGENT}`, id: 'm1' }),
        spawn: async (prompt: string, spawn: unknown) => (calls.push(['spawn', prompt, spawn]), `user:${AGENT}`),
      },
    };
    await expect(dispatchFromApp(platform, 'radar', { text: 'ping', to: { agent: `user:${AGENT}` }, delivery: 'defer', key: 'k' }, { chat: null, preselect: null }))
      .resolves.toEqual({ to: { agent: `user:${AGENT}` }, id: 'm1' });
    await expect(dispatchFromApp(platform, 'kanban', { text: 'do it', to: { new: true }, spawn: { title: 'Card' } }, { chat: null, preselect: null }))
      .resolves.toEqual({ to: { agent: `user:${AGENT}` } });
    await expect(dispatchFromApp(platform, 'kanban', { text: 'look', draft: true, to: { agent: `user:${AGENT}` } }, { chat: null, preselect: null }))
      .resolves.toEqual({ to: { agent: `user:${AGENT}` } });
    expect(calls).toEqual([
      ['tell', { agent: `user:${AGENT}`, named: true }, 'ping', { delivery: 'defer', key: 'k' }],
      ['spawn', 'do it', { title: 'Card' }],
      ['draft', { agent: `user:${AGENT}`, named: true }, 'look'],
    ]);
  });

  it('the server’s limit comes back as rate-limited; about is gone', async () => {
    const { platform } = phone();
    rpcError = { code: 'PT429', message: 'rate-limited' };
    await expect(dispatchFromApp(platform, 'x', { text: 'again', to: { chat: GROUP, member: `user:${AGENT}` } }, { chat, preselect: null })).rejects.toMatchObject({ code: 'rate-limited' });
    rpcError = null;
    await expect(dispatchFromApp(platform, 'x', { text: 'x', about: { id: GROUP } }, { chat, preselect: null })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('about is gone') });
  });
});
