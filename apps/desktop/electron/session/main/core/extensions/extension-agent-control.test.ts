import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 读对话与操作 agent:范围之外的一律够不着,且「够不着」不泄露存在性。
 *
 * 这两档能力各自带范围,而范围只有一处判定。会悄悄坏掉的方式是:history 或 control
 * 伸得比它自己那档声明的更远——那样「默认最小」在最要紧的两档上就成了装饰。
 * behavior tab-extensions:「agent 的可见与可控」。
 *
 * ⚠️ 这里的 mock 只替换**边界**(库、运行时客户端、宿主控制通道),不替换被测的判断。
 * 上一版把 `messages` 表整片 mock 起来自己塞数据再读出来——那是自证循环:表本身是死的
 * (全仓 `insert(messages)` 零个写入方),用例照绿,产品照空。现在对话内容一律来自
 * ACP 运行时这个真源头,mock 的是那个客户端。
 */

const rows: Array<Record<string, unknown>> = [];
const stopped: string[] = [];
/** 运行时认得的活会话;不在里面 = 会话没打开。 */
const liveSessions = new Set<string>();
/** 活会话的引擎报过的上下文用量(L12);没报过就不在里面。 */
const contextTokensOf = new Map<string, number>();
/** 活会话的引擎报过的账号额度(G3,`resetsAt` 是毫秒);没报过就不在里面。 */
const rateLimitOf = new Map<string, Record<string, unknown>>();
/** 活会话的引擎怎么没的(lifecycle lost);没有就不在里面。 */
const failureOf = new Map<string, Record<string, unknown>>();
/** 活会话近 5 分钟里最后一次调工具的毫秒时刻;没有就不在里面。 */
const lastActionAtOf = new Map<string, number>();
/** 运行时手上的轮次,按 seq 正序。 */
let runtimeTurns: Array<Record<string, unknown>> = [];
let historyCalls: Array<{ sessionId: string; before?: number; limit: number }> = [];
/** 会话自己那家引擎落在盘上的记录(会话页、手机读的那一份),按 seq 正序;不在里面 = 没有自己的记录(替身)。 */
const recordTurns = new Map<string, Array<Record<string, unknown>>>();
/** 读记录时的失败(code 照 session-timeline 的:record_not_found / record_unreadable / timeline_failed)。 */
const recordFailure = new Map<string, { code: string; message: string }>();
let recordCalls: Array<{ conversationId: string; limit: number; beforeSeq?: number }> = [];
/** 任何把会话启起来的调用 —— 读操作一次都不该有。 */
let startedSessions: unknown[] = [];

vi.mock('@main/db/client', () => {
  const chain = (): Record<string, unknown> => {
    const pick = () => rows;
    const self: Record<string, unknown> = {};
    const back = () => self;
    self.from = back;
    self.where = back;
    self.orderBy = back;
    self.limit = () => pick();
    self.then = (resolve: (value: unknown) => unknown) => resolve(pick());
    return self;
  };
  return {
    db: { select: () => ({ from: () => chain() }) },
  };
});

vi.mock('@main/db/schema', () => ({
  sessions: { __name: 'conversations' },
}));
vi.mock('drizzle-orm', () => ({ asc: () => null, desc: () => null, eq: () => null }));
// Each row's model is its session's platform decision (none here) or the harness's own: session-model-fact.
const platformDecisions = new Map<string, { modelId: string }>();
vi.mock('@main/core/sessions/platform-model-selection', () => ({
  sessionPlatformModel: async (id: string) => platformDecisions.get(id),
  // The name kept with the decision (filled once per session and model, platform-model-selection.db.test).
  sessionModelLabel: async (_id: string, decision: { modelId: string } | undefined) => (decision ? 'GLM 5.3 Flash' : null),
}));
vi.mock('@main/lib/logger', () => ({ log: { error: () => {}, warn: () => {}, info: () => {} } }));
vi.mock('@main/core/sessions/getSessions', () => ({
  getSessions: () => Promise.resolve(rows.map((row) => ({ ...row }))),
}));
vi.mock('@main/core/acp/session-summary-reader', () => ({
  readAcpSessionSummaries: () =>
    Promise.resolve(
      Object.fromEntries(
        [...liveSessions].map((id) => [id, {
          sessionId: id,
          contextTokens: contextTokensOf.get(id) ?? null,
          rateLimit: rateLimitOf.get(id) ?? null,
          failure: failureOf.get(id) ?? null,
          lastActionAt: lastActionAtOf.get(id) ?? null,
        }])
      )
    ),
}));
vi.mock('@main/core/projects/utils', () => ({
  resolveSession: () => ({ sessions: { stopSession: () => Promise.resolve() } }),
  resolveWorkspace: () => ({ path: '/tmp/wc' }),
}));
vi.mock('@main/core/sessions/utils', async (importOriginal) => ({
  refuseItself: (await importOriginal<typeof import('@main/core/sessions/utils')>()).refuseItself,
  mapSessionRowToSession: (row: Record<string, unknown>) => ({
    id: row.id,
    providerId: row.provider ?? 'claude',
    model: row.model ?? null,
    effort: null,
    permissionMode: undefined,
  }),
}));
vi.mock('@main/core/acp/controller', () => ({
  getAcpRuntimeClient: () =>
    Promise.resolve({
      stopSession: ({ sessionId }: { sessionId: string }) => {
        stopped.push(sessionId);
        return Promise.resolve({ success: true });
      },
      startSession: (input: unknown) => {
        startedSessions.push(input);
        return Promise.resolve({ success: true, data: { providerSessionId: 's' } });
      },
      resumeSession: (input: unknown) => {
        startedSessions.push(input);
        return Promise.resolve({ success: true, data: { turns: [], nextCursor: null } });
      },
      getHistory: (input: { sessionId: string; before?: number; limit: number }) => {
        historyCalls.push(input);
        // 与真运行时同样的分页语义:按 seq 倒着取一页,再正过来。
        const filtered =
          input.before === undefined
            ? runtimeTurns
            : runtimeTurns.filter((turn) => (turn.seq as number) < input.before!);
        const page = [...filtered]
          .sort((a, b) => (b.seq as number) - (a.seq as number))
          .slice(0, input.limit);
        const nextCursor = page.length === input.limit ? (page.at(-1)!.seq as number) : null;
        return Promise.resolve({ success: true, data: { turns: page.reverse(), nextCursor } });
      },
    }),
}));

/** The roster: a session row's identity is named after it (App id `user:<id>`); `no-identity-*` rows have none yet. */
vi.mock('@main/core/sessionpage/sessionpage-session-agent', () => ({
  agentIdsBySession: async () =>
    new Map(rows.filter((row) => !String(row.id).startsWith('no-identity')).map((row) => [String(row.id), `user:${String(row.id)}`])),
}));

/** 界面那份会话列表:库里的行照列表的投影换(状态、起它的 App、agent 的 id 都在行上)。 */
vi.mock('@main/core/session-timeline/service', () => ({
  // 与 service.ts recordHistoryPage 同样的语义:最新 limit 轮;给了 beforeSeq 就是那一轮之前的 limit 轮。
  recordHistoryPage: async (input: { conversationId: string; limit: number; beforeSeq?: number }) => {
    recordCalls.push(input);
    const failure = recordFailure.get(input.conversationId);
    if (failure) return { ok: false, error: failure };
    const all = recordTurns.get(input.conversationId);
    if (!all) return { ok: true, value: 'no-record' };
    const end = input.beforeSeq === undefined ? all.length : all.findIndex((turn) => turn.seq === input.beforeSeq);
    if (end < 0) return { ok: true, value: 'no-such-turn' };
    const start = Math.max(0, end - input.limit);
    return { ok: true, value: { turns: all.slice(start, end), hasOlder: start > 0 } };
  },
  listSessions: async () => ({
    projects: [],
    sessions: rows.map((row) => ({
      conversationId: String(row.id),
      projectId: row.projectId,
      title: row.title,
      harness: row.provider ?? 'unknown',
      runtime: row.runtime === 'acp' ? 'acp' : 'pty',
      status: row.agentStatus ? { status: row.agentStatus, detail: row.agentStatusDetail ?? null } : null,
      lastInteractedAt: null,
      parentConversationId: row.parentSessionId ?? null,
      spawnedByExtensionId: row.spawnedByExtensionId ?? null,
      agent: String(row.id).startsWith('no-identity') ? null : { userId: String(row.id) },
    })),
  }),
}));
/** 别的机器报来的会话(界面那份列表的行)与没问到的机器。 */
let elsewhere: { sessions: Array<Record<string, unknown>>; unreached: Array<Record<string, unknown>> } = { sessions: [], unreached: [] };
vi.mock('@main/core/sessions/session-family', () => ({
  otherMachines: () => ({ sessions: async () => elsewhere }),
}));

// 告诉一个 agent 一件事不在这里:不在 chat 里的 gugu.send 和 session_message 同一条投递(真源 §4 F16,10-01),见 extension-send。
const {
  heardAgentEvent,
  readAgentHistoryForExtension,
  stopAgentForExtension,
  listAgentsForExtension,
  visibleAgentsForExtension,
} = await import('./extension-agents');

beforeEach(() => {
  elsewhere = { sessions: [], unreached: [] };
  platformDecisions.clear();
  rows.length = 0;
  stopped.length = 0;
  liveSessions.clear();
  runtimeTurns = [];
  historyCalls = [];
  startedSessions = [];
  recordTurns.clear();
  recordFailure.clear();
  recordCalls = [];
  // What a Stop hook said for 'mine' is main's memory: each case starts with none (a new prompt drops it).
  heardAgentEvent({ type: 'start', sessionId: 'mine', projectId: 'p', timestamp: 0, payload: {} } as never);
});

const VISIBLE = new Map([['user:mine', 'mine']]);

/** 一条面板会话,库里在、运行时也开着。 */
function openPanelAgent(id: string): void {
  rows.push({ id, runtime: 'acp', provider: 'claude', projectId: 'p' });
  liveSessions.add(id);
}

function turn(seq: number, texts: Array<[string, string]>, startedAt?: number) {
  return {
    id: `turn-${seq}`,
    seq,
    initiator: 'user',
    ...(startedAt === undefined ? {} : { startedAt }),
    items: texts.map(([role, text], i) => ({
      kind: 'message',
      id: `m${seq}-${i}`,
      seq,
      role,
      text,
    })),
  };
}

describe('范围之外的 agent 一律够不着', () => {
  it('读对话:不可见的直接拒,且根本没问过运行时', async () => {
    // ⚠️ 骨头在这里:这条 agent 库里在、运行时也开着、还有内容。它若被读出来,
    // 只可能是范围检查失效了。少了这三行,用例会因为「查无此会话」而通过——
    // 那是个判不出真假的绿。
    openPanelAgent('someone-elses');
    runtimeTurns = [turn(1, [['user', '密码是…']])];
    recordTurns.set('someone-elses', [turn(1, [['user', '密码是…']])]);
    await expect(
      readAgentHistoryForExtension({ agentId: 'user:someone-elses', visibleAgents: VISIBLE })
    ).rejects.toMatchObject({ code: 'not-found', message: expect.stringMatching(/is visible to this App/) });
    expect(historyCalls).toEqual([]);
    expect(recordCalls).toEqual([]);
  });

  it('停 agent:不可见的直接拒,不发出任何停止指令', async () => {
    rows.push({ id: 'someone-elses', runtime: 'acp', projectId: 'p' });
    await expect(
      stopAgentForExtension({ agentId: 'user:someone-elses', visibleAgents: VISIBLE })
    ).rejects.toMatchObject({ code: 'not-found', message: expect.stringMatching(/is visible to this App/) });
    expect(stopped).toEqual([]);
  });

  // owner 10-14:App 页面由 agent 操作时,停的若是它自己,与 session_stop 同一道检查、同一句话拒掉,什么都不停。
  it('停 agent:操作页面的 agent 停不了自己,停别的照停', async () => {
    openPanelAgent('mine');
    await expect(stopAgentForExtension({ agentId: 'user:mine', visibleAgents: VISIBLE, bySession: 'mine' })).rejects.toThrow('a session cannot stop itself');
    expect(stopped).toEqual([]);
    await stopAgentForExtension({ agentId: 'user:mine', visibleAgents: VISIBLE, bySession: 'other' });
    expect(stopped).toEqual(['mine']);
  });

  it('拒绝的话术不泄露存在性 —— 与「查无此 agent」同一句', async () => {
    const refusals: string[] = [];
    for (const run of [
      () => readAgentHistoryForExtension({ agentId: 'user:x', visibleAgents: VISIBLE }),
      () => stopAgentForExtension({ agentId: 'user:x', visibleAgents: VISIBLE }),
    ]) {
      await run().catch((error: unknown) => refusals.push(String((error as Error).message)));
    }
    expect(refusals).toHaveLength(2);
    // 两句一模一样:说「无权限」等于承认它存在。
    expect(new Set(refusals).size).toBe(1);
  });
});

describe('没有自己记录的开着的面板 agent:读运行时,不是那张死表', () => {
  it('把轮次里说过的话按顺序摊平给出来', async () => {
    openPanelAgent('mine');
    runtimeTurns = [
      turn(1, [['user', '开工']], Date.UTC(2026, 7, 17, 1)),
      turn(2, [['assistant', '好'], ['assistant', '看完了']]),
    ];
    const page = await readAgentHistoryForExtension({ agentId: 'user:mine', visibleAgents: VISIBLE });
    expect(page.messages.map((m) => m.text)).toEqual(['开工', '好', '看完了']);
    expect(page.messages.map((m) => m.turnId)).toEqual(['turn-1', 'turn-2', 'turn-2']);
    expect(page.nextCursor).toBeNull();
  });

  it('思考与工具调用不进这条通道 —— 公开面只给说过的话', async () => {
    openPanelAgent('mine');
    runtimeTurns = [
      {
        id: 'turn-1',
        seq: 1,
        initiator: 'user',
        items: [
          { kind: 'thinking', id: 't1', seq: 1, startedAt: 0, text: '内心戏' },
          { kind: 'message', id: 'm1', seq: 1, role: 'user', text: '干活' },
          { kind: 'tool_call', id: 'c1', seq: 1, title: 'Read', status: 'completed' },
        ],
      },
    ];
    const page = await readAgentHistoryForExtension({ agentId: 'user:mine', visibleAgents: VISIBLE });
    expect(page.messages.map((m) => m.messageId)).toEqual(['m1']);
  });

  it('时间给 ISO,问不出来就是 null —— ❌ 不拿当下时间冒充', async () => {
    openPanelAgent('mine');
    runtimeTurns = [turn(1, [['user', 'a']], Date.UTC(2026, 7, 17, 1)), turn(2, [['user', 'b']])];
    const page = await readAgentHistoryForExtension({ agentId: 'user:mine', visibleAgents: VISIBLE });
    expect(page.messages[0]?.startedAt).toBe('2026-08-17T01:00:00.000Z');
    expect(page.messages[1]?.startedAt).toBeNull();
  });

  it('游标能真的翻到上一页 —— 不是一个到不了的字段', async () => {
    openPanelAgent('mine');
    runtimeTurns = Array.from({ length: 250 }, (_, i) => turn(i + 1, [['user', `第 ${i + 1} 轮`]]));

    const first = await readAgentHistoryForExtension({ agentId: 'user:mine', visibleAgents: VISIBLE });
    expect(first.messages).toHaveLength(100);
    // 一页是最新的那 100 轮(151..250),正序给出。
    expect(first.messages.at(0)?.text).toBe('第 151 轮');
    expect(first.messages.at(-1)?.text).toBe('第 250 轮');
    expect(first.nextCursor).toBe(151);

    const second = await readAgentHistoryForExtension({
      agentId: 'user:mine',
      visibleAgents: VISIBLE,
      before: first.nextCursor!,
    });
    expect(second.messages.at(-1)?.text).toBe('第 150 轮');
    // 游标真的传到了运行时,而不是在半路被吃掉。
    expect(historyCalls.at(-1)?.before).toBe(151);
  });

  it('没打开、也没有读得了的记录:响亮地拒(unavailable),❌ 不回空数组冒充「没说过话」', async () => {
    rows.push({ id: 'mine', runtime: 'acp', projectId: 'p' });
    await expect(
      readAgentHistoryForExtension({ agentId: 'user:mine', visibleAgents: VISIBLE })
    ).rejects.toMatchObject({ code: 'unavailable', message: expect.stringMatching(/not open/) });
    expect(historyCalls).toEqual([]);
  });

  it('读一条冷会话不会顺手把它启起来 —— 读权限不该等于开引擎', async () => {
    rows.push({ id: 'mine', runtime: 'acp', projectId: 'p' });
    await readAgentHistoryForExtension({ agentId: 'user:mine', visibleAgents: VISIBLE }).catch(
      () => {}
    );
    // 一次 startSession/resumeSession 都不该有:那会让只声明 agents:history 的扩展
    // 获得启动引擎进程的能力,而用户装的时候同意的是「读」。
    expect(startedSessions).toEqual([]);
  });

  it('终端 agent,它那家引擎的记录咕咕读不了:unavailable,说清是记录读不了', async () => {
    rows.push({ id: 'mine', runtime: 'pty', provider: 'qwen', projectId: 'p' });
    liveSessions.add('mine');
    await expect(
      readAgentHistoryForExtension({ agentId: 'user:mine', visibleAgents: VISIBLE })
    ).rejects.toMatchObject({ code: 'unavailable', message: expect.stringMatching(/no record gugu reads/) });
    expect(historyCalls).toEqual([]);
  });
});

// #7126 ⑤:会话页和手机读的是 harness 自己落在盘上的记录 —— 终端 agent、没打开的面板 agent 都在那里。
describe('有自己记录的 agent:读它那家引擎的记录,和会话页、手机同一份', () => {
  it('终端 agent 读得到它说过的话 —— 雷达「做完了」能带上最后一句', async () => {
    rows.push({ id: 'mine', runtime: 'pty', provider: 'claude', projectId: 'p' });
    recordTurns.set('mine', [turn(1, [['user', '修一下']]), turn(2, [['assistant', '修好了,三处']])]);
    const page = await readAgentHistoryForExtension({ agentId: 'user:mine', visibleAgents: VISIBLE });
    expect(page.messages.map((m) => [m.sender, m.text])).toEqual([['user', '修一下'], ['assistant', '修好了,三处']]);
    expect(page.nextCursor).toBeNull();
    expect(historyCalls).toEqual([]);
    expect(startedSessions).toEqual([]);
  });

  it('没打开的面板 agent 也读得到,不开引擎 —— 读权限仍然不等于开引擎', async () => {
    rows.push({ id: 'mine', runtime: 'acp', provider: 'claude', projectId: 'p' });
    recordTurns.set('mine', [turn(1, [['assistant', '空闲回收之前说的']])]);
    const page = await readAgentHistoryForExtension({ agentId: 'user:mine', visibleAgents: VISIBLE });
    expect(page.messages.map((m) => m.text)).toEqual(['空闲回收之前说的']);
    expect(startedSessions).toEqual([]);
    expect(historyCalls).toEqual([]);
  });

  it('开着的面板 agent 有记录时也读记录:一个 agent 只有一份对话', async () => {
    openPanelAgent('mine');
    runtimeTurns = [turn(1, [['assistant', '运行时那份']])];
    recordTurns.set('mine', [turn(1, [['assistant', '记录那份']])]);
    const page = await readAgentHistoryForExtension({ agentId: 'user:mine', visibleAgents: VISIBLE });
    expect(page.messages.map((m) => m.text)).toEqual(['记录那份']);
    expect(historyCalls).toEqual([]);
  });

  it('翻页:nextCursor 是这一页最早那一轮的 seq,传回 before 就是更早的一页', async () => {
    rows.push({ id: 'mine', runtime: 'pty', provider: 'codex', projectId: 'p' });
    // Answers, not prompts: a newest page that ends on a prompt waits for its answer (the catch-up cells below).
    recordTurns.set('mine', Array.from({ length: 250 }, (_, i) => turn(i + 1, [['assistant', `第 ${i + 1} 轮`]])));
    const first = await readAgentHistoryForExtension({ agentId: 'user:mine', visibleAgents: VISIBLE });
    expect([first.messages.length, first.messages.at(0)?.text, first.messages.at(-1)?.text, first.nextCursor]).toEqual([100, '第 151 轮', '第 250 轮', 151]);
    const second = await readAgentHistoryForExtension({ agentId: 'user:mine', visibleAgents: VISIBLE, before: first.nextCursor! });
    expect([second.messages.at(0)?.text, second.messages.at(-1)?.text, second.nextCursor]).toEqual(['第 51 轮', '第 150 轮', 51]);
    const third = await readAgentHistoryForExtension({ agentId: 'user:mine', visibleAgents: VISIBLE, before: second.nextCursor! });
    expect([third.messages.length, third.nextCursor]).toEqual([50, null]);
    expect(recordCalls.map((call) => call.beforeSeq)).toEqual([undefined, 151, 51]);
  });

  it('before 不是这条对话里的一轮:invalid —— ❌ 悄悄当成从头读', async () => {
    rows.push({ id: 'mine', runtime: 'pty', provider: 'claude', projectId: 'p' });
    recordTurns.set('mine', [turn(1, [['user', 'a']])]);
    await expect(
      readAgentHistoryForExtension({ agentId: 'user:mine', visibleAgents: VISIBLE, before: 999 })
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('记录在却读不动(本机故障):failed,带出原因 —— ❌ 当成没有记录去问别处', async () => {
    openPanelAgent('mine');
    runtimeTurns = [turn(1, [['assistant', '运行时那份']])];
    recordFailure.set('mine', { code: 'record_unreadable', message: 'EACCES: permission denied' });
    await expect(
      readAgentHistoryForExtension({ agentId: 'user:mine', visibleAgents: VISIBLE })
    ).rejects.toMatchObject({ code: 'failed', message: expect.stringMatching(/EACCES/) });
    expect(historyCalls).toEqual([]);
  });

  // #7126 → 148 10-13 (B): claude in a terminal stops (idle) before its answer reaches its record — Claude Code writes the
  // transcript asynchronously. Its Stop hook hands over the answer (`last_assistant_message`): the newest page, ending on
  // the prompt, gets it as the answer — read once, never waited for.
  const prompt = (seq: number, text: string, startedAt: number) => turn(seq, [['user', text]], startedAt);
  const answer = (seq: number, text: string) => ({ ...turn(seq, [['assistant', text]]), initiator: 'agent' });
  const hook = (type: 'start' | 'stop', at: number, lastAssistantMessage?: string, origin?: 'subagent') =>
    heardAgentEvent({ type, sessionId: 'mine', projectId: 'p', timestamp: at, payload: { ...(lastAssistantMessage ? { lastAssistantMessage } : {}), ...(origin ? { origin } : {}) } } as never);
  const read = (before?: number) => readAgentHistoryForExtension({ agentId: 'user:mine', visibleAgents: VISIBLE, ...(before === undefined ? {} : { before }) });
  const asked = [prompt(0, '第一问', 1_000), answer(1, '上一轮的答'), prompt(2, '第二问', 5_000)];

  it('记录停在提示上、它停下时 hook 给了这一轮的那句:一读就补上,❌ 再读、❌ 等', async () => {
    rows.push({ id: 'mine', runtime: 'pty', provider: 'claude', projectId: 'p' });
    recordTurns.set('mine', asked);
    hook('start', 5_000);
    hook('stop', 9_000, '这一轮的答');
    const page = await read();
    expect(page.messages.map(({ sender, text }) => `${sender}:${text}`)).toEqual(['user:第一问', 'assistant:上一轮的答', 'user:第二问', 'assistant:这一轮的答']);
    expect(page.messages.at(-1)).toMatchObject({ turnId: 'turn-2', seq: 2 });
    expect(recordCalls).toHaveLength(1);
  });

  it('记录追上了:以记录为准,同一句不说第二遍', async () => {
    rows.push({ id: 'mine', runtime: 'pty', provider: 'claude', projectId: 'p' });
    hook('start', 5_000);
    hook('stop', 9_000, '这一轮的答');
    recordTurns.set('mine', [...asked, answer(3, '这一轮的答')]);
    const texts = (await read()).messages.map(({ text }) => text);
    expect(texts.filter((text) => text === '这一轮的答')).toHaveLength(1);
    expect(texts.at(-1)).toBe('这一轮的答');
  });

  it('往前翻的页不补:只有最新一页讲「最后一句」', async () => {
    rows.push({ id: 'mine', runtime: 'pty', provider: 'claude', projectId: 'p' });
    recordTurns.set('mine', [...asked, prompt(3, '第三问', 9_000)]);
    hook('stop', 9_500, '第三问的答');
    expect((await read(3)).messages.at(-1)).toMatchObject({ sender: 'user', text: '第二问' });
  });

  it('只补这一轮的:下一轮开始就作废;停在提示之前的、子代理的、没带话的,都不算', async () => {
    rows.push({ id: 'mine', runtime: 'pty', provider: 'claude', projectId: 'p' });
    recordTurns.set('mine', asked);
    const last = async () => (await read()).messages.at(-1);
    hook('stop', 4_000, '上一轮停下时的话'); // before this prompt began
    expect(await last()).toMatchObject({ sender: 'user', text: '第二问' });
    hook('stop', 9_000, '这一轮的答');
    hook('start', 9_500); // the next prompt started
    expect(await last()).toMatchObject({ sender: 'user', text: '第二问' });
    hook('stop', 9_800, '子代理说的', 'subagent');
    hook('stop', 9_900); // nothing said
    expect(await last()).toMatchObject({ sender: 'user', text: '第二问' });
  });

  // 评审 9a096d48bd:每条事件各自异步 enrich,第 2 轮的 start 可能先处理完、第 1 轮迟到的 Stop 后处理完。戳是 hook 到达
  // hook server 的那一刻,所以那句的戳仍早于第 2 轮的提示 —— 不补成第 2 轮的回答。
  it('第 1 轮的 Stop 晚于第 2 轮的 start 处理完:它的戳(到达那一刻)早于第 2 轮的提示,不补', async () => {
    rows.push({ id: 'mine', runtime: 'pty', provider: 'claude', projectId: 'p' });
    recordTurns.set('mine', asked);
    hook('start', 5_000);
    hook('stop', 4_900, '上一轮的答');
    expect((await read()).messages.at(-1)).toMatchObject({ sender: 'user', text: '第二问' });
  });

  it('提示没有时刻:不补 —— 宁可这一次读不到,❌ 拿别的轮的话冒充', async () => {
    rows.push({ id: 'mine', runtime: 'pty', provider: 'claude', projectId: 'p' });
    recordTurns.set('mine', [prompt(0, '第一问', 1_000), answer(1, '上一轮的答'), turn(2, [['user', '第二问']])]);
    hook('stop', 9_000, '这一轮的答');
    expect((await read()).messages.at(-1)).toMatchObject({ sender: 'user', text: '第二问' });
  });

  it('control: 回答已经在记录里(codex 那样同一轮里问答都有):照记录给', async () => {
    rows.push({ id: 'mine', runtime: 'pty', provider: 'codex', projectId: 'p' });
    recordTurns.set('mine', [turn(0, [['user', '问'], ['assistant', '答']])]);
    expect((await read()).messages.at(-1)).toMatchObject({ sender: 'assistant', text: '答' });
    expect(recordCalls).toHaveLength(1);
  });

  it('记录不在这台机器上:开着的面板 agent 照旧问运行时', async () => {
    openPanelAgent('mine');
    runtimeTurns = [turn(1, [['assistant', '运行时那份']])];
    recordFailure.set('mine', { code: 'record_not_found', message: 'no such file' });
    const page = await readAgentHistoryForExtension({ agentId: 'user:mine', visibleAgents: VISIBLE });
    expect(page.messages.map((m) => m.text)).toEqual(['运行时那份']);
  });
});

describe('可见的 agent 照常能用', () => {
  it('停一个面板 agent 走宿主自己的 stopSession', async () => {
    openPanelAgent('mine');
    await stopAgentForExtension({ agentId: 'user:mine', visibleAgents: VISIBLE });
    expect(stopped).toEqual(['mine']);
  });
});

describe('问题 13:扩展起的 agent 是一条独立会话(#5665),在这个扩展的范围之内', () => {
  /** 一条会话行,以及(若有)是哪个扩展起的。 */
  function agentRow(id: string, spawnedByExtensionId: string | null = null): void {
    rows.push({ id, runtime: 'acp', provider: 'claude', projectId: 'p', title: id, spawnedByExtensionId });
  }
  // 页面开在哪(会话 `here` 的那一格)不参与:窄词只够得着自己起的(owner 10-05 23:29)。
  const ours = { scope: 'own' as const, extensionId: 'agent-notes' };
  const everyone = { ...ours, scope: 'all' as const };

  it('只有 agents:read:自己起的;页面所在那条会话、别的扩展起的、别的会话都看不见', async () => {
    agentRow('here');
    agentRow('mine-elsewhere', 'agent-notes');
    agentRow('theirs-elsewhere', 'other-ext');
    agentRow('plain-elsewhere');
    const { agents: listed } = await listAgentsForExtension(ours);
    expect(listed.map((agent) => [agent.agentId, agent.spawnedByThisExtension])).toEqual([['user:mine-elsewhere', true]]);
  });

  it(':all 看得见全部,「是我起的」只标自己的那条 —— ❌ 给出别的扩展的 id', async () => {
    agentRow('here');
    agentRow('mine-elsewhere', 'agent-notes');
    agentRow('theirs-elsewhere', 'other-ext');
    const { agents: listed } = await listAgentsForExtension(everyone);
    expect(listed.map((agent) => [agent.agentId, agent.spawnedByThisExtension])).toEqual([
      ['user:here', false],
      ['user:mine-elsewhere', true],
      ['user:theirs-elsewhere', false],
    ]);
    expect(JSON.stringify(listed)).not.toContain('other-ext');
  });

  // 集体记忆对账第 4 条:读和起用同一套词,行上的 transport 能原样交回 spawnAgent。
  it('transport 是 spawnAgent / session_spawn 收的 acp / pty', async () => {
    agentRow('chat-ui');
    rows.push({ id: 'tui', runtime: 'pty', provider: 'claude', projectId: 'p', title: 'tui', spawnedByExtensionId: null });
    const { agents: listed } = await listAgentsForExtension(everyone);
    expect(listed.map((agent) => [agent.agentId, agent.transport])).toEqual([
      ['user:chat-ui', 'acp'],
      ['user:tui', 'pty'],
    ]);
  });

  // A Gugu model's menu name, as kept with each session's decision; an engine's own model has none.
  it('modelLabel: a Gugu model\'s kept menu name; an engine\'s own model has none', async () => {
    agentRow('chat-a');
    agentRow('chat-b');
    rows.push({ id: 'tui', runtime: 'pty', provider: 'claude', projectId: 'p', title: 'tui', spawnedByExtensionId: null });
    agentRow('own');
    for (const id of ['chat-a', 'chat-b', 'tui']) platformDecisions.set(id, { modelId: 'glm-5.3-flash' });
    const { agents: listed } = await listAgentsForExtension(everyone);
    expect(listed.map((agent) => [agent.agentId, agent.model, agent.modelLabel])).toEqual([
      ['user:chat-a', 'platform:glm-5.3-flash', 'GLM 5.3 Flash'],
      ['user:chat-b', 'platform:glm-5.3-flash', 'GLM 5.3 Flash'],
      ['user:tui', 'platform:glm-5.3-flash', 'GLM 5.3 Flash'],
      ['user:own', null, null],
    ]);
  });

  it('上下文用量(L12):开着的会话给引擎报的数,没开的给 null —— ❌ 拿 0 冒充', async () => {
    agentRow('open');
    agentRow('cold');
    liveSessions.add('open');
    contextTokensOf.set('open', 412_345);
    const { agents: listed } = await listAgentsForExtension(everyone);
    expect(listed.map((agent) => [agent.agentId, agent.contextTokens])).toEqual([
      ['user:open', 412_345],
      ['user:cold', null],
    ]);
    contextTokensOf.clear();
  });

  it('账号额度(G3):开着的会话给引擎最后报的那次(resetsAt 写成 ISO,和 updatedAt 一样),没报过、没开的给 null', async () => {
    agentRow('open');
    agentRow('quiet');
    agentRow('cold');
    liveSessions.add('open');
    liveSessions.add('quiet');
    rateLimitOf.set('open', { status: 'rejected', resetsAt: Date.UTC(2026, 9, 1, 14, 40), window: 'five_hour', utilization: null });
    const { agents: listed } = await listAgentsForExtension(everyone);
    expect(listed.map((agent) => [agent.agentId, agent.rateLimit])).toEqual([
      ['user:open', { status: 'rejected', resetsAt: '2026-10-01T14:40:00.000Z', window: 'five_hour', utilization: null }],
      ['user:quiet', null],
      ['user:cold', null],
    ]);
    rateLimitOf.clear();
  });

  it('状态细分:与 status 同一次落库的 detail 原样给;error 与没有状态源的给 null', async () => {
    rows.push({ id: 'waits', runtime: 'acp', provider: 'claude', projectId: 'p', title: 'waits', spawnedByExtensionId: null, agentStatus: 'needs_user', agentStatusDetail: 'approval' });
    rows.push({ id: 'done', runtime: 'pty', provider: 'claude', projectId: 'p', title: 'done', spawnedByExtensionId: null, agentStatus: 'idle', agentStatusDetail: 'done' });
    rows.push({ id: 'broke', runtime: 'acp', provider: 'claude', projectId: 'p', title: 'broke', spawnedByExtensionId: null, agentStatus: 'error', agentStatusDetail: null });
    agentRow('silent');
    const { agents: listed } = await listAgentsForExtension(everyone);
    expect(listed.map((agent) => [agent.agentId, agent.status, agent.detail])).toEqual([
      ['user:waits', 'needs_user', 'approval'],
      ['user:done', 'idle', 'done'],
      ['user:broke', 'error', null],
      ['user:silent', null, null],
    ]);
  });

  it('引擎自己没了的原因:进程退出带退出码与信号,起不来只给话(结构化错误留在运行时里);好好的、没开的给 null', async () => {
    agentRow('exited');
    agentRow('never');
    agentRow('fine');
    agentRow('cold');
    for (const id of ['exited', 'never', 'fine']) liveSessions.add(id);
    failureOf.set('exited', { kind: 'adapter-exit', exitCode: null, signal: 'SIGKILL', message: 'ACP adapter exited unexpectedly (signal SIGKILL)' });
    failureOf.set('never', { kind: 'start-failed', message: 'claude: not logged in', error: { code: 'AUTH_REQUIRED', detail: 'x' } });
    const { agents: listed } = await listAgentsForExtension(everyone);
    expect(listed.map((agent) => [agent.agentId, agent.failure])).toEqual([
      ['user:exited', { kind: 'adapter-exit', message: 'ACP adapter exited unexpectedly (signal SIGKILL)', exitCode: null, signal: 'SIGKILL' }],
      ['user:never', { kind: 'start-failed', message: 'claude: not logged in', exitCode: null, signal: null }],
      ['user:fine', null],
      ['user:cold', null],
    ]);
    failureOf.clear();
  });

  it('最后一次调工具:开着的会话给运行时记的时刻(ISO,和 updatedAt 一样),还没调过、没开的给 null', async () => {
    agentRow('busy');
    agentRow('quiet');
    agentRow('cold');
    liveSessions.add('busy');
    liveSessions.add('quiet');
    lastActionAtOf.set('busy', Date.UTC(2026, 9, 8, 13, 5));
    const { agents: listed } = await listAgentsForExtension(everyone);
    expect(listed.map((agent) => [agent.agentId, agent.lastActionAt])).toEqual([
      ['user:busy', '2026-10-08T13:05:00.000Z'],
      ['user:quiet', null],
      ['user:cold', null],
    ]);
    lastActionAtOf.clear();
  });

  it('App 看到的 agent id 只有 user:<uuid>(F35):还没有身份的会话不列出、够不着;会话 id 本身也够不着', async () => {
    agentRow('here');
    agentRow('no-identity-yet');
    expect((await listAgentsForExtension(everyone)).agents.map((agent) => agent.agentId)).toEqual(['user:here']);
    const visible = await visibleAgentsForExtension(everyone);
    expect([...visible]).toEqual([['user:here', 'here']]);
    await expect(stopAgentForExtension({ agentId: 'here', visibleAgents: visible })).rejects.toThrow(/No agent "here" is visible/);
    expect(stopped).toEqual([]);
  });

  it('控制与读对话用同一个可见集合:自己起的那条停得了,换一个扩展就够不着', async () => {
    agentRow('mine-elsewhere', 'agent-notes');
    await stopAgentForExtension({
      agentId: 'user:mine-elsewhere',
      visibleAgents: await visibleAgentsForExtension(ours),
    });
    expect(stopped).toEqual(['mine-elsewhere']);
    await expect(
      stopAgentForExtension({
        agentId: 'user:mine-elsewhere',
        visibleAgents: await visibleAgentsForExtension({ ...ours, extensionId: 'other-ext' }),
      })
    ).rejects.toThrow(/No agent "user:mine-elsewhere" is visible/);
    expect(stopped).toEqual(['mine-elsewhere']);
  });
});

describe(':all-machines:别的机器上的 agent 来自那台机器的会话列表(界面同一份)', () => {
  const app = { scope: 'all-machines' as const, extensionId: 'agent-notes' };
  function remote(id: string, extra: Record<string, unknown> = {}) {
    return {
      deviceId: 'dev-b',
      label: 'Studio',
      session: {
        conversationId: id, projectId: 'pb', title: id, harness: 'codex', runtime: 'pty',
        status: { status: 'working', detail: null }, lastInteractedAt: '2026-10-09T03:00:00Z',
        parentConversationId: null, spawnedByExtensionId: null, agent: { userId: id }, ...extra,
      },
    };
  }

  it('标上机器;只有这台读得到的活读数给 null(问不出来),父会话在哪台机器都找得到', async () => {
    rows.push({ id: 'parent-here', runtime: 'acp', provider: 'claude', projectId: 'p', title: 'parent-here', spawnedByExtensionId: null });
    liveSessions.add('parent-here');
    contextTokensOf.set('parent-here', 7);
    elsewhere = {
      sessions: [remote('child-there', { parentConversationId: 'parent-here', spawnedByExtensionId: 'agent-notes' }), remote('no-agent', { agent: null })],
      unreached: [{ deviceId: 'dev-c', label: 'Laptop', detail: 'offline' }],
    };
    const { agents, unreached } = await listAgentsForExtension(app);
    expect(agents.map((agent) => [agent.agentId, agent.deviceId, agent.deviceLabel, agent.contextTokens])).toEqual([
      ['user:parent-here', null, null, 7],
      ['user:child-there', 'dev-b', 'Studio', null],
    ]);
    const child = agents[1]!;
    expect(child).toMatchObject({
      parentAgentId: 'user:parent-here', spawnedByThisExtension: true, transport: 'pty', providerId: 'codex',
      status: 'working', model: null, modelLabel: null, isGenerating: null, failure: null, pendingPermissionCount: null, queuedPromptCount: null,
    });
    expect(unreached).toEqual([{ deviceId: 'dev-c', label: 'Laptop', detail: 'offline' }]);
    contextTokensOf.clear();
  });

  it('老宿主(行上没有 agent 这一格)那台:不列,记成没读到 —— ❌ 当成那台机器上没有 agent', async () => {
    const { agent: _drop, ...noAgentKey } = remote('old-there').session;
    elsewhere = { sessions: [{ deviceId: 'dev-old', label: 'Old Mac', session: noAgentKey }, remote('there')], unreached: [] };
    const { agents, unreached } = await listAgentsForExtension(app);
    expect(agents.map((agent) => agent.agentId)).toEqual(['user:there']);
    expect(unreached).toEqual([{ deviceId: 'dev-old', label: 'Old Mac', detail: expect.stringContaining('too old to list its agents') }]);
  });

  it(':all 只看这台:不去问别的机器', async () => {
    elsewhere = { sessions: [remote('there')], unreached: [] };
    const { agents } = await listAgentsForExtension({ ...app, scope: 'all' });
    expect(agents).toEqual([]);
  });
});
