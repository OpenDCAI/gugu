import { unit } from '@session-chat/core/units';
import type { ItemSegmenter, SegmentCtx, SegmentItem } from '@session-chat/core/units';
import { defaultChatTranslator } from '@session-chat/localization';
import { describe, expect, it } from 'vitest';
import type { ChatItem, ChatMessage, TranscriptTurn, TurnProcessItem, TurnCompletionItem } from '@session-chat/model';
import { flattenTier, planTurnFold, toolRunId, turnProcessId } from './flatten';
import { pendingPromptTurn } from './pending-prompt';
import { turnProcessLabel } from './turn-fold';

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

  // #6199 B2 真机:启动期推理档被拒收的那行通知落在首句那一轮里,一轮成功收尾后被折进「Took 15s」。
  describe('session-notice 不进折叠', () => {
    const notice = (id: string, at: number): ChatItem =>
      ({ kind: 'session-notice', id, seq: 0, code: 'effort-unavailable', detail: 'x', effectiveValue: 'low', at } as unknown as ChatItem);

    it('首句 → 通知 → 回复:整轮不折,通知照常看得见', () => {
      expect(planTurnFold(turn('t', [user('u'), notice('n', 1_000), reply('a1')], DONE))).toBeNull();
    });

    it('过程中间的通知留在外面,之后另起一段', () => {
      const plan = planTurnFold(turn('t', [user('u'), tool('c1'), notice('n', 1_000), tool('c2'), reply('a1')], DONE))!;
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

  it('agent 自发的一轮不套头:完成通知、后续 cycle 平铺,语义折叠就是它的折叠(「这就已经算折叠了」)', () => {
    // 没有用户开场白、initiator 是 agent —— 比如后台子智能体跑完那一轮。
    const notified = turn('t10', [row('subagent-done-tool-call', 'd1'), row('subagent-done-tool-call', 'd2'), thinking('th10')], DONE);
    const units = flattenTier([notified], ctxWith({ foldTurnProcess: true }), SEGMENTERS);
    expect(kinds(units)).not.toContain('turn-process');
    // 思考也进这一句(#7316,owner 10-16),所以两条「跑完了」和那一段思考是同一行。
    expect(ids(units)).toEqual([toolRunId('t10', 'd1')]);
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

  // owner 10-07:上游首字节常常几十秒,那段时间里这一轮只有用户那一句 —— 头从这一刻就在数(`pendingTurnHeader`)。
  it.each([true, false])('活动层只有用户那一句:时间头已经在数,id 就是过程折叠的头(foldTurnProcess=%s)', (fold) => {
    const live = turn('t12', [user('u12')], undefined, { startedAt: 7_000 });
    const units = flattenTier([live], ctxWith({ foldTurnProcess: fold, active: true }), SEGMENTERS);
    expect(ids(units)).toEqual(['u12', turnProcessId('t12')]);
    expect(header(units)).toMatchObject({ live: true, startedAt: 7_000, turnId: 't12' });
    // 思考一到,双栏里它落在同一个头下面
    const withThinking = flattenTier([{ ...live, items: [user('u12'), thinking('th12')] as TranscriptTurn['items'] }], ctxWith({ foldTurnProcess: true, active: true }), SEGMENTERS);
    expect(ids(withThinking)).toEqual(['u12', turnProcessId('t12'), 'th12']);
  });

  // 乐观行(发出了、真的那一轮还没开出,新会话可能还在建立):带着发出时刻只为日期分隔(那一格见
  // session-start-first-message.contract),时间头 ❌ 计时 —— 还没有可计的一轮,只说「处理中」。
  it('乐观行:时间头在跑但不计时', () => {
    const sentAt = new Date(2026, 9, 16, 9, 30).getTime();
    const units = flattenTier([pendingPromptTurn({ id: 'p1', text: 'hi', sentAt })], ctxWith({ foldTurnProcess: true, active: true }), SEGMENTERS);
    expect(ids(units)).toEqual(['p1', turnProcessId('pending:p1:turn')]);
    expect(header(units)).toMatchObject({ live: true });
    expect(header(units)).not.toHaveProperty('startedAt');
    // 阳控:同样形状的真一轮,时间头从它的起点数
    const real = flattenTier([turn('t15', [user('u15')], undefined, { startedAt: sentAt })], ctxWith({ foldTurnProcess: true, active: true }), SEGMENTERS);
    expect(header(real)).toMatchObject({ live: true, startedAt: sentAt });
  });

  it('❌ 已经开口的活动轮、落定的轮都没有这个空头', () => {
    const talking = turn('t13', [user('u13'), reply('a13', 'on it')], undefined, { startedAt: 7_000 });
    expect(kinds(flattenTier([talking], ctxWith({ foldTurnProcess: true, active: true }), SEGMENTERS))).not.toContain('turn-process');
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
  it('跑着但不知道起点 ⇒ 处理中,❌ 编一个时长', () => {
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
