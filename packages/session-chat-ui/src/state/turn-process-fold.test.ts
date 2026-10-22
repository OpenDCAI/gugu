import { unit } from '@session-chat/core/units';
import type { ItemSegmenter, SegmentCtx, SegmentItem } from '@session-chat/core/units';
import { defaultChatTranslator } from '@session-chat/localization';
import { describe, expect, it } from 'vitest';
import type { ChatItem, ChatMessage, TranscriptTurn, TurnProcessItem, TurnCompletionItem } from '@session-chat/model';
import { flattenTier, planTurnFold, toolRunId, turnProcessId } from './flatten';
import { pendingPromptTurn } from './pending-prompt';
import { joinsFoldRunAt, turnProcessLabel } from './turn-fold';

function passthrough(kind: string): ItemSegmenter {
  return {
    kind,
    segment: (item: SegmentItem) => [unit(item.kind, item, item, { key: 'self' })],
  };
}
const SEGMENTERS: Record<string, ItemSegmenter> = Object.fromEntries(
  [
    'message',
    'tool',
    'thinking',
    'execute',
    'execute-tool-call',
    'subagent-done-tool-call',
    'turn-outcome',
    'turn-process',
    'turn-completion',
    'tool-run',
    'session-notice',
  ].map((k) => [k, passthrough(k)])
);

const user = (id: string, text = 'hello'): ChatMessage => ({ kind: 'message', id, seq: 0, role: 'user', text });
const reply = (id: string, text = 'done'): ChatMessage => ({ kind: 'message', id, seq: 0, role: 'assistant', text });
/** 通用工具行 —— 不属于任何语义折叠类别,一行就是一行。 */
const tool = (id: string): ChatItem => ({ kind: 'tool', id, seq: 0, name: 'bash', status: 'done' } as ChatItem);
/** 跑命令 —— 语义折叠的一类,连着两条就折成一句。 */
const bash = (id: string): ChatItem =>
  ({ kind: 'execute-tool-call', id, seq: 0, toolCallId: id, title: 'bash', status: 'done', parentToolCallId: null } as unknown as ChatItem);
const thinking = (id: string): ChatItem => ({ kind: 'thinking', id, seq: 0, text: 'hmm' } as ChatItem);
const row = (kind: string, id: string): ChatItem =>
  ({ kind, id, seq: 0, toolCallId: id, title: kind, status: 'done', parentToolCallId: null } as unknown as ChatItem);

function turn(
  id: string,
  items: ChatItem[],
  outcome?: TranscriptTurn['outcome'],
  clock?: { startedAt?: number; endedAt?: number }
): TranscriptTurn {
  return {
    id,
    seq: 1,
    initiator: items.some((i) => i.kind === 'message' && i.role === 'user') ? 'user' : 'agent',
    items: items as TranscriptTurn['items'],
    ...(outcome ? { outcome } : {}),
    ...(clock ?? {}),
  };
}

function ctxWith(extra: Partial<SegmentCtx>): SegmentCtx {
  return {
    caches: {},
    expanded: () => false,
    active: false,
    plan: () => null,
    translate: defaultChatTranslator,
    pendingToolCallIds: () => new Set<string>(),
    terminalOutputText: () => null,
    terminalExitStatus: () => null,
    ...extra,
  } as unknown as SegmentCtx;
}

const kinds = (units: ReturnType<typeof flattenTier>) => units.map((u) => u.kind);
const ids = (units: ReturnType<typeof flattenTier>) => units.map((u) => u.itemId);
const header = (units: ReturnType<typeof flattenTier>) =>
  units.find((u) => u.kind === 'turn-process')?.data as TurnProcessItem | undefined;

/**
 * 钩子说的话：桥把等级折进正文，逐行加 `<HookName> says: `（见 lib/hook-notice.ts）。
 * `at` = 它什么时候到的；回放来的历史没有这一格（#5350）。
 */
const hookNotice = (id: string, at?: number): ChatMessage => ({
  ...reply(id, '**Notice:** Stop says: ⏸ Stop 自检触发：本会话改过的仓有未提交改动'),
  ...(at !== undefined ? { at } : {}),
});

/** 压缩线：从这一行往下，agent 手里只剩一份摘要（`startedAt` = 压缩开始的时刻）。 */
const compaction = (id: string, startedAt: number): ChatItem =>
  ({ kind: 'compaction', id, seq: 0, compactionId: id, status: 'completed', summary: '', startedAt } as unknown as ChatItem);
/** 引擎重开线：从这一行往下，agent 手里什么都没有（`at` = 重开发生的时刻）。 */
const contextReset = (id: string, at: number): ChatItem =>
  ({ kind: 'context-reset', id, seq: 0, reason: 'session not found', at } as unknown as ChatItem);

const processOf = (plan: { segments: { process: ChatItem[] }[] }) =>
  plan.segments.map((s) => s.process.map((i) => i.id));
const tailOf = (plan: { segments: { tail: ChatItem[] }[] }) =>
  plan.segments.map((s) => s.tail.map((i) => i.id));

const DONE: TranscriptTurn['outcome'] = { kind: 'done' };
const FULL = turn('t1', [user('u1'), thinking('th1'), tool('c1'), reply('a-mid', 'partial'), tool('c2'), reply('a1')], DONE);

describe('planTurnFold (#4874)', () => {
  it('splits a done turn into prompt / process / final reply', () => {
    const plan = planTurnFold(FULL)!;
    expect(plan.leading.map((i) => i.id)).toEqual(['u1']);
    expect(plan.segments).toHaveLength(1);
    expect(processOf(plan)).toEqual([['th1', 'c1', 'a-mid', 'c2']]);
    expect(tailOf(plan)).toEqual([['a1']]);
  });

  it('does not fold a turn with nothing between prompt and reply', () => {
    expect(planTurnFold(turn('t', [user('u'), reply('a')], DONE))).toBeNull();
  });

  it('folds everything after the prompt when the turn never produced a reply', () => {
    const plan = planTurnFold(turn('t', [user('u'), tool('c1'), tool('c2')], DONE))!;
    expect(processOf(plan)).toEqual([['c1', 'c2']]);
    expect(tailOf(plan)).toEqual([[]]);
  });

  it('never folds a cancelled or errored turn', () => {
    // #4875 ①:`interrupted` 这一支 2026-09-20 删了 —— 它从来没有生产者,
    // 留在这里只会让下一个人以为产品会产出它。进程死亡现在落 `error/process_closed`。
    for (const outcome of [
      { kind: 'cancelled', reason: 'cancelled' },
      { kind: 'error', reason: 'prompt_failed' },
      { kind: 'error', reason: 'process_closed' },
    ] as const) {
      expect(planTurnFold(turn('t', [user('u'), tool('c'), reply('a')], outcome))).toBeNull();
    }
  });

  it('folds a replayed turn whose outcome is unknown', () => {
    expect(planTurnFold(turn('t', [user('u'), tool('c'), reply('a')]))).not.toBeNull();
  });

  it('❌ `[NO_REPLY]` 不算最后一条回复 —— 重放把一问之后的 cycle 并成一轮,末尾常是它', () => {
    // 2026-09-06 真机:「做完了,子智能体已执行 sleep 40」整条进了「过程」,因为它后面还有一条
    // agent 对完成通知的 [NO_REPLY](面板不画它)。
    const t = turn('t', [user('u'), tool('c'), reply('a-real', '做完了'), row('subagent-done-tool-call', 'd1'), reply('a-silent', '[NO_REPLY]')], DONE);
    const plan = planTurnFold(t)!;
    expect(processOf(plan)).toEqual([['c']]);
    expect(tailOf(plan)).toEqual([['a-real', 'd1', 'a-silent']]);
  });

  it('folds agent-initiated turns too (a run is a run), with no leading prompt', () => {
    const plan = planTurnFold(turn('t', [tool('c'), reply('a')], DONE))!;
    expect(plan.leading).toEqual([]);
    expect(processOf(plan)).toEqual([['c']]);
  });

  // owner 2026-09-09:「折叠之后,展示的是结束语和结束这两段文本就行」。
  // 条目顺序抄自真机(claude 2.1.266 + 一个返回 additionalContext 的 Stop 钩子):
  // 工具 → 结束语 → 钩子通知 → 新的行动 → 结束。
  it('#5350 钩子把一轮劈成两段:结束语与结束都在外面,钩子与它引发的行动各自折起来', () => {
    const t = turn('t', [
      user('u'),
      tool('c1'),
      reply('a-real', '已在 hello.txt 写入 hi,未提交。'),
      hookNotice('n1'),
      tool('c2'),
      reply('a-post', '无剩余项,本次收尾无需其他操作。'),
    ], DONE);
    const plan = planTurnFold(t)!;
    expect(processOf(plan)).toEqual([['c1'], ['n1', 'c2']]);
    expect(tailOf(plan)).toEqual([['a-real'], ['a-post']]);
  });

  it('#5350 段的起点 = 劈开它的那条钩子通知的到达时刻;第一段没有(它的起点是整轮的)', () => {
    const t = turn('t', [
      user('u'), tool('c1'), reply('r1'),
      hookNotice('n1', 5_000), tool('c2'), reply('r2'),
      hookNotice('n2', 8_000), tool('c3'), reply('r3'),
    ], DONE);
    const plan = planTurnFold(t)!;
    expect(plan.segments.map((seg) => seg.startedAt)).toEqual([undefined, 5_000, 8_000]);
  });

  it('#5350 回放来的通知没有时刻 ⇒ 段的起点也是不知道,❌ 不拿别处的钟顶上', () => {
    const t = turn('t', [user('u'), tool('c1'), reply('r1'), hookNotice('n1'), tool('c2'), reply('r2')], DONE);
    const plan = planTurnFold(t)!;
    expect(plan.segments.map((seg) => seg.startedAt)).toEqual([undefined, undefined]);
  });

  it('#5350 钩子之后 agent 没再开口 ⇒ 这一刀不切,通知照旧跟在结束语后面看得见', () => {
    const t = turn('t', [user('u'), tool('c1'), reply('a-real'), hookNotice('n1')], DONE);
    const plan = planTurnFold(t)!;
    expect(plan.segments).toHaveLength(1);
    expect(processOf(plan)).toEqual([['c1']]);
    expect(tailOf(plan)).toEqual([['a-real', 'n1']]);
  });

  it('#5350 钩子响在开口之前(没有结束语可留) ⇒ 不切,通知落在过程里', () => {
    const t = turn('t', [user('u'), hookNotice('n1'), tool('c1'), reply('a')], DONE);
    const plan = planTurnFold(t)!;
    expect(plan.segments).toHaveLength(1);
    expect(processOf(plan)).toEqual([['n1', 'c1']]);
    expect(tailOf(plan)).toEqual([['a']]);
  });

  it('#5350 钩子响两次就切两刀 —— 每一段各留自己的收尾', () => {
    const t = turn('t', [
      user('u'), tool('c1'), reply('r1'),
      hookNotice('n1'), tool('c2'), reply('r2'),
      hookNotice('n2'), tool('c3'), reply('r3'),
    ], DONE);
    const plan = planTurnFold(t)!;
    expect(processOf(plan)).toEqual([['c1'], ['n1', 'c2'], ['n2', 'c3']]);
    expect(tailOf(plan)).toEqual([['r1'], ['r2'], ['r3']]);
  });

  it('#55 钩子响在 agent 又去干活之后(不是紧跟一句话) ⇒ 不切,通知落在过程里', () => {
    const t = turn('t', [user('u'), tool('c1'), reply('r1'), tool('c2'), hookNotice('n1'), tool('c3'), reply('r2')], DONE);
    const plan = planTurnFold(t)!;
    expect(processOf(plan)).toEqual([['c1', 'r1', 'c2', 'n1', 'c3']]);
    expect(tailOf(plan)).toEqual([['r2']]);
  });

  // 桥声明了 `session.notices`(#6596)之后,钩子说的话以 `provider-notice` 来,不再是助手消息。
  describe('#55 钩子通知以 provider-notice 来', () => {
    const providerNotice = (id: string, title: string, detail = title, at?: number): ChatItem =>
      ({ kind: 'session-notice', id, seq: 0, code: 'provider-notice', title, detail, ...(at !== undefined ? { at } : {}) } as unknown as ChatItem);
    const stopHook = (id: string, at?: number) =>
      providerNotice(id, 'Stop says: ⏸ Stop 自检触发：本会话改过的仓有未提交改动', undefined, at);

    it('照样劈两段:结束语与结束在外面,通知折进第二个头', () => {
      const t = turn('t', [user('u'), tool('c1'), reply('a-real'), stopHook('n1', 5_000), tool('c2'), reply('a-post')], DONE, { startedAt: 0 });
      const plan = planTurnFold(t)!;
      expect(processOf(plan)).toEqual([['c1'], ['n1', 'c2']]);
      expect(tailOf(plan)).toEqual([['a-real'], ['a-post']]);
      expect(plan.segments[1]!.startedAt).toBe(5_000);
    });

    // 回放来的轮没有钟,通知却带着一个 `at` —— 那是回放的钟(item-fold 的 `stampAt ?? at`)。
    it('回放来的轮(没有钟):通知的 at 不算数,段的起点是不知道', () => {
      const t = turn('t', [
        user('u'), tool('c1'), reply('r1'),
        stopHook('n1', 1_000_000), tool('c2'), reply('r2'),
        stopHook('n2', 1_000_003), tool('c3'), reply('r3'),
      ], DONE);
      expect(planTurnFold(t)!.segments.map((seg) => seg.startedAt)).toEqual([undefined, undefined, undefined]);
    });

    it('结束语与钩子之间夹着的事件(别的提示、后台命令做完了)不打断切点', () => {
      const stopped = providerNotice('bg', 'Task stopped by user', 'sleep 613.', 4_000);
      const done = row('background-command-done-tool-call', 'bd');
      const t = turn('t', [user('u'), tool('c1'), reply('a-real'), stopped, done, stopHook('n1', 5_000), tool('c2'), reply('a-post')], DONE, { startedAt: 0 });
      const plan = planTurnFold(t)!;
      expect(tailOf(plan).at(-1)).toEqual(['a-post']);
      expect(plan.segments.flatMap((seg) => seg.tail.map((i) => i.id))).toContain('a-real');
    });

    it('整轮没说一句话、以钩子的话收尾 ⇒ 那句话留在外面(往往就是停下的原因)', () => {
      const plan = planTurnFold(turn('t', [user('u'), tool('c1'), stopHook('n1', 5_000)], DONE))!;
      expect(processOf(plan)).toEqual([['c1']]);
      expect(tailOf(plan)).toEqual([['n1']]);
    });

    it('❌ 只有第一行像钩子、后面几行不是 ⇒ 不是钩子,照旧是边界线', () => {
      const mixed = providerNotice('n', 'Anthropic API says: overloaded', 'retrying in 5s', 1_000);
      const plan = planTurnFold(turn('t', [user('u'), tool('c1'), reply('r1'), mixed, tool('c2'), reply('a1')], DONE, { startedAt: 0 }))!;
      expect(tailOf(plan)).toEqual([['n'], ['a1']]);
    });

    it('第一行太长、桥换了通用标题时,照 detail 认', () => {
      const long = providerNotice('n1', 'Claude reported a notice', `Stop says: ${'x'.repeat(300)}`);
      const plan = planTurnFold(turn('t', [user('u'), tool('c1'), reply('a-real'), long, tool('c2'), reply('a-post')], DONE))!;
      expect(tailOf(plan)).toEqual([['a-real'], ['a-post']]);
    });

    // 2026-10-22 真机(本 issue 的那一轮):自动压缩 → 两条 SessionStart:compact → 干活 → 结束语 → Stop → 结束。
    it('压缩后的 SessionStart:compact 不切也不留在外面;Stop 照切', () => {
      const sessionStart = (id: string) =>
        providerNotice(id, 'SessionStart:compact says: AutoLibrary · 4 volumes', 'SessionStart:compact says:   ├ workspace\nSessionStart:compact says:   └ ideas', 1_500);
      const t = turn('t', [
        user('u'), tool('c1'), reply('r0'), tool('c2'), compaction('cp1', 1_000),
        sessionStart('n1'), sessionStart('n2'), tool('c3'), reply('r-report'),
        stopHook('n3', 9_000), tool('c4'), reply('r-final'),
      ], DONE, { startedAt: 0 });
      const plan = planTurnFold(t)!;
      expect(processOf(plan)).toEqual([['c1', 'r0', 'c2'], ['n1', 'n2', 'c3'], ['n3', 'c4']]);
      expect(tailOf(plan)).toEqual([['cp1'], ['r-report'], ['r-final']]);
      expect(plan.segments.map((s) => s.startedAt)).toEqual([undefined, 1_000, 9_000]);
    });

    it('❌ 不是钩子的供应商提示照旧是边界线,留在外面', () => {
      const fallback = providerNotice('n', 'Model fallback', 'claude-a declined this request; retried with claude-b.', 1_000);
      const plan = planTurnFold(turn('t', [user('u'), tool('c1'), fallback, tool('c2'), reply('a1')], DONE))!;
      expect(processOf(plan)).toEqual([['c1'], ['c2']]);
      expect(tailOf(plan)).toEqual([['n'], ['a1']]);
    });
  });

  // #6199 B2 真机:启动期推理档被拒收的那行通知落在首句那一轮里,一轮成功收尾后被折进「Took 15s」。
  describe('session-notice 不进折叠', () => {
    const notice = (id: string, at: number): ChatItem =>
      ({ kind: 'session-notice', id, seq: 0, code: 'effort-unavailable', detail: 'x', effectiveValue: 'low', at } as unknown as ChatItem);

    it('首句 → 通知 → 回复:整轮不折,通知照常看得见', () => {
      expect(planTurnFold(turn('t', [user('u'), notice('n', 1_000), reply('a1')], DONE))).toBeNull();
    });

    it('过程中间的通知留在外面,之后另起一段', () => {
      const plan = planTurnFold(turn('t', [user('u'), tool('c1'), notice('n', 1_000), tool('c2'), reply('a1')], DONE, { startedAt: 0 }))!;
      expect(processOf(plan)).toEqual([['c1'], ['c2']]);
      expect(tailOf(plan)).toEqual([['n'], ['a1']]);
      expect(plan.segments[1]!.startedAt).toBe(1_000);
    });
  });

  describe('#5381 边界线不进折叠', () => {
    it('压缩线留在外面,线之后另起一段,起点是压缩开始的时刻', () => {
      const t = turn('t', [user('u'), tool('c1'), compaction('cp1', 1_000), tool('c2'), reply('a1')], DONE);
      const plan = planTurnFold(t)!;
      expect(processOf(plan)).toEqual([['c1'], ['c2']]);
      expect(tailOf(plan)).toEqual([['cp1'], ['a1']]);
      expect(plan.segments[1]!.startedAt).toBe(1_000);
    });

    it('引擎重开线同理 —— 起点是重开发生的时刻', () => {
      const t = turn('t', [user('u'), tool('c1'), contextReset('rs1', 2_000), tool('c2'), reply('a1')], DONE);
      const plan = planTurnFold(t)!;
      expect(processOf(plan)).toEqual([['c1'], ['c2']]);
      expect(tailOf(plan)).toEqual([['rs1'], ['a1']]);
      expect(plan.segments[1]!.startedAt).toBe(2_000);
    });

    // 2026-09-10 真机:手敲一次 `/compact`,这一轮只有「提示 → 压缩线」,整轮没有收尾,
    // 于是线被整个收进「用时 27s ›」—— 不点开就看不见上文已经被换成摘要了。
    it('线是这一轮唯一的过程时整轮就不折 —— 线照常看得见', () => {
      expect(planTurnFold(turn('t', [user('u'), compaction('cp1', 1_000)], DONE))).toBeNull();
      expect(planTurnFold(turn('t', [user('u'), compaction('cp1', 1_000), reply('a1')], DONE))).toBeNull();
    });

    it('一轮里压两次就切两刀', () => {
      const t = turn('t', [
        user('u'), tool('c1'), compaction('cp1', 1_000),
        tool('c2'), compaction('cp2', 2_000), tool('c3'), reply('a1'),
      ], DONE);
      const plan = planTurnFold(t)!;
      expect(processOf(plan)).toEqual([['c1'], ['c2'], ['c3']]);
      expect(tailOf(plan)).toEqual([['cp1'], ['cp2'], ['a1']]);
      expect(plan.segments.map((s) => s.startedAt)).toEqual([undefined, 1_000, 2_000]);
    });

    it('钩子先切、线后切 —— 两刀各切各的,线不跨过钩子定下的收尾', () => {
      const t = turn('t', [
        user('u'), tool('c1'), reply('r1'),
        hookNotice('n1'), tool('c2'), compaction('cp1', 3_000), tool('c3'), reply('r2'),
      ], DONE);
      const plan = planTurnFold(t)!;
      expect(processOf(plan)).toEqual([['c1'], ['n1', 'c2'], ['c3']]);
      expect(tailOf(plan)).toEqual([['r1'], ['cp1'], ['r2']]);
    });
  });

  // 2026-10-12 owner 手机实测:等人回答时那一轮整轮收进「Process ›」,问的那一下跟着看不见;答完照样折进「Took Ns」。
  describe('问用户的那次调用不进折叠', () => {
    const ask = (id: string, title = 'AskUserQuestion', toolName?: string): ChatItem =>
      ({ kind: 'unknown-tool-call', id: `t:tool:${id}`, seq: 0, toolCallId: id, title, name: title, ...(toolName ? { toolName } : {}), status: 'done', parentToolCallId: null } as unknown as ChatItem);

    it('过程中间问了一下:提问留在外面,之后另起一段', () => {
      const plan = planTurnFold(turn('t', [user('u'), tool('c1'), ask('q1'), tool('c2'), reply('a1')], DONE))!;
      expect(processOf(plan)).toEqual([['c1'], ['c2']]);
      expect(tailOf(plan)).toEqual([['t:tool:q1'], ['a1']]);
    });

    it('还在等人答(没有回复、没有结局):前面的过程照折,提问在外面', () => {
      const plan = planTurnFold(turn('t', [user('u'), tool('c1'), ask('q1')]))!;
      expect(processOf(plan)).toEqual([['c1'], []]);
      expect(tailOf(plan)).toEqual([['t:tool:q1'], []]);
    });

    it('计划批准(ExitPlanMode)同一条', () => {
      const plan = planTurnFold(turn('t', [user('u'), tool('c1'), ask('p1', 'ExitPlanMode'), reply('a1')], DONE))!;
      expect(tailOf(plan)).toEqual([['t:tool:p1'], ['a1']]);
    });

    it('桌面画出来的行(flattenTier):落定的一轮过程收进时间头,提问那一行留在外面', () => {
      const t = turn('t', [user('u'), tool('c1'), ask('q1'), tool('c2'), reply('a1')], DONE);
      const segmenters = { ...SEGMENTERS, 'unknown-tool-call': passthrough('unknown-tool-call') };
      const units = flattenTier([t], ctxWith({ active: false, foldTurnProcess: true }), segmenters);
      expect(ids(units)).toEqual(expect.arrayContaining(['u', 't:tool:q1', 'a1']));
      expect(ids(units)).not.toContain('c1');
      expect(ids(units)).not.toContain('c2');
    });

    // 10-12:Claude ACP 适配器的标题是显示名,工具名在 toolName(桌面 Work 视图读的就是这种形状)。
    it('ACP 形状:标题「Approve Plan」、工具名 ExitPlanMode ⇒ 同样切开;对照:只有显示标题 ⇒ 照旧折', () => {
      const plan = planTurnFold(turn('t', [user('u'), tool('c1'), ask('p1', 'Approve Plan', 'ExitPlanMode'), tool('c2'), reply('a1')], DONE))!;
      expect(processOf(plan)).toEqual([['c1'], ['c2']]);
      expect(tailOf(plan)).toEqual([['t:tool:p1'], ['a1']]);
      const titleOnly = planTurnFold(turn('t', [user('u'), tool('c1'), ask('p1', 'Approve Plan'), tool('c2'), reply('a1')], DONE))!;
      expect(processOf(titleOnly)).toEqual([['c1', 't:tool:p1', 'c2']]);
    });

    it('❌ 名单外、名字像在问的工具照旧折(名单写死,❌ 按子串猜)', () => {
      const plan = planTurnFold(turn('t', [user('u'), tool('c1'), ask('q1', 'ask_followup'), reply('a1')], DONE))!;
      expect(processOf(plan)).toEqual([['c1', 't:tool:q1']]);
      expect(tailOf(plan)).toEqual([['a1']]);
    });
  });
});

/**
 * owner 2026-09-06:「我的 toolcall 以语义的形式来表达,多个 toolcall 拼成一段带量化的一段话
 * ……这也是折叠。整体来讲,就套个时间头」「时间头本身算是过程的折叠,只不过是运行完成后,
 * 时间头是对过程的折叠」。
 * ⇒ 跑着:头在数、内容摊开;跑完:头收起整轮过程(不分几步,点开还原);agent 自发的一轮
 * 没有头。❌ 「过程 · N 步」。
 */
describe('flattenTier × foldTurnProcess (#4874 → #4981 时间头)', () => {
  it('classic (switch off) emits every row exactly as before', () => {
    const units = flattenTier([FULL], ctxWith({ foldTurnProcess: false }), SEGMENTERS);
    expect(ids(units)).toEqual(['u1', 'th1', 'c1', 'a-mid', 'c2', 'a1']);
    expect(kinds(units)).not.toContain('turn-process');
  });

  it('base (switch on):跑完的一轮,时间头把过程收起来,最终回复留在外面', () => {
    const units = flattenTier([FULL], ctxWith({ foldTurnProcess: true }), SEGMENTERS);
    expect(ids(units)).toEqual(['u1', turnProcessId('t1'), 'a1']);
    expect(header(units)?.turnId).toBe('t1');
    expect(header(units)?.live).toBeUndefined();
  });

  it('点开头 ⇒ 过程行按原顺序还原在它下面,别的轮不受影响', () => {
    const other = turn('t2', [user('u2'), tool('c9'), reply('a2')], DONE);
    const expanded = new Set([turnProcessId('t1')]);
    const units = flattenTier(
      [FULL, other],
      ctxWith({ foldTurnProcess: true, isTurnProcessExpanded: (id) => expanded.has(id) }),
      SEGMENTERS
    );
    expect(ids(units)).toEqual([
      'u1', turnProcessId('t1'), 'th1', 'c1', 'a-mid', 'c2', 'a1',
      'u2', turnProcessId('t2'), 'a2',
    ]);
  });

  it('#5350 钩子劈开的一轮画成两个头:结束语与结束在外面,各自的过程各折各的', () => {
    const t = turn('t7', [
      user('u7'), tool('c1'), reply('a-real'),
      hookNotice('n1', 5_000), tool('c2'), reply('a-post'),
    ], DONE, { startedAt: 1_000, endedAt: 9_000 });
    const units = flattenTier([t], ctxWith({ foldTurnProcess: true }), SEGMENTERS);
    expect(ids(units)).toEqual([
      'u7', turnProcessId('t7'), 'a-real', turnProcessId('t7', 1), 'a-post',
    ]);
    // 每个头写**自己**那一段:整轮起点→钩子、钩子→整轮终点,两段相加才是整轮。
    const headers = units.filter((u) => u.kind === 'turn-process').map((u) => u.data as TurnProcessItem);
    expect([headers[0].startedAt, headers[0].endedAt]).toEqual([1_000, 5_000]);
    expect([headers[1].startedAt, headers[1].endedAt]).toEqual([5_000, 9_000]);
  });

  it('#5350 通知没有时刻(回放来的) ⇒ 少哪一端就哪个头不写用时,❌ 不拿整轮读数顶某一段', () => {
    const t = turn('t9', [
      user('u9'), tool('c1'), reply('a-real'),
      hookNotice('n1'), tool('c2'), reply('a-post'),
    ], DONE, { startedAt: 1_000, endedAt: 9_000 });
    const units = flattenTier([t], ctxWith({ foldTurnProcess: true }), SEGMENTERS);
    const headers = units.filter((u) => u.kind === 'turn-process').map((u) => u.data as TurnProcessItem);
    expect([headers[0].startedAt, headers[0].endedAt]).toEqual([1_000, undefined]);
    expect([headers[1].startedAt, headers[1].endedAt]).toEqual([undefined, 9_000]);
  });

  it('#5350 两个头各开各的:点开第二个,还原的是钩子那一段', () => {
    const t = turn('t8', [
      user('u8'), tool('c1'), reply('a-real'),
      hookNotice('n1'), tool('c2'), reply('a-post'),
    ], DONE);
    const opened = new Set([turnProcessId('t8', 1)]);
    const units = flattenTier(
      [t],
      ctxWith({ foldTurnProcess: true, isTurnProcessExpanded: (id) => opened.has(id) }),
      SEGMENTERS
    );
    expect(ids(units)).toEqual([
      'u8', turnProcessId('t8'), 'a-real', turnProcessId('t8', 1), 'n1', 'c2', 'a-post',
    ]);
  });

  it('#55 钩子通知以 provider-notice 来:画出来同样是两个头,结束语与结束在外面,通知不在外面', () => {
    const stop = { kind: 'session-notice', id: 'n1', seq: 0, code: 'provider-notice', title: 'Stop says: ⏸ 收尾自检', detail: 'Stop says: ⏸ 收尾自检', at: 5_000 } as unknown as ChatItem;
    const t = turn('t10', [user('u10'), tool('c1'), reply('a-real'), stop, tool('c2'), reply('a-post')], DONE, { startedAt: 1_000, endedAt: 9_000 });
    const units = flattenTier([t], ctxWith({ foldTurnProcess: true }), SEGMENTERS);
    expect(ids(units)).toEqual(['u10', turnProcessId('t10'), 'a-real', turnProcessId('t10', 1), 'a-post']);
    const headers = units.filter((u) => u.kind === 'turn-process').map((u) => u.data as TurnProcessItem);
    expect([headers[0].startedAt, headers[0].endedAt]).toEqual([1_000, 5_000]);
    expect([headers[1].startedAt, headers[1].endedAt]).toEqual([5_000, 9_000]);
  });

  it('a cancelled turn keeps its rows and its outcome line, no header', () => {
    const cancelled = turn('t3', [user('u3'), tool('c3'), reply('a3')], { kind: 'cancelled', reason: 'cancelled' });
    const units = flattenTier([cancelled], ctxWith({ foldTurnProcess: true }), SEGMENTERS);
    expect(ids(units)).toEqual(['u3', 'c3', 'a3', 't3:outcome']);
  });

  it('a replayed turn (no outcome, no clock) folds too —— 只是头上写不出时间', () => {
    const replayed = turn('t4', [user('u4'), tool('c4'), reply('a4')]);
    const units = flattenTier([replayed], ctxWith({ foldTurnProcess: true }), SEGMENTERS);
    expect(ids(units)).toEqual(['u4', turnProcessId('t4'), 'a4']);
    expect(header(units)?.startedAt).toBeUndefined();
    expect(header(units)?.endedAt).toBeUndefined();
  });

  it('一步也折 —— 时间头是整轮过程的折叠,不分几步;头上带起止时刻', () => {
    const one = turn('t5', [user('u5'), tool('c5'), reply('a5')], DONE, { startedAt: 1_000, endedAt: 9_000 });
    const units = flattenTier([one], ctxWith({ foldTurnProcess: true }), SEGMENTERS);
    expect(ids(units)).toEqual(['u5', turnProcessId('t5'), 'a5']);
    expect(header(units)?.startedAt).toBe(1_000);
    expect(header(units)?.endedAt).toBe(9_000);
  });

  it('点开跑完的一轮,里面照样是「跑了 3 条命令」,再点一下才逐条(owner 2026-10-16,推翻 10-02 的一层)', () => {
    const t = turn('t6', [user('u6'), bash('b1'), bash('b2'), bash('b3'), reply('a6')], DONE, {
      startedAt: 1_000,
      endedAt: 43_000,
    });
    const headerOnly = flattenTier([t], ctxWith({ foldTurnProcess: true }), SEGMENTERS);
    expect(ids(headerOnly)).toEqual(['u6', turnProcessId('t6'), 'a6']);
    const opened = new Set([turnProcessId('t6')]);
    const expand = () =>
      flattenTier([t], ctxWith({ foldTurnProcess: true, isTurnProcessExpanded: (id) => opened.has(id) }), SEGMENTERS);
    expect(ids(expand())).toEqual(['u6', turnProcessId('t6'), toolRunId('t6', 'b1'), 'a6']);
    opened.add(toolRunId('t6', 'b1'));
    expect(ids(expand())).toEqual(['u6', turnProcessId('t6'), toolRunId('t6', 'b1'), 'b1', 'b2', 'b3', 'a6']);
  });

  it('思考夹在命令中间也进这一句,只有 agent 说的话把它劈开(owner 2026-10-16)', () => {
    // 截图那一轮:「短暂思考 / 执行」交替一屏,每一行思考都把「跑了 N 条命令」劈成一条一条。
    const t = turn('t14', [
      user('u14'),
      thinking('th1'), bash('b1'), thinking('th2'), bash('b2'), bash('b3'),
      reply('mid'),
      thinking('th3'), bash('b4'),
      reply('a14'),
    ], DONE, { startedAt: 1_000, endedAt: 9_000 });
    const opened = new Set([turnProcessId('t14')]);
    const units = flattenTier([t], ctxWith({ foldTurnProcess: true, isTurnProcessExpanded: (id) => opened.has(id) }), SEGMENTERS);
    expect(ids(units)).toEqual(['u14', turnProcessId('t14'), toolRunId('t14', 'th1'), 'mid', toolRunId('t14', 'th3'), 'a14']);
    const runs = units.filter((u) => u.kind === 'tool-run').map((u) => (u.data as { label: string }).label);
    expect(runs).toEqual(['Thought 2 times, ran 3 shell commands', 'Thought 1 time, ran 1 shell command']);
  });

  it('正在想的那一段思考让这一句带 live(微光),想完就不带', () => {
    const live = turn('t15', [user('u15'), bash('b1'), { ...thinking('th1'), status: 'thinking' } as ChatItem], undefined, { startedAt: 1_000 });
    const runOf = (units: ReturnType<typeof flattenTier>) => units.find((u) => u.kind === 'tool-run')?.data as { live?: boolean } | undefined;
    expect(runOf(flattenTier([live], ctxWith({ foldTurnProcess: true, active: true }), SEGMENTERS))?.live).toBe(true);
    const settled = { ...live, items: [user('u15'), bash('b1'), { ...thinking('th1'), status: 'done' } as ChatItem] as TranscriptTurn['items'] };
    expect(runOf(flattenTier([settled], ctxWith({ foldTurnProcess: true, active: true }), SEGMENTERS))?.live).toBeUndefined();
  });

  it('跑着的一轮自己摊开,里面照样语义折 —— 最后一句话前后一个样(owner 2026-10-16)', () => {
    // 最后一句话之前是过程(头下面),之后是尾巴(头外面)。两边都是连着的命令,就该都折成一句;
    // 只折一边的话,agent 再开口一次,刚折好的那几行就摊开了。
    const t = turn('t13', [user('u13'), bash('b1'), bash('b2'), bash('b3'), reply('a13'), bash('b4'), bash('b5')], undefined, {
      startedAt: 1_000,
    });
    const units = flattenTier([t], ctxWith({ foldTurnProcess: true, active: true }), SEGMENTERS);
    expect(header(units)?.live).toBe(true);
    expect(ids(units)).toEqual(['u13', turnProcessId('t13'), toolRunId('t13', 'b1'), 'a13', toolRunId('t13', 'b4')]);
  });

  it('agent 自己开头、跑完一句话没留下的一轮不套头:外面只会剩一个空头,照旧平铺(#69)', () => {
    // 没有用户开场白、initiator 是 agent —— 比如后台子智能体跑完那一轮。
    const notified = turn('t10', [row('subagent-done-tool-call', 'd1'), row('subagent-done-tool-call', 'd2'), thinking('th10')], DONE);
    const units = flattenTier([notified], ctxWith({ foldTurnProcess: true }), SEGMENTERS);
    expect(kinds(units)).not.toContain('turn-process');
    // 思考也进这一句(#7316,owner 10-16),所以两条「跑完了」和那一段思考是同一行。
    expect(ids(units)).toEqual([toolRunId('t10', 'd1')]);
  });

  // owner 2026-10-22(#69):后台命令跑完把 agent 叫醒的那一轮,跑完了过程还摊着,看着就是同一问没折。
  it('#69 agent 自己开头、说了话的一轮同样折:时间头 + 最后一句话', () => {
    const woke = turn('t11', [
      row('background-command-done-tool-call', 'bd'), row('read-tool-call', 'rd'),
      reply('a-mid', '汇总脚本写错了,先看是哪个 job 挂的'), bash('x1'), reply('a-final', '已重跑'),
    ], DONE, { startedAt: 1_000, endedAt: 66_000 });
    const units = flattenTier([woke], ctxWith({ foldTurnProcess: true }), SEGMENTERS);
    expect(ids(units)).toEqual([turnProcessId('t11'), 'a-final']);
    expect([header(units)?.startedAt, header(units)?.endedAt]).toEqual([1_000, 66_000]);
  });

  it('#69 一句话没说的那一轮不当锚:紧跟着开口的那一轮自己一个头,用时只算它自己', () => {
    // 两次被叫醒之间可能隔了很久;并成一个头,头上的用时就把这段空闲也算进去了(#70 review)。
    const silent = turn('t12', [row('background-command-done-tool-call', 'bd1'), bash('x1')], DONE, { startedAt: 1_000, endedAt: 2_000 });
    const spoke = turn('t13', [row('background-command-done-tool-call', 'bd2'), bash('x2'), reply('a13', '验证完了')], DONE, { startedAt: 600_000, endedAt: 604_000 });
    const units = flattenTier([silent, spoke], ctxWith({ foldTurnProcess: true }), SEGMENTERS);
    const headers = units.filter((u) => u.kind === 'turn-process');
    expect(headers.map((u) => u.itemId)).toEqual([turnProcessId('t13')]);
    // 没开口的那一轮平铺(两行语义折成一句),开口的那一轮自己一个头。
    expect(ids(units)).toEqual([toolRunId('t12', 'bd1'), turnProcessId('t13'), 'a13']);
    const h = headers[0]?.data as { startedAt?: number; endedAt?: number };
    expect([h.startedAt, h.endedAt]).toEqual([600_000, 604_000]);
  });

  it('#69 只说了 `[NO_REPLY]` 或空白不算开口:照旧平铺', () => {
    const quiet = turn('t15', [row('background-command-done-tool-call', 'bd'), bash('x1'), reply('nr', '[NO_REPLY]')], DONE, { startedAt: 1_000, endedAt: 2_000 });
    const blank = turn('t16', [row('background-command-done-tool-call', 'bd'), bash('x1'), reply('ws', '  \n')], DONE, { startedAt: 3_000, endedAt: 4_000 });
    for (const t of [quiet, blank]) {
      expect(kinds(flattenTier([t], ctxWith({ foldTurnProcess: true }), SEGMENTERS))).not.toContain('turn-process');
    }
  });

  it('#69 agent 自己开头、只以钩子的话收尾的一轮:没开口,平铺,钩子的话看得见', () => {
    const t = turn('t17', [row('background-command-done-tool-call', 'bd'), bash('x1'), hookNotice('hk')], DONE, { startedAt: 1_000, endedAt: 2_000 });
    const units = flattenTier([t], ctxWith({ foldTurnProcess: true }), SEGMENTERS);
    expect(kinds(units)).not.toContain('turn-process');
    expect(ids(units)).toContain('hk');
  });

  it('#69 一句话没说的自发轮照旧并进前面那一问(那一问还没收尾)', () => {
    const asked = turn('t18', [user('u18'), bash('x1')], DONE, { startedAt: 1_000, endedAt: 2_000 });
    const silent = turn('t19', [row('background-command-done-tool-call', 'bd'), bash('x2')], DONE, { startedAt: 3_000, endedAt: 4_000 });
    const units = flattenTier([asked, silent], ctxWith({ foldTurnProcess: true }), SEGMENTERS);
    expect(units.filter((u) => u.kind === 'turn-process').map((u) => u.itemId)).toEqual([turnProcessId('t18')]);
    expect(ids(units).slice(0, 2)).toEqual(['u18', turnProcessId('t18')]);
    expect(ids(units)).not.toContain('bd');
  });

  it('#69 agent 自己开头、正在跑的一轮不套头:开不开口还不知道,跑完再折', () => {
    const running = turn('t14', [row('background-command-done-tool-call', 'bd'), bash('x1'), reply('a14', '在查'), bash('x2')], undefined, { startedAt: 5_000 });
    const units = flattenTier([running], ctxWith({ foldTurnProcess: true, active: true }), SEGMENTERS);
    expect(kinds(units)).not.toContain('turn-process');
    expect(ids(units)).toContain('a14');
  });

  it('活动层:时间头带 live 在数,内容**默认摊开**(Codex:跑着的时候看得见在干嘛)', () => {
    const live = turn('t8', [user('u8'), thinking('th8'), tool('c8')], undefined, { startedAt: 5_000 });
    const units = flattenTier([live], ctxWith({ foldTurnProcess: true, active: true }), SEGMENTERS);
    expect(ids(units)).toEqual(['u8', turnProcessId('t8'), 'th8', 'c8']);
    expect(header(units)?.live).toBe(true);
    expect(header(units)?.startedAt).toBe(5_000);
  });

  it('活动层点一下头 ⇒ 收起(同一把开关,活动层反着读)', () => {
    const live = turn('t8', [user('u8'), thinking('th8'), tool('c8')], undefined, { startedAt: 5_000 });
    const toggled = new Set([turnProcessId('t8')]);
    const units = flattenTier(
      [live],
      ctxWith({ foldTurnProcess: true, active: true, isTurnProcessExpanded: (id) => toggled.has(id) }),
      SEGMENTERS
    );
    expect(ids(units)).toEqual(['u8', turnProcessId('t8')]);
  });

  it('#5350 活动层里钩子已经封口的那一段不再带 live —— 一个停了的段不该一直在数秒', () => {
    // 钩子响过、agent 又说了一句,但这一轮还没落定(prompt 还没返回)。
    // ⚠️ 后面那句回复是**必需**的:钩子之后 agent 还没开口时这一刀根本不切(见上面的判据),
    // 于是只有一个头,判不出「封口的段还在数秒」这件事。
    const live = turn('t11', [
      user('u11'), tool('c1'), reply('a-real'),
      hookNotice('n1', 5_000), tool('c2'), reply('a-post'),
    ], undefined, { startedAt: 1_000 });
    const units = flattenTier([live], ctxWith({ foldTurnProcess: true, active: true }), SEGMENTERS);
    const headers = units.filter((u) => u.kind === 'turn-process').map((u) => u.data as TurnProcessItem);
    expect(headers).toHaveLength(2);
    expect(headers[0].live).toBeUndefined();
    expect([headers[0].startedAt, headers[0].endedAt]).toEqual([1_000, 5_000]);
    // 还在跑的那一段照旧带 live、内容默认摊开(跑着的时候看得见在干嘛)。
    expect(headers[1].live).toBe(true);
    expect(headers[1].endedAt).toBeUndefined();
    expect(ids(units)).toEqual([
      'u11', turnProcessId('t11'), 'a-real', turnProcessId('t11', 1), 'n1', 'c2', 'a-post',
    ]);
  });

  it('❌ 落定的那一轮不带 live —— 微光的标签会谎称还在跑', () => {
    const units = flattenTier([FULL], ctxWith({ foldTurnProcess: true }), SEGMENTERS);
    expect(header(units)?.live).toBeUndefined();
  });

  it('❌ 开关关掉时活动层也没有头', () => {
    const units = flattenTier([FULL], ctxWith({ foldTurnProcess: false, active: true }), SEGMENTERS);
    expect(kinds(units)).not.toContain('turn-process');
    expect(ids(units)).toContain('c1');
  });

  // owner 10-07:上游首字节常常几十秒,那段时间里这一轮只有用户那一句 —— 头从这一刻就在(`pendingTurnHeader`)。
  // owner 10-23:还没有可折的过程时它是占位,写「正在思考…」、不数秒(`placeholderTurnHeader`)。
  it.each([true, false])('活动层只有用户那一句:头已经在、只占位不数秒,id 就是过程折叠的头(foldTurnProcess=%s)', (fold) => {
    const live = turn('t12', [user('u12')], undefined, { startedAt: 7_000 });
    const units = flattenTier([live], ctxWith({ foldTurnProcess: fold, active: true }), SEGMENTERS);
    expect(ids(units)).toEqual(['u12', turnProcessId('t12')]);
    expect(header(units)).toMatchObject({ live: true, placeholder: true, turnId: 't12' });
    expect(header(units)).not.toHaveProperty('startedAt');
    expect(header(units)).not.toHaveProperty('withBody');
    // 思考一到,双栏里它落在同一个头下面,头接着从这一轮的起点数
    const withThinking = flattenTier([{ ...live, items: [user('u12'), thinking('th12')] as TranscriptTurn['items'] }], ctxWith({ foldTurnProcess: true, active: true }), SEGMENTERS);
    expect(ids(withThinking)).toEqual(['u12', turnProcessId('t12'), 'th12']);
    expect(header(withThinking)).toMatchObject({ live: true, startedAt: 7_000 });
    expect(header(withThinking)).not.toHaveProperty('placeholder');
  });

  // 乐观行(发出了、真的那一轮还没开出,新会话可能还在建立)与真开出来的一轮,头一样是占位。
  it('乐观行与刚开出的真一轮:头都是占位,不计时', () => {
    const sentAt = new Date(2026, 9, 16, 9, 30).getTime();
    const units = flattenTier([pendingPromptTurn({ id: 'p1', text: 'hi', sentAt })], ctxWith({ foldTurnProcess: true, active: true }), SEGMENTERS);
    expect(ids(units)).toEqual(['p1', turnProcessId('pending:p1:turn')]);
    expect(header(units)).toMatchObject({ live: true, placeholder: true });
    expect(header(units)).not.toHaveProperty('startedAt');
    const real = flattenTier([turn('t15', [user('u15')], undefined, { startedAt: sentAt })], ctxWith({ foldTurnProcess: true, active: true }), SEGMENTERS);
    expect(header(real)).toMatchObject({ live: true, placeholder: true });
    expect(header(real)).not.toHaveProperty('startedAt');
  });

  // owner 10-23 真机:agent 先说一句再去跑命令,过程是空的,头被撤掉,第二句话到了又冒出来(消失 13.7 s)。
  it('先开口再干活:头从发出到落定一直在、id 不变;第二句话之前占位,之后数秒', () => {
    const at = (items: ChatItem[]) =>
      flattenTier([turn('t16', items, undefined, { startedAt: 7_000 })], ctxWith({ foldTurnProcess: true, active: true }), SEGMENTERS);
    const steps = [
      [user('u16')],
      [user('u16'), reply('a1', '先跑第一条')],
      [user('u16'), reply('a1', '先跑第一条'), bash('c1')],
      [user('u16'), reply('a1', '先跑第一条'), bash('c1'), reply('a2', '再跑第二条')],
    ].map(at);
    for (const units of steps) {
      expect(units.filter((u) => u.kind === 'turn-process').map((u) => u.itemId)).toEqual([turnProcessId('t16')]);
      expect(ids(units).slice(0, 2)).toEqual(['u16', turnProcessId('t16')]);
    }
    // 第一句话在、过程还空:头占位(不数秒),那句话在它下面,头不带微光
    expect(ids(steps[1])).toEqual(['u16', turnProcessId('t16'), 'a1']);
    expect(header(steps[1])).toMatchObject({ live: true, placeholder: true, withBody: true });
    expect(header(steps[1])).not.toHaveProperty('startedAt');
    expect(header(steps[2])).toMatchObject({ placeholder: true });
    expect(header(steps[2])).not.toHaveProperty('startedAt');
    // 第二句话一到,第一句与那条命令折进头里,头开始写「已处理 Ns」
    expect(header(steps[3])).toMatchObject({ live: true, withBody: true, startedAt: 7_000 });
    expect(header(steps[3])).not.toHaveProperty('placeholder');
    expect(ids(steps[3]).at(-1)).toBe('a2');
  });

  // #124 review:前面有边界线时,过程到了接手的是线后面那一段的头 —— 占位就得在那儿、用那一段的 id。
  it('先开口之前有一条通知:占位在通知之后、用后一段的 id;过程到了头不挪', () => {
    const notice = { kind: 'session-notice', id: 'n17', seq: 0, code: 'effort-unavailable', detail: 'x', effectiveValue: 'low', at: 7_500 } as unknown as ChatItem;
    const at = (items: ChatItem[]) =>
      flattenTier([turn('t17', items, undefined, { startedAt: 7_000 })], ctxWith({ foldTurnProcess: true, active: true }), SEGMENTERS);
    const talking = at([user('u17'), notice, reply('a1', '先跑第一条')]);
    expect(ids(talking)).toEqual(['u17', 'n17', turnProcessId('t17', 1), 'a1']);
    expect(header(talking)).toMatchObject({ placeholder: true });
    const folded = at([user('u17'), notice, reply('a1', '先跑第一条'), bash('c1'), reply('a2', '再跑第二条')]);
    expect(ids(folded).slice(0, 3)).toEqual(['u17', 'n17', turnProcessId('t17', 1)]);
    expect(header(folded)).not.toHaveProperty('placeholder');
  });

  // #124 review:等人答提问、刚插了话时 agent 没在想 —— ❌ 一行「正在思考」在提问卡下面扫。
  describe('最后一段还什么都没有:不占位', () => {
    const ask = (id: string): ChatItem =>
      ({ kind: 'unknown-tool-call', id: `t:tool:${id}`, seq: 0, toolCallId: id, title: 'AskUserQuestion', name: 'AskUserQuestion', status: 'done', parentToolCallId: null } as unknown as ChatItem);
    const flat = (items: ChatItem[]) =>
      flattenTier([turn('t18', items, undefined, { startedAt: 7_000 })], ctxWith({ foldTurnProcess: true, active: true }), SEGMENTERS);
    const placeholders = (units: ReturnType<typeof flattenTier>) =>
      units.filter((u) => u.kind === 'turn-process' && (u.data as TurnProcessItem).placeholder);

    it('一开口就问(没有可折的过程)', () => {
      expect(kinds(flat([user('u18'), ask('q1')]))).not.toContain('turn-process');
    });
    it('干了点活再问:前面那段照常有头,提问后面不占位', () => {
      const units = flat([user('u18'), tool('c1'), ask('q1')]);
      expect(placeholders(units)).toHaveLength(0);
      expect(units.filter((u) => u.kind === 'turn-process').map((u) => u.itemId)).toEqual([turnProcessId('t18')]);
    });
    it('人答了、agent 先说一句(折叠视图的那一路):占位在那句话之前,用那一段的 id', () => {
      const units = flat([user('u18'), tool('c1'), ask('q1'), reply('a1', '好,照这个来')]);
      expect(placeholders(units).map((u) => u.itemId)).toEqual([turnProcessId('t18', 1)]);
      expect(ids(units).slice(-2)).toEqual([turnProcessId('t18', 1), 'a1']);
      const folded = flat([user('u18'), tool('c1'), ask('q1'), reply('a1', '好,照这个来'), tool('c2'), reply('a2', '做完了')]);
      expect(placeholders(folded)).toHaveLength(0);
      expect(ids(folded)).toContain(turnProcessId('t18', 1));
    });
  });

  it('❌ agent 自己开的一轮(没人问)先说一句:不占位', () => {
    const own = turn('t19', [reply('a1', '定时任务到了')], undefined, { startedAt: 7_000 });
    expect(kinds(flattenTier([own], ctxWith({ foldTurnProcess: true, active: true }), SEGMENTERS))).not.toContain('turn-process');
  });

  // #124 review:收起来时下面什么都看不见,头是这一轮唯一的动静 —— 它要带微光(`withBody` 不在)。
  it('跑着的头收起时不带 withBody', () => {
    const live = turn('t20', [user('u20'), thinking('th20'), tool('c20')], undefined, { startedAt: 5_000 });
    const open = flattenTier([live], ctxWith({ foldTurnProcess: true, active: true }), SEGMENTERS);
    expect(header(open)).toMatchObject({ withBody: true });
    const toggled = new Set([turnProcessId('t20')]);
    const closed = flattenTier([live], ctxWith({ foldTurnProcess: true, active: true, isTurnProcessExpanded: (id) => toggled.has(id) }), SEGMENTERS);
    expect(ids(closed)).toEqual(['u20', turnProcessId('t20')]);
    expect(header(closed)).not.toHaveProperty('withBody');
  });

  it('❌ 落定的轮没有空头 —— 一句话就答完的那轮,落定后头收掉', () => {
    const answered = turn('t13', [user('u13'), reply('a13', 'on it')], DONE, { startedAt: 7_000, endedAt: 9_000 });
    expect(kinds(flattenTier([answered], ctxWith({ foldTurnProcess: true }), SEGMENTERS))).not.toContain('turn-process');
    const settled = turn('t14', [user('u14')], DONE, { startedAt: 7_000, endedAt: 9_000 });
    expect(kinds(flattenTier([settled], ctxWith({ foldTurnProcess: true }), SEGMENTERS))).not.toContain('turn-process');
  });
});

describe('#6006 input navigation through process folds', () => {
  it.each([false, true])('keeps every later input addressable when active=%s', (active) => {
    const t = turn('t', [
      user('first'), tool('work1'), reply('progress'),
      user('group', '<gugu_delivery route="chat"><![CDATA[group input]]></gugu_delivery>'),
      tool('work2'), user('topic'), reply('final'),
    ], { kind: 'done' });
    const units = flattenTier([t], ctxWith({ active, foldTurnProcess: true }), SEGMENTERS);
    expect(ids(units)).toEqual(expect.arrayContaining(['first', 'group', 'topic', 'final']));
    // The fix must not disable process folding to make navigation pass.
    if (!active) expect(ids(units)).not.toContain('work1');
  });
});

// 时间头上的秒数:固定的 now,❌ 读墙钟(挂载后的 DOM 读数只判「有秒数」,数对不对在这里判)。
describe('turnProcessLabel', () => {
  const t = defaultChatTranslator;
  it('跑着:从这一轮开始到 now 的时长', () => {
    expect(turnProcessLabel({ live: true, startedAt: 10_000 }, 26_400, t)).toBe('Worked for 16s');
    expect(turnProcessLabel({ live: true, startedAt: 10_000 }, 72_000, t)).toBe('Worked for 1m02s');
  });
  it('占位 ⇒ 正在思考,❌ 编一个时长', () => {
    expect(turnProcessLabel({ live: true, placeholder: true }, 26_400, t)).toBe('Thinking…');
  });
  it('跑着、有过程但不知道起点(回放来的一轮)⇒ 处理中,❌ 冒充「正在思考」', () => {
    expect(turnProcessLabel({ live: true }, 26_400, t)).toBe('Working…');
  });
  it('落定:总时长,与 now 无关', () => {
    expect(turnProcessLabel({ startedAt: 10_000, endedAt: 52_000 }, 999_999, t)).toBe('Took 42s');
  });
  it('now 比起点还早(时钟往回跳)⇒ 0s,❌ 负数', () => {
    expect(turnProcessLabel({ live: true, startedAt: 10_000 }, 9_000, t)).toBe('Worked for 0s');
  });
});

describe('tool-only completion reading (#7324)', () => {
  const clock = { startedAt: 10_000, endedAt: 17_000 };
  const reading = (turns: TranscriptTurn[], active = false) =>
    flattenTier(turns, ctxWith({ foldTurnProcess: true, active }), SEGMENTERS)
      .find((unit) => unit.kind === 'turn-completion')?.data as TurnCompletionItem | undefined;

  it('uses an actual successful turn ending, not a successful tool result', () => {
    const items = [user('u'), tool('send')];
    expect(reading([turn('t', items, DONE, clock)])?.text).toBe('bash');
    expect(reading([turn('t', items, undefined, clock)], true)).toBeUndefined();
    expect(reading([turn('t', items, undefined, clock)])).toBeUndefined();
  });

  it('keeps final replies and non-successful outcomes on their existing paths', () => {
    expect(reading([turn('t', [user('u'), tool('send'), reply('a')], DONE, clock)])).toBeUndefined();
    for (const outcome of [{ kind: 'cancelled' }, { kind: 'error' }] as const) {
      const units = flattenTier([turn('t', [user('u'), tool('send')], outcome, clock)], ctxWith({ foldTurnProcess: true }), SEGMENTERS);
      expect(header(units)).toBeUndefined();
      expect(kinds(units)).toContain('turn-outcome');
    }
  });

  it.each(['', '  ', '[NO_REPLY]', '[NO_REPLY][NO_REPLY]', ' [NO_REPLY]\n'])('does not treat %j as a visible closing reply', (text) => {
    expect(reading([turn('t', [user('u'), tool('send'), reply('a', text)], DONE, clock)])?.text).toBe('bash');
  });

  it('takes completion from the last merged cycle, including its unknown outcome', () => {
    const first = turn('first', [user('u'), tool('send')], DONE, clock);
    const next = turn('next', [tool('other')], undefined, { startedAt: 17_000, endedAt: 19_000 });
    expect(reading([first, next])).toBeUndefined();
    expect(reading([first, { ...next, outcome: DONE }])?.text).toBe('bash\n\nbash');
  });
  it('places actions after a final tool even when the agent spoke before calling it', () => {
    expect(reading([turn('t', [user('u'), reply('preface', 'I will send the reply'), tool('send')], DONE, clock)])?.text)
      .toBe('I will send the reply\n\nbash');
  });
});

describe('joinsFoldRunAt:追加的那一轮会不会并进前面还没收尾的折叠(#70 review)', () => {
  const DAY = 86_400_000;
  const ask = turn('ask', [user('u'), bash('x0')], DONE, { startedAt: 1_000, endedAt: 2_000 });
  const answered = turn('answered', [user('u'), bash('x0'), reply('a0')], DONE, { startedAt: 1_000, endedAt: 2_000 });
  const silent = turn('silent', [row('background-command-done-tool-call', 'bd'), bash('x1')], DONE, { startedAt: 3_000, endedAt: 4_000 });
  const spoke = turn('spoke', [bash('x2'), reply('a2', '做完了')], DONE, { startedAt: 5_000, endedAt: 6_000 });

  it('前一问没收尾、agent 接着干 ⇒ 会并', () => {
    expect(joinsFoldRunAt([ask, spoke], 1, true)).toBe(true);
  });
  it('隔着一轮并进去的没开口的轮,也往回找到那一问', () => {
    expect(joinsFoldRunAt([ask, silent, spoke], 2, true)).toBe(true);
  });
  it('前一问已经有了回复、人开口的一轮、没开折叠、头一轮 ⇒ 不并', () => {
    expect(joinsFoldRunAt([answered, spoke], 1, true)).toBe(false);
    expect(joinsFoldRunAt([ask, answered], 1, true)).toBe(false);
    expect(joinsFoldRunAt([ask, spoke], 1, false)).toBe(false);
    expect(joinsFoldRunAt([spoke], 0, true)).toBe(false);
  });
  it('一句没说的轮不当锚,后面那一轮不并', () => {
    expect(joinsFoldRunAt([answered, silent, spoke], 2, true)).toBe(false);
  });
  it('跨了一天的那一轮不并', () => {
    expect(joinsFoldRunAt([ask, { ...spoke, startedAt: DAY * 3, endedAt: DAY * 3 + 1_000 }], 1, true)).toBe(false);
  });
});
