import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `gugu.dispatch`(15)在桌面:群成员 —— 以人的名义在调用点名的那个 chat 里发悄悄话(摩擦单 F16,和 message_send 同一个动作);
 * 这个人自己的 agent —— 和 `session_message` 同一条投递(本机,或 :all-machines 交给那台机器);新 agent;只放进输入框的草稿。
 * 页面在哪都不参与(真源原则 13);要什么能力在桥的门口按动词那一行查(app-dispatch.test.ts)。
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
const spawned: Array<Record<string, unknown>> = [];
vi.mock('@main/core/extensions/extension-agents', () => ({
  spawnAgentForExtension: async (options: Record<string, unknown>) => (spawned.push(options), { agentId: 'user:aaaaaaaa-0000-4000-8000-000000000001' }),
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
  agentSessionContext: async (sessionId: string) => (sessionId === 'conv-agent' ? { sessionId, projectId: 'p-1', workspaceRoot: null } : null),
}));
const { dispatchForApp } = await import('./extension-send');

const entry = { id: ITEM, chat: GROUP, name: 'card[17].vote.json', type: 'json' };
const here = { chat: null, current: null };
const drafts: unknown[] = [];
const sessionDrafts: Array<{ session: { id: string; projectId: string }; text: string }> = [];
let picked: unknown = null;
const effects = (from?: string) => ({
  pick: async () => picked as never,
  draftInChat: async (detail: unknown) => void drafts.push(detail),
  draftInSession: async (session: { id: string; projectId: string }, text: string) => void sessionDrafts.push({ session, text }),
  ...(from ? { from } : {}),
});
/** To a member of a chat (the old `send`): the chat named, as every member target names it. */
const send = (app: string, { to, chat = GROUP, ...rest }: Record<string, unknown>) =>
  dispatchForApp(app, { ...rest, to: { chat, member: to } }, here, effects());
/** To one of the person's agents by its id (the old `messageAgent`). */
const tell = (app: string, agent: string, text: string, rest: Record<string, unknown> = {}, from?: string) =>
  dispatchForApp(app, { text, to: { agent }, ...rest }, here, effects(from));
/** Only into a composer (the old `compose`). */
const draft = (args: Record<string, unknown>) => dispatchForApp('notes', { draft: true, ...args }, here, effects());
beforeEach(() => {
  rpcs.length = 0;
  toldSessions.length = 0;
  scopes.length = 0;
  remoteSent.length = 0;
  spawned.length = 0;
  drafts.length = 0;
  sessionDrafts.length = 0;
  picked = null;
  remoteFailure = null;
  rpcError = null;
  granted.clear();
  granted.add('chat:relay');
});

describe('to a member of a chat: a whisper in the person\'s name, from this App (F16, F79)', () => {
  it('{ chat, member }: written as the person, to the agent, as a whisper, via this App', async () => {
    const sent = await send('dinner-vote', { to: `user:${AGENT}`, text: '  card 17 marked doubtful  ' });
    expect(sent).toMatchObject({ to: { chat: GROUP, member: `user:${AGENT}` }, id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(rpcs).toEqual([{
      name: 'send_message_idempotent',
      args: expect.objectContaining({
        p_chat_id: GROUP, p_sender_user_id: OWNER, p_to_user_ids: [AGENT],
        p_content: 'card 17 marked doubtful', p_is_whisper: true, p_via_app: 'dinner-vote',
      }),
    }]);
    expect(toldSessions).toEqual([]);
  });

  it('refs: each goes under the text as a pill the agent can open (App 引用 pill)', async () => {
    await send('dinner-vote', { to: `user:${AGENT}`, text: 'marked doubtful', refs: [{ file: entry }] });
    // The file as it is now: its name (brackets escaped, the label stays one pill) and its version.
    expect(rpcs[0]!.args).toMatchObject({ p_chat_id: GROUP, p_content: `marked doubtful\n\n@[card\\[17\\].vote.json](gugu-file://${ITEM}?v=7)` });
    // A program's handed file is `{ id }`: the same file, the same chat.
    await send('dinner-vote', { to: `user:${AGENT}`, text: 'your move', refs: [{ file: { id: ITEM } }] });
    expect(rpcs[1]!.args).toMatchObject({ p_chat_id: GROUP, p_is_whisper: true });
    // Where in it, said by the App: the version picked on (the ref's, else the entry's), the place, the words — text may go.
    // The file's name is the folder's, never one the entry handed over (155 10-15: a deck called 工资表.xlsx).
    await send('dinner-vote', {
      to: `user:${AGENT}`,
      text: ' ',
      refs: [{ file: { ...entry, displayName: '工资表.xlsx', version: 6 }, at: { row: 3 }, label: ' Row 3 ' }, { file: { id: ITEM }, at: { row: 4, col: 'B' }, version: 5 }],
    });
    expect(rpcs[2]!.args.p_content).toBe(`@[card\\[17\\].vote.json · Row 3](gugu-file://${ITEM}?v=6#row=3) @[card\\[17\\].vote.json](gugu-file://${ITEM}?v=5#row=4&col=B)`);
  });

  it('refused before anything is written, said how: refs into another chat than named, about, a ref whose chat is not the file\'s, a session file, a bad ref, two chats, a bad member, empty text', async () => {
    const said = (args: Record<string, unknown>) => send('dinner-vote', { to: `user:${AGENT}`, text: 'x', ...args });
    await expect(said({ chat: OTHER_GROUP, refs: [{ file: entry }] })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining(`not ${OTHER_GROUP}`) });
    // `about` is gone (owner 10-14, no second way kept): said so, whatever else the call names.
    await expect(said({ about: entry })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('about is gone') });
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
    await expect(send('dinner-vote', { to: AGENT, text: 'hi' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(send('dinner-vote', { to: `user:${AGENT}`, text: '   ' })).rejects.toMatchObject({ code: 'invalid' });
    expect(rpcs).toEqual([]);
  });

  // 摩擦单 F78(S22):移出群的 agent 是 not-found(App 把它从关注者里清掉),不是 denied。谁收得到由库判(gugu-supabase #84 的
  // 悄悄话规则,check_violation):App 这边不再先查一遍成员,库的报错照原样映射。
  it('F78: whoever the database refuses is not-found, in the database\'s words', async () => {
    const LEFT = '88888888-8888-4888-8888-888888888888';
    const refusal = `A whisper goes to a member of this chat: ${LEFT} is not a member of ${GROUP}`;
    rpcError = { code: '23514', message: refusal };
    await expect(send('dinner-vote', { to: `user:${LEFT}`, text: 'your move' })).rejects.toMatchObject({ code: 'not-found', message: refusal });
  });

  // 摩擦单 F79(统筹 07:49):群里的人一样收得到,仍是悄悄话、标明来自这个 App。
  it('F79: a person of the chat is told, as a whisper in the person\'s name, marked as from this App', async () => {
    await send('dinner-vote', { to: `user:${PERSON}`, text: 'The dinner vote is full', refs: [{ file: entry }] });
    expect(rpcs[0]).toMatchObject({
      name: 'send_message_idempotent',
      args: { p_chat_id: GROUP, p_sender_user_id: OWNER, p_to_user_ids: [PERSON], p_is_whisper: true, p_via_app: 'dinner-vote' },
    });
  });

  it('the server\'s limit comes back as rate-limited', async () => {
    rpcError = { code: 'PT429', message: 'rate-limited: at most 30 messages a minute from one App in one person\'s name' };
    await expect(send('dinner-vote', { to: `user:${AGENT}`, text: 'again' })).rejects.toMatchObject({ code: 'rate-limited' });
  });
});

describe('to one of the person\'s agents: told directly, as session_message tells it (10-01)', () => {
  it('an agent it started: told session-direct in this App\'s envelope; nothing written to a chat', async () => {
    expect(await tell('notes', `user:${AGENT}`, '  run the tests ')).toEqual({ to: { agent: `user:${AGENT}` }, id: 'msg-1' });
    expect(scopes).toEqual(['own']);
    expect(toldSessions).toEqual([{ sessionId: 'conv-agent', text: 'run the tests', envelope: expect.any(String) }]);
    // From this App, by its installed name: the App envelope, which has no way back but the person reading.
    expect(toldSessions[0]!.envelope).toMatch(/^<gugu_delivery route="extension" from="App notes" from_id="extension:notes" msg="msg:m-env"/);
    expect(toldSessions[0]!.envelope).toContain('run the tests');
    expect(rpcs).toEqual([]);
    // Told by an agent that works the page (owner 10-14): from its session, which the session layer will not let tell itself.
    await tell('notes', `user:${AGENT}`, 'y', {}, 'conv-worker');
    expect(toldSessions[1]).toMatchObject({ sessionId: 'conv-agent', text: 'y', from: 'conv-worker' });
  });

  it('refs go with it as pills under the text, as in a chat', async () => {
    await tell('notes', `user:${AGENT}`, 'look', { refs: [{ file: entry }] });
    expect(toldSessions[0]!.text).toBe(`look\n\n@[card\\[17\\].vote.json](gugu-file://${ITEM}?v=7)`);
  });

  it('the narrow tier reaches the agents it started; :all every one here — wherever the page is', async () => {
    await expect(tell('keeper', `user:${ELSEWHERE}`, 'keep warm')).rejects.toMatchObject({ code: 'not-found' });
    granted.add('agents:control:all');
    expect(await tell('keeper', `user:${ELSEWHERE}`, 'keep warm')).toEqual({ to: { agent: `user:${ELSEWHERE}` }, id: 'msg-1' });
    expect(scopes).toEqual(['own', 'all']);
    expect(toldSessions.map((told) => told.sessionId)).toEqual(['conv-elsewhere']);
  });

  it('picked by the person in the sheet: one of this computer\'s tasks, theirs to tell whatever the App\'s own reach', async () => {
    picked = { to: { session: 'conv-elsewhere' }, visible: false, text: 'please look' };
    expect(await dispatchForApp('keeper', { text: 'look' }, here, effects())).toEqual({ to: { agent: `user:${ELSEWHERE}` }, id: 'msg-1' });
    expect(toldSessions).toEqual([{ sessionId: 'conv-elsewhere', text: 'please look', envelope: expect.any(String) }]);
  });

  it('counter-cells: a session id or a stranger is not-found; an empty text is invalid — nothing is told', async () => {
    await expect(tell('notes', 'conv-agent', 'x')).rejects.toMatchObject({ code: 'invalid' });
    await expect(tell('notes', `user:${PERSON}`, 'x')).rejects.toMatchObject({ code: 'not-found' });
    await expect(tell('notes', `user:${AGENT}`, '  ')).rejects.toMatchObject({ code: 'invalid' });
    expect(toldSessions).toEqual([]);
    expect(rpcs).toEqual([]);
  });

  // PR-5b:`:all` 是「这台电脑」—— 别的电脑上的 agent 照旧 not-found,远端腿一次都不问;`:all-machines` 才交给那台机器。
  it(':all never reaches another computer; :all-machines hands it to the machine it is on, as this App, by its session there', async () => {
    granted.add('agents:control:all');
    await expect(tell('keeper', `user:${REMOTE}`, 'keep warm')).rejects.toMatchObject({ code: 'not-found' });
    expect(remoteSent).toEqual([]);

    granted.add('agents:control:all-machines');
    // That machine does the whole send (送法、同键用它那一份):这里只交话和送法。
    expect(await tell('keeper', `user:${REMOTE}`, 'keep warm', { delivery: 'queue', key: 'k1' })).toEqual({ to: { agent: `user:${REMOTE}` }, id: 'msg-remote' });
    expect(remoteSent).toEqual([{
      app: { extensionId: 'keeper', extensionName: 'App keeper' }, deviceId: 'd1', sessionId: 'conv-remote', text: 'keep warm', how: { delivery: 'queue', key: 'k1' },
    }]);
    // 复核 136:有一台机器没读到时说不准它在不在,是 failed(❌ not-found 让 App 把它删掉);原话里点名没读到的那台。
    elsewhereUnreached = [{ deviceId: 'd2', label: 'Old Mac', detail: 'offline' }];
    await expect(tell('keeper', 'user:99999999-9999-4999-8999-999999999999', 'x')).rejects.toMatchObject({
      code: 'failed',
      message: expect.stringContaining('(not read: Old Mac)'),
    });
    elsewhereUnreached = [];
    // Not on any computer's list, every computer read: not-found, nobody asked to tell it.
    await expect(tell('keeper', 'user:99999999-9999-4999-8999-999999999999', 'x')).rejects.toMatchObject({ code: 'not-found' });
    expect(remoteSent).toHaveLength(1);
    // An agent here is still told here.
    expect(await tell('keeper', `user:${ELSEWHERE}`, 'x')).toEqual({ to: { agent: `user:${ELSEWHERE}` }, id: 'msg-1' });
    expect(remoteSent).toHaveLength(1);

    // The other machine's refusal comes back in its words.
    remoteFailure = new Error('on "ThinkPad" (device:d1): session:conv-remote is a terminal session: delivery "queue" is not supported there');
    await expect(tell('keeper', `user:${REMOTE}`, 'x')).rejects.toMatchObject({
      code: 'failed',
      message: `on "ThinkPad" (device:d1): user:${REMOTE} is a terminal session: delivery "queue" is not supported there`,
    });
    expect(remoteSent).toHaveLength(1);
    // 复核 136:那台机器报的码照原样到 App —— 会话在那边被归档了是 not-found(App 据此删掉它),与本机同一个码;不认得的码是 failed。
    for (const code of ['not-found', 'invalid'] as const) {
      remoteFailure = Object.assign(new Error(`on "ThinkPad" (device:d1): session:conv-remote is gone`), { code });
      await expect(tell('keeper', `user:${REMOTE}`, 'x')).rejects.toMatchObject({
        code,
        message: `on "ThinkPad" (device:d1): user:${REMOTE} is gone`,
      });
    }
    remoteFailure = Object.assign(new Error('no answer'), { code: 'SESSION_DEVICE_NO_ANSWER' });
    await expect(tell('keeper', `user:${REMOTE}`, 'x')).rejects.toMatchObject({ code: 'failed' });
    remoteFailure = null;
  });

  it('a session that could not be told: the reason comes back naming the agent as the App did, never its session (F35)', async () => {
    await expect(tell('notes', `user:${AGENT}`, 'cold')).rejects.toMatchObject({
      code: 'failed',
      message: `[SESSION_DIRECT_NOT_LIVE] target session could not be woken (no channel): user:${AGENT}`,
    });
  });
});

describe('to a new agent: started as this App, answered by its agent', () => {
  it('the text is its first words (pills under it), spawn its session_spawn words, from the agent working the page', async () => {
    granted.add('agents:control');
    const started = await dispatchForApp('kanban', { text: 'do card 7', to: { new: true }, refs: [{ file: entry }], spawn: { title: 'Card 7', transport: 'acp', model: 3 } }, here, effects('conv-worker'));
    expect(started).toEqual({ to: { agent: 'user:aaaaaaaa-0000-4000-8000-000000000001' } });
    expect(spawned).toEqual([{
      extensionId: 'kanban', extensionName: 'App kanban', bySession: 'conv-worker',
      prompt: `do card 7\n\n@[card\\[17\\].vote.json](gugu-file://${ITEM}?v=7)`, title: 'Card 7', transport: 'acp',
    }]);
    await expect(dispatchForApp('kanban', { text: 'x', to: { new: true }, spawn: { transport: 'tty' } }, here, effects())).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('a draft: only into a composer — nothing sent, nothing asked', () => {
  it('a chat it names, or the chat of the files its refs point at (pills beside the text); an agent\'s session on this computer', async () => {
    granted.clear(); // no capability at all
    // Ending on a line of its own: what the person adds (an @) goes under it.
    expect(await draft({ text: '  > line 3\n> line 4  ', to: { chat: GROUP } })).toEqual({ to: { chat: GROUP } });
    expect(drafts.at(-1)).toEqual({ chatId: GROUP, text: '> line 3\n> line 4\n' });
    // The pills are the composer's to hold, beside the text: their words and their links, not text yet.
    await draft({ text: '> picked', refs: [{ file: entry, at: { row: 3 }, label: 'Row 3' }] });
    expect(drafts.at(-1)).toEqual({ chatId: GROUP, text: '> picked\n', refs: [{ label: 'card[17].vote.json · Row 3', link: `gugu-file://${ITEM}?v=7#row=3` }] });
    // Pills alone: nothing to say is fine. A long label ends in an ellipsis at 60 characters; the link is whole.
    await draft({ text: '', refs: [{ file: entry, label: '这'.repeat(80) }] });
    const label = (drafts.at(-1) as { refs: { label: string }[] }).refs[0]!.label;
    expect([...label]).toHaveLength(60);
    expect(label.startsWith('card[17].vote.json · 这')).toBe(true);
    expect(label.endsWith('…')).toBe(true);
    // A line break in the words would end the pill where it stands (复核 51e9c2fa 要改 1): one line, spaces folded.
    await draft({ text: '', refs: [{ file: entry, label: '一\n\n# 标题\n[点我](https://evil.example)  ' }] });
    expect((drafts.at(-1) as { refs: { label: string }[] }).refs[0]!.label).toBe('card[17].vote.json · 一 # 标题 [点我](https://evil.example)');
    // Cut between characters as a person sees them: a family emoji or a flag across the cut stays whole, or goes whole.
    for (const unit of ['👨‍👩‍👧‍👦', '🇨🇳']) {
      await draft({ text: '', refs: [{ file: entry, label: unit.repeat(50) }] });
      const words = (drafts.at(-1) as { refs: { label: string }[] }).refs[0]!.label;
      const kept = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(words.slice(0, -1))].map((s) => s.segment);
      expect(kept.at(-1), unit).toBe(unit);
      expect(words.endsWith('…')).toBe(true);
    }
    // An agent's: its session here, by the agent it is.
    expect(await draft({ text: 'x', to: { agent: `user:${AGENT}` } })).toEqual({ to: { agent: `user:${AGENT}` } });
    expect(sessionDrafts).toEqual([{ session: { id: 'conv-agent', projectId: 'p-1' }, text: 'x\n' }]);
    // Nothing went out.
    expect(rpcs).toEqual([]);
    expect(toldSessions).toEqual([]);
  });

  it('refused, said how: a chat and refs at once, about, an empty text, a chat the person is not in, an agent not here', async () => {
    await expect(draft({ text: 'x', to: { chat: GROUP }, refs: [{ file: entry }] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(draft({ text: 'x', about: entry })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('about is gone') });
    await expect(draft({ text: '   ', to: { chat: GROUP } })).rejects.toMatchObject({ code: 'invalid' });
    await expect(draft({ text: 'x', to: { chat: OTHER_GROUP } })).rejects.toMatchObject({ code: 'not-found' });
    await expect(draft({ text: 'x', to: { agent: `user:${PERSON}` } })).rejects.toMatchObject({ code: 'not-found' });
  });
});
