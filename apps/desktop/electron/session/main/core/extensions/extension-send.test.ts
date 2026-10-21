import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 摩擦单 F16:App 告诉别人一件事,两个动词,和 agent 的两个工具一样(真源 §4 F16):`gugu.send(to, text, { chat } | { refs })`
 * 以人的名义在调用点名的那个 chat 里发悄悄话;`gugu.messageAgent(agentId, text)` 告诉这个人自己的一个本机 agent,和
 * `session_message` 同一条投递。页面在哪都不参与(真源原则 13);要什么能力在桥的门口按动词那一行查(extension-bridge 的测试)。
 * 这里判「发到哪、发给谁、以谁的名义、写成什么」:库(PostgREST 客户端)、账号、能力、可见范围、会话投递换成假的,判断本身是真的。
 */

const OWNER = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const PERSON = '33333333-3333-4333-8333-333333333333';
const GROUP = '44444444-4444-4444-8444-444444444444';
const OTHER_GROUP = '55555555-5555-4555-8555-555555555555';
const ITEM = '66666666-6666-4666-8666-666666666666';
const ELSEWHERE = '77777777-7777-4777-8777-777777777777';

const users = new Map<string, string>([[OWNER, 'human'], [AGENT, 'agent'], [PERSON, 'human']]);
/** A file of another group: a call's refs are one chat's. */
const ITEM_ELSEWHERE = '99999999-9999-4999-8999-999999999999';
/** A folder of the group (子文件夹): listed, never opened — no pill points at it. */
const FOLDER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const items = new Map<string, { id: string; chat_id: string; kind?: string; filename: string; version: number }>([
  [ITEM, { id: ITEM, chat_id: GROUP, filename: 'card[17].vote.json', version: 7 }],
  [FOLDER, { id: FOLDER, chat_id: GROUP, kind: 'folder', filename: '合同', version: 1 }],
  [ITEM_ELSEWHERE, { id: ITEM_ELSEWHERE, chat_id: OTHER_GROUP, filename: 'other.vote.json', version: 1 }],
]);
let rpcError: { code: string; message: string } | null = null;
const rpcs: Array<{ name: string; args: Record<string, unknown> }> = [];

function query(table: string) {
  const filters = new Map<string, unknown>();
  const q = {
    select: () => q,
    eq: (key: string, value: unknown) => (filters.set(key, value), q),
    // The files a call's refs point at, read at once.
    in: async (key: string, values: string[]) => {
      if (table !== 'workspace_items' || key !== 'id') throw new Error(`unexpected ${table}.${key} in`);
      return { data: values.flatMap((id) => (items.has(id) ? [items.get(id)] : [])), error: null };
    },
    maybeSingle: async () => {
      if (table === 'workspace_items') return { data: items.get(String(filters.get('id'))) ?? null, error: null };
      if (table === 'chats') return { data: [GROUP].includes(String(filters.get('id'))) ? { id: filters.get('id') } : null, error: null };
      if (table === 'users') {
        const type = users.get(String(filters.get('id')));
        return { data: type ? { id: filters.get('id'), type } : null, error: null };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return q;
}

vi.mock('@gugu/core/cloud/supabase', () => ({
  createGuguSupabaseClient: () => ({
    from: query,
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args });
      return { error: rpcError };
    },
  }),
}));
vi.mock('@gugu/core', () => ({ userIdFromSupabaseAccessToken: () => OWNER }));
vi.mock('@main/core/extensions/account-token', () => ({ currentAccountAccessToken: async () => 'owner-token' }));
const granted = new Set<string>();
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({
    get: (id: string) => ({ manifest: { name: `App ${id}` } }),
    hasCapability: (_id: string, wanted: string) => granted.has(wanted) || granted.has(`${wanted}:all`),
    agentReach: (_id: string, family: string) =>
      granted.has(`${family}:all-machines`) ? 'all-machines' : granted.has(`${family}:all`) ? 'all' : 'own',
  }),
}));
/** An agent on another of the person's computers, as that computer's task list shows it. */
const REMOTE = '88888888-8888-4888-8888-888888888888';
/** The other machines: who was told, with what. */
/** Machines the listing could not read (offline, no answer, too old). */
let elsewhereUnreached: Array<{ deviceId: string; label: string; detail: string }> = [];
const remoteSent: Array<{ app: unknown; deviceId: string; sessionId: string; text: string; how: Record<string, unknown> }> = [];
let remoteFailure: Error | null = null;
vi.mock('@main/core/sessions/session-family', () => ({
  otherMachines: () => ({
    appMessage: async (app: unknown, deviceId: string, sessionId: string, text: string, how: Record<string, unknown>) => {
      if (remoteFailure) throw remoteFailure;
      remoteSent.push({ app, deviceId, sessionId, text, how });
      return { id: 'msg-remote' };
    },
  }),
}));
/** The agents a scope reaches, by App id → session: the ones the App started, or with `:all` every one. */
const scopes: string[] = [];
vi.mock('@main/core/extensions/extension-agents', () => ({
  sessionsElsewhere: async () => ({
    rows: [{ deviceId: 'd1', deviceLabel: 'ThinkPad', session: { conversationId: 'conv-remote', agent: { userId: REMOTE } } }],
    unreached: elsewhereUnreached,
  }),
  visibleAgentsForExtension: async (options: { scope: 'own' | 'all' | 'all-machines' }) => {
    scopes.push(options.scope);
    return new Map([
      [`user:${AGENT}`, 'conv-agent'],
      ...(options.scope !== 'own' ? [[`user:${ELSEWHERE}`, 'conv-elsewhere'] as [string, string]] : []),
    ]);
  },
}));
/** What the session-direct leg got: the session, the words, the bytes the App's envelope made of them, and who told it. */
const toldSessions: Array<{ sessionId: string; text: string; envelope: string; from?: string }> = [];
vi.mock('@main/core/sessions/session-orchestration', () => ({
  messageSessionFrom: async (envelope: (messageId: string, text: string) => string, sessionId: string, text: string, options: { from?: string }) => {
    // The session layer's refusal names the session (an agent addresses sessions so); `cold` stands for one it could not wake.
    if (text === 'cold') throw new Error(`[SESSION_DIRECT_NOT_LIVE] target session could not be woken (no channel): ${sessionId}`);
    toldSessions.push({ sessionId, text, envelope: envelope('m-env', text), from: options.from });
    return { id: 'msg-1' };
  },
}));

vi.mock('@main/core/extensions/extension-agent-context', () => ({
  agentSessionContext: async (sessionId: string) => (sessionId === 'task-1' ? { sessionId, projectId: 'p-1', workspaceRoot: null } : null),
}));
const { composeTarget, messageAgentFromApp, sendFromApp } = await import('./extension-send');
const { ABOUT_GONE, COMPOSE_WHERE } = await import('@shared/extensions/app-send-core');

const inGroup = { chat: GROUP };
const entry = { id: ITEM, chat: GROUP, name: 'card[17].vote.json', type: 'json' };
beforeEach(() => {
  rpcs.length = 0;
  toldSessions.length = 0;
  scopes.length = 0;
  remoteSent.length = 0;
  remoteFailure = null;
  rpcError = null;
  granted.clear();
  granted.add('chat:relay');
});

describe('gugu.send: a whisper to a member of the chat the call names, in the person\'s name, from this App (F16, F79)', () => {
  it('{ chat }: written as the person, to the agent, as a whisper, via this App', async () => {
    const sent = await sendFromApp('dinner-vote', { to: `user:${AGENT}`, text: '  card 17 marked doubtful  ', ...inGroup });
    expect(sent.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rpcs).toEqual([{
      name: 'send_message_idempotent',
      args: expect.objectContaining({
        p_message_id: sent.id, p_chat_id: GROUP, p_sender_user_id: OWNER, p_to_user_ids: [AGENT],
        p_content: 'card 17 marked doubtful', p_is_whisper: true, p_via_app: 'dinner-vote',
      }),
    }]);
    expect(toldSessions).toEqual([]);
  });

  it('{ refs }: the files name the chat; each goes under the text as a pill the agent can open (App 引用 pill)', async () => {
    await sendFromApp('dinner-vote', { to: `user:${AGENT}`, text: 'marked doubtful', refs: [{ file: entry }] });
    // The file as it is now: its name (brackets escaped, the label stays one pill) and its version.
    expect(rpcs[0]!.args).toMatchObject({ p_chat_id: GROUP, p_content: `marked doubtful\n\n@[card\\[17\\].vote.json](gugu-file://${ITEM}?v=7)` });
    // A program's handed file is `{ id }`: the same file, the same chat.
    await sendFromApp('dinner-vote', { to: `user:${AGENT}`, text: 'your move', refs: [{ file: { id: ITEM } }] });
    expect(rpcs[1]!.args).toMatchObject({ p_chat_id: GROUP, p_is_whisper: true });
    // Where in it, said by the App: the version picked on (the ref's, else the entry's), the place, the words — text may go.
    // The file's name is the folder's, never one the entry handed over (155 10-15: a deck called 工资表.xlsx).
    await sendFromApp('dinner-vote', {
      to: `user:${AGENT}`,
      text: ' ',
      refs: [{ file: { ...entry, displayName: '工资表.xlsx', version: 6 }, at: { row: 3 }, label: ' Row 3 ' }, { file: { id: ITEM }, at: { row: 4, col: 'B' }, version: 5 }],
    });
    expect(rpcs[2]!.args.p_content).toBe(`@[card\\[17\\].vote.json · Row 3](gugu-file://${ITEM}?v=6#row=3) @[card\\[17\\].vote.json](gugu-file://${ITEM}?v=5#row=4&col=B)`);
  });

  it('refused before anything is written, said how: no place or two, about, a ref whose chat is not the file\'s, a session file, a bare id, a bad ref, two chats, a bad to, empty text', async () => {
    const said = (args: Record<string, unknown>) => sendFromApp('dinner-vote', { to: `user:${AGENT}`, text: 'x', ...args });
    await expect(said({})).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('Say where') });
    await expect(said({ ...inGroup, refs: [{ file: entry }] })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('Say where') });
    // `about` is gone (owner 10-14, no second way kept): said so, whatever else the call names.
    await expect(said({ about: entry })).rejects.toMatchObject({ code: 'invalid', message: ABOUT_GONE });
    await expect(said({ ...inGroup, about: entry })).rejects.toMatchObject({ code: 'invalid', message: ABOUT_GONE });
    await expect(said({ refs: [{ file: { ...entry, chat: OTHER_GROUP } }] })).rejects.toMatchObject({
      code: 'invalid',
      message: `File ${ITEM} is in chat ${GROUP}, not ${OTHER_GROUP}: pass the entry or ctx.file as it is`,
    });
    await expect(said({ refs: [{ file: { session: 'task-1', id: 'TODO.md' } }] })).rejects.toMatchObject({ code: 'invalid', message: 'refs[0].file is a chat file: pass its entry or ctx.file' });
    for (const refs of [[{ file: ITEM }], [], ITEM, [{ file: entry, at: 3 }], [{ file: entry, at: '' }], [{ file: entry, at: 'row=3' }], [{ file: entry, at: {} }], [{ file: entry, at: { row: {} } }], [{ file: entry, at: { '': '1' } }], [{ file: entry, at: ['row'] }], [{ file: entry, label: 7 }], [{ file: entry, version: 0 }], [{ file: entry, version: 2.5 }]]) {
      await expect(said({ refs }), JSON.stringify(refs)).rejects.toMatchObject({ code: 'invalid' });
    }
    await expect(said({ refs: Array.from({ length: 21 }, () => ({ file: entry })) })).rejects.toMatchObject({ code: 'invalid', message: 'At most 20 refs in one call' });
    await expect(said({ refs: [{ file: entry }, { file: { id: ITEM_ELSEWHERE } }] })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('2 chats') });
    await expect(said({ refs: [{ file: { id: ELSEWHERE } }] })).rejects.toMatchObject({ code: 'not-found' });
    await expect(said({ refs: [{ file: { id: FOLDER } }] })).rejects.toMatchObject({ code: 'invalid', message: '合同 is a folder: a pill points at a file' });
    // A version the file has not reached (it is at 7): refused, not written into the link (155 10-15).
    await expect(said({ refs: [{ file: entry, version: 8 }] })).rejects.toMatchObject({ code: 'invalid', message: `File ${ITEM} is at version 7: a place cannot be picked on version 8` });
    await expect(said({ refs: [{ file: { ...entry, version: 99 } }] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(said({ chat: 'g-1' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(sendFromApp('dinner-vote', { to: AGENT, text: 'hi', ...inGroup })).rejects.toMatchObject({ code: 'invalid' });
    await expect(sendFromApp('dinner-vote', { to: `user:${AGENT}`, text: '   ', ...inGroup })).rejects.toMatchObject({ code: 'invalid' });
    expect(rpcs).toEqual([]);
  });

  // 摩擦单 F78(S22):移出群的 agent 是 not-found(App 把它从关注者里清掉),不是 denied。谁收得到由库判(gugu-supabase #84 的
  // 悄悄话规则,check_violation):App 这边不再先查一遍成员,库的报错照原样映射。
  it('F78: whoever the database refuses is not-found, in the database\'s words', async () => {
    const LEFT = '88888888-8888-4888-8888-888888888888';
    const refusal = `A whisper goes to a member of this chat: ${LEFT} is not a member of ${GROUP}`;
    rpcError = { code: '23514', message: refusal };
    await expect(sendFromApp('dinner-vote', { to: `user:${LEFT}`, text: 'your move', ...inGroup })).rejects.toMatchObject({ code: 'not-found', message: refusal });
  });

  // 摩擦单 F79(统筹 07:49):只能发给 agent 没有站得住的理由 —— 「报满了告诉我」要告诉的是人。群里的人一样收得到,
  // 仍是悄悄话、标明来自这个 App(收件人一侧的「由 X App 代 A 发送」随 #6840);对照组(父提交):发给人被 denied。
  it('F79: a person of the chat is told, as a whisper in the person\'s name, marked as from this App', async () => {
    await sendFromApp('dinner-vote', { to: `user:${PERSON}`, text: 'The dinner vote is full', refs: [{ file: entry }] });
    expect(rpcs[0]).toMatchObject({
      name: 'send_message_idempotent',
      args: { p_chat_id: GROUP, p_sender_user_id: OWNER, p_to_user_ids: [PERSON], p_is_whisper: true, p_via_app: 'dinner-vote' },
    });
  });

  it('the server\'s limit comes back as rate-limited', async () => {
    rpcError = { code: 'PT429', message: 'rate-limited: at most 30 messages a minute from one App in one person\'s name' };
    await expect(sendFromApp('dinner-vote', { to: `user:${AGENT}`, text: 'again', ...inGroup })).rejects.toMatchObject({ code: 'rate-limited' });
  });
});

// 对照组(父提交 a770f2e40d):这件事是 `gugu.send` 在「不在 chat 里、也没指文件」时的第二条路,由页面在哪决定。
describe('gugu.messageAgent: one of the person\'s own agents here, told directly (10-01)', () => {
  it('an agent it started: told session-direct in this App\'s envelope; nothing written to a chat', async () => {
    expect(await messageAgentFromApp('notes', { agentId: `user:${AGENT}`, text: '  run the tests ' })).toEqual({ id: 'msg-1' });
    expect(scopes).toEqual(['own']);
    expect(toldSessions).toEqual([{ sessionId: 'conv-agent', text: 'run the tests', envelope: expect.any(String) }]);
    // From this App, by its installed name: the App envelope, which has no way back but the person reading.
    expect(toldSessions[0]!.envelope).toMatch(/^<gugu_delivery route="extension" from="App notes" from_id="extension:notes" msg="msg:m-env"/);
    expect(toldSessions[0]!.envelope).toContain('run the tests');
    expect(rpcs).toEqual([]);
    // Told by an agent that works the page (owner 10-14): from its session, which the session layer will not let tell itself.
    await messageAgentFromApp('notes', { agentId: `user:${AGENT}`, text: 'y' }, { from: 'conv-worker' });
    expect(toldSessions[1]).toMatchObject({ sessionId: 'conv-agent', text: 'y', from: 'conv-worker' });
  });

  it('the narrow tier reaches the agents it started; :all every one here — wherever the page is', async () => {
    await expect(messageAgentFromApp('keeper', { agentId: `user:${ELSEWHERE}`, text: 'keep warm' })).rejects.toMatchObject({ code: 'not-found' });
    granted.add('agents:control:all');
    expect(await messageAgentFromApp('keeper', { agentId: `user:${ELSEWHERE}`, text: 'keep warm' })).toEqual({ id: 'msg-1' });
    expect(scopes).toEqual(['own', 'all']);
    expect(toldSessions.map((told) => told.sessionId)).toEqual(['conv-elsewhere']);
  });

  it('counter-cells: a session id or a stranger is not-found; an empty text is invalid — nothing is told', async () => {
    await expect(messageAgentFromApp('notes', { agentId: 'conv-agent', text: 'x' })).rejects.toMatchObject({ code: 'not-found' });
    await expect(messageAgentFromApp('notes', { agentId: `user:${PERSON}`, text: 'x' })).rejects.toMatchObject({ code: 'not-found' });
    await expect(messageAgentFromApp('notes', { agentId: `user:${AGENT}`, text: '  ' })).rejects.toMatchObject({ code: 'invalid' });
    expect(toldSessions).toEqual([]);
    expect(rpcs).toEqual([]);
  });

  // PR-5b:`:all` 是「这台电脑」—— 别的电脑上的 agent 照旧 not-found,远端腿一次都不问;`:all-machines` 才交给那台机器。
  it(':all never reaches another computer; :all-machines hands it to the machine it is on, as this App, by its session there', async () => {
    granted.add('agents:control:all');
    await expect(messageAgentFromApp('keeper', { agentId: `user:${REMOTE}`, text: 'keep warm' })).rejects.toMatchObject({ code: 'not-found' });
    expect(remoteSent).toEqual([]);

    granted.add('agents:control:all-machines');
    // That machine does the whole send (送法、同键用它那一份):这里只交话和送法。
    expect(await messageAgentFromApp('keeper', { agentId: `user:${REMOTE}`, text: 'keep warm', queue: true, key: 'k1' })).toEqual({ id: 'msg-remote' });
    expect(remoteSent).toEqual([{
      app: { extensionId: 'keeper', extensionName: 'App keeper' }, deviceId: 'd1', sessionId: 'conv-remote', text: 'keep warm', how: { delivery: 'queue', key: 'k1' },
    }]);
    // 复核 136:有一台机器没读到时说不准它在不在,是 failed(❌ not-found 让 App 把它删掉);原话里点名没读到的那台。
    elsewhereUnreached = [{ deviceId: 'd2', label: 'Old Mac', detail: 'offline' }];
    await expect(messageAgentFromApp('keeper', { agentId: 'user:99999999-9999-4999-8999-999999999999', text: 'x' })).rejects.toMatchObject({
      code: 'failed',
      message: expect.stringContaining('(not read: Old Mac)'),
    });
    elsewhereUnreached = [];
    // Not on any computer's list, every computer read: not-found, nobody asked to tell it.
    await expect(messageAgentFromApp('keeper', { agentId: 'user:99999999-9999-4999-8999-999999999999', text: 'x' })).rejects.toMatchObject({ code: 'not-found' });
    expect(remoteSent).toHaveLength(1);
    // An agent here is still told here.
    expect(await messageAgentFromApp('keeper', { agentId: `user:${ELSEWHERE}`, text: 'x' })).toEqual({ id: 'msg-1' });
    expect(remoteSent).toHaveLength(1);

    // The other machine's refusal comes back in its words.
    remoteFailure = new Error('on "ThinkPad" (device:d1): session:conv-remote is a terminal session: delivery "queue" is not supported there');
    await expect(messageAgentFromApp('keeper', { agentId: `user:${REMOTE}`, text: 'x' })).rejects.toMatchObject({
      code: 'failed',
      message: `on "ThinkPad" (device:d1): user:${REMOTE} is a terminal session: delivery "queue" is not supported there`,
    });
    expect(remoteSent).toHaveLength(1);
    // 复核 136:那台机器报的码照原样到 App —— 会话在那边被归档了是 not-found(App 据此删掉它),与本机同一个码;不认得的码是 failed。
    for (const code of ['not-found', 'invalid'] as const) {
      remoteFailure = Object.assign(new Error(`on "ThinkPad" (device:d1): session:conv-remote is gone`), { code });
      await expect(messageAgentFromApp('keeper', { agentId: `user:${REMOTE}`, text: 'x' })).rejects.toMatchObject({
        code,
        message: `on "ThinkPad" (device:d1): user:${REMOTE} is gone`,
      });
    }
    remoteFailure = Object.assign(new Error('no answer'), { code: 'SESSION_DEVICE_NO_ANSWER' });
    await expect(messageAgentFromApp('keeper', { agentId: `user:${REMOTE}`, text: 'x' })).rejects.toMatchObject({ code: 'failed' });
    remoteFailure = null;
  });

  it('a session that could not be told: the reason comes back naming the agent as the App did, never its session (F35)', async () => {
    await expect(messageAgentFromApp('notes', { agentId: `user:${AGENT}`, text: 'cold' })).rejects.toMatchObject({
      code: 'failed',
      message: `[SESSION_DIRECT_NOT_LIVE] target session could not be woken (no channel): user:${AGENT}`,
    });
  });
});

describe('gugu.compose: the composer the call names, and what goes in — nothing sent, nothing asked', () => {
  it('a chat it names, or the chat of the files its refs point at (pills beside the text); a session on this computer', async () => {
    granted.clear(); // no capability at all
    // Ending on a line of its own: what the person adds (an @) goes under it.
    expect(await composeTarget({ text: '  > line 3\n> line 4  ', chat: GROUP })).toEqual({ chatId: GROUP, text: '> line 3\n> line 4\n' });
    // The pills are the composer's to hold, beside the text: their words and their links, not text yet.
    expect(await composeTarget({ text: '> picked', refs: [{ file: entry, at: { row: 3 }, label: 'Row 3' }] })).toEqual({
      chatId: GROUP,
      text: '> picked\n',
      refs: [{ label: 'card[17].vote.json · Row 3', link: `gugu-file://${ITEM}?v=7#row=3` }],
    });
    // Pills alone: nothing to say is fine. A long label ends in an ellipsis at 60 characters; the link is whole.
    const long = await composeTarget({ text: '', refs: [{ file: entry, label: '这'.repeat(80) }] });
    expect(long).toMatchObject({ chatId: GROUP, text: '', refs: [{ link: `gugu-file://${ITEM}?v=7` }] });
    const label = (long as { refs: { label: string }[] }).refs[0]!.label;
    expect([...label]).toHaveLength(60);
    expect(label.startsWith('card[17].vote.json · 这')).toBe(true);
    expect(label.endsWith('…')).toBe(true);
    // A line break in the words would end the pill where it stands (复核 51e9c2fa 要改 1): one line, spaces folded.
    const broken = await composeTarget({ text: '', refs: [{ file: entry, label: '一\n\n# 标题\n[点我](https://evil.example)  ' }] });
    expect((broken as { refs: { label: string }[] }).refs[0]!.label).toBe('card[17].vote.json · 一 # 标题 [点我](https://evil.example)');
    // Cut between characters as a person sees them: a family emoji or a flag across the cut stays whole, or goes whole.
    for (const unit of ['👨‍👩‍👧‍👦', '🇨🇳']) {
      const cut = await composeTarget({ text: '', refs: [{ file: entry, label: unit.repeat(50) }] });
      const words = (cut as { refs: { label: string }[] }).refs[0]!.label;
      const kept = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(words.slice(0, -1))].map((s) => s.segment);
      expect(kept.at(-1), unit).toBe(unit);
      expect(words.endsWith('…')).toBe(true);
    }
    expect(await composeTarget({ text: 'x', session: 'task-1' })).toEqual({ session: { id: 'task-1', projectId: 'p-1' }, text: 'x\n' });
    // Nothing went out.
    expect(rpcs).toEqual([]);
    expect(toldSessions).toEqual([]);
  });

  it('refused, said how: no place or two, about, an empty text, a chat the person is not in, a session not here', async () => {
    await expect(composeTarget({ text: 'x' })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('Say where') });
    await expect(composeTarget({ text: 'x', chat: GROUP, session: 'task-1' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(composeTarget({ text: 'x', chat: GROUP, refs: [{ file: entry }] })).rejects.toMatchObject({ code: 'invalid', message: COMPOSE_WHERE });
    await expect(composeTarget({ text: 'x', session: 'task-1', refs: [{ file: entry }] })).rejects.toMatchObject({ code: 'invalid', message: COMPOSE_WHERE });
    await expect(composeTarget({ text: 'x', about: entry })).rejects.toMatchObject({ code: 'invalid', message: ABOUT_GONE });
    await expect(composeTarget({ text: 'x', session: 'task-1', about: entry })).rejects.toMatchObject({ code: 'invalid', message: ABOUT_GONE });
    await expect(composeTarget({ text: '   ', chat: GROUP })).rejects.toMatchObject({ code: 'invalid' });
    await expect(composeTarget({ text: 'x', chat: OTHER_GROUP })).rejects.toMatchObject({ code: 'not-found' });
    await expect(composeTarget({ text: 'x', session: 'task-9' })).rejects.toMatchObject({ code: 'not-found' });
  });
});
