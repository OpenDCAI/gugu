import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@gugu/session-core/acp';
import type { SessionWriteTarget } from './write-bridge';

/**
 * 手机往一条 ACP 会话里回话:引擎活着直接投;不活先唤醒再投;没接唤醒通道就如实报。
 *
 * owner 2026-09-06 真机:app 重启过之后,手机回复任何一条老会话都报「这条没发出去 <会话id>
 * (send_failed)」—— 运行时里已经没有这条会话。桌面端点进去会自动唤醒,手机端不该少这一步。
 * 三条判据各防一种失败:活着却唤醒(重复拉起)/ 不活却不唤醒(回到那条 send_failed)/
 * 没通道却假装投出去。
 */
const state = vi.hoisted(() => ({
  summaries: {} as Record<string, SessionSummary>,
  calls: [] as string[],
  /** 终端腿:sendMessage 前 N 次抛「不活」(真实的 sendMessage 已经唤醒过、仍没起来)。 */
  ptyNotLiveTimes: 0,
  sentParams: [] as unknown[],
  sendStatus: 'accepted' as 'accepted' | 'queued' | 'outcome-unknown',
  /** sendMessage 收到的正文。 */
  sentTexts: [] as string[],
  /** 取消键写进 pty 的结果;默认写进去了。 */
  cancelResult: { success: true, data: { written: 1 } } as unknown,
  warnings: [] as unknown[],
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: (_msg: string, data: unknown) => state.warnings.push(data), info: () => {}, error: () => {} } }));

vi.mock('@main/core/acp/runtime-process/host', () => ({
  getAcpRuntimeClient: async () => ({
    promptDetached: async () => { throw new Error('Mobile text must use the session message router'); },
  }),
}));
vi.mock('@main/core/acp/session-summary-reader', () => ({
  readAcpSessionSummaries: async () => state.summaries,
}));
vi.mock('@main/core/pty/answer-question', () => ({
  writeKeyBeats: async (_pty: string, writes: string[]) => {
    state.calls.push(`key:${JSON.stringify(writes)}`);
    return state.cancelResult;
  },
}));
vi.mock('@main/core/sessions/sendMessage', () => ({
  sendMessage: async (params: { text: string }) => {
    state.calls.push('send');
    state.sentParams.push(params);
    state.sentTexts.push(params.text);
    if (state.ptyNotLiveTimes > 0) {
      state.ptyNotLiveTimes -= 1;
      throw Object.assign(new Error('[SESSION_DIRECT_NOT_LIVE] target session is not live: conv-1'), {
        code: 'SESSION_DIRECT_NOT_LIVE',
      });
    }
    return { id: 'm1', status: state.sendStatus };
  },
}));

const bridge = await import('./write-bridge');

const target = {
  id: 'conv-1',
  runtime: 'acp',
  projectId: 'p',
} as unknown as SessionWriteTarget;

function summary(lifecycle: string): SessionSummary {
  return { sessionId: 'conv-1', lifecycle } as unknown as SessionSummary;
}

const ptyTarget = { ...target, runtime: 'pty' } as unknown as SessionWriteTarget;

beforeEach(() => {
  state.summaries = {};
  state.calls = [];
  state.ptyNotLiveTimes = 0;
  state.sentTexts = [];
  state.sentParams = [];
  state.sendStatus = 'accepted';
  state.warnings = [];
  state.cancelResult = { success: true, data: { written: 1 } };
  bridge.setSessionWake(null);
});

// #6546 冷着的终端腿由 session-direct 的路由自己唤醒再投;写侧只走 sendMessage 这一条路。
describe('终端腿(pty)回话:唤醒归 session-direct 的路由', () => {
  it('活着 → 一次投出去', async () => {
    const result = await bridge.deliverSessionText(ptyTarget, '继续');
    expect(state.calls).toEqual(['send']);
    expect(result.accepted).toBe('started');
  });

  it('路由唤醒过仍不活 → 原样抛(带原因),❌ 写侧再拉一遍', async () => {
    state.ptyNotLiveTimes = 1;
    await expect(bridge.deliverSessionText(ptyTarget, '继续')).rejects.toMatchObject({
      code: 'SESSION_DIRECT_NOT_LIVE',
    });
    expect(state.calls).toEqual(['send']);
  });
});

describe('mobile ACP replies use the shared session message router', () => {
  it.each(['starting', 'working', 'closed', 'lost'])(
    'delegates %s sessions without a separate ACP wake or prompt path', async (lifecycle) => {
      state.summaries = { s: summary(lifecycle) };
      bridge.setSessionWake(async () => { throw new Error('Wake belongs to the shared router'); });
      const text = 'Check this result.\nKeep the original wording.';
      expect(await bridge.deliverSessionText(target, `  ${text}  `)).toEqual({ accepted: 'started' });
      expect(state.calls).toEqual(['send']);
      expect(state.sentParams).toEqual([{
        projectId: 'p', sessionId: 'conv-1', clientMessageId: expect.any(String), text, kind: 'session-direct',
      }]);
    },
  );

  it('preserves the shared router receipt and failure', async () => {
    state.sendStatus = 'queued';
    expect(await bridge.deliverSessionText(target, 'continue')).toEqual({ accepted: 'queued' });
    state.sendStatus = 'outcome-unknown';
    await expect(bridge.deliverSessionText(target, 'continue')).rejects.toMatchObject({ code: 'session_not_live' });
    state.ptyNotLiveTimes = 1;
    await expect(bridge.deliverSessionText(target, 'continue')).rejects.toMatchObject({ code: 'SESSION_DIRECT_NOT_LIVE' });
  });
});

describe('确认 ACP 引擎活着（参数与审批入口）', () => {
  it('活着(含 starting)→ 直接投,❌ 不再唤醒一次', async () => {
    state.summaries = { s: summary('starting') };
    bridge.setSessionWake(async () => { state.calls.push('wake'); });
    await bridge.ensureAcpSessionLive(target.id);
    expect(state.calls).toEqual([]);
  });

  it('closed / 根本没有这条 → 先唤醒再投,顺序不能反', async () => {
    state.summaries = { s: summary('closed') };
    bridge.setSessionWake(async () => { state.calls.push('wake'); });
    await bridge.ensureAcpSessionLive(target.id);
    expect(state.calls).toEqual(['wake']);

    state.calls = [];
    state.summaries = { s: { ...summary('ready'), closing: true } };
    expect(await bridge.acpSessionLive('conv-1')).toBe(false);
    await bridge.ensureAcpSessionLive(target.id);
    expect(state.calls).toEqual(['wake']);

    // 编号 5:适配器自己退了(lost)也不活 —— 唤醒接回原会话再投,❌ 直接投进死掉的适配器。
    state.calls = [];
    state.summaries = { s: summary('lost') };
    expect(await bridge.acpSessionLive('conv-1')).toBe(false);
    await bridge.ensureAcpSessionLive(target.id);
    expect(state.calls).toEqual(['wake']);

    state.calls = [];
    state.summaries = {};
    await bridge.ensureAcpSessionLive(target.id);
    expect(state.calls).toEqual(['wake']);
  });

  it('阴控:不活又没接唤醒通道 → session_not_live,且**没有**投出去', async () => {
    state.summaries = {};
    await expect(bridge.ensureAcpSessionLive(target.id)).rejects.toMatchObject({
      name: 'SessionWriteError',
      code: 'session_not_live',
    });
    expect(state.calls).toEqual([]);
  });

  it('唤醒失败 → session_wake_failed 带原因,❌ 不吞成一串会话 id', async () => {
    state.summaries = {};
    bridge.setSessionWake(async () => { throw new Error('workspace is not mounted'); });
    await expect(bridge.ensureAcpSessionLive(target.id)).rejects.toMatchObject({
      code: 'session_wake_failed',
      message: expect.stringContaining('workspace is not mounted'),
    });
    expect(state.calls).toEqual([]);
  });
});

// #7035 终端提问:写取消键关掉选择器 → 等记录里有结果 → 回答当消息发出去。
describe('终端提问:取消键 + 把回答当消息发回', () => {
  const questions = [
    { question: '去哪?', multiSelect: false, options: [{ optionId: '北京', name: '北京' }, { optionId: '上海', name: '上海' }] },
    { question: '带谁?', multiSelect: true, options: [{ optionId: '猫', name: '猫' }, { optionId: '狗', name: '狗' }, { optionId: '鸟', name: '鸟' }] },
  ];
  const claudeTarget = { ...ptyTarget, providerId: 'claude' } as unknown as SessionWriteTarget;
  /** 记录:前 `openPolls` 次问还开着,之后关上。 */
  function closesAfter(openPolls: number) {
    let polls = 0;
    return async () => {
      state.calls.push('poll');
      polls += 1;
      return polls <= openPolls;
    };
  }

  it('回答写成一句话:每题一行,多选用顿号,自己写的标出来', () => {
    expect(bridge.questionAnswerText(questions, [{ selected: [], other: ' 紫禁城 ' }, { selected: ['猫', '鸟'] }])).toBe(
      '我在咕咕的提问卡里回答了你刚才的提问(终端里的选择框已经替我关掉了):\n'
        + '- 去哪? → (我自己写的)紫禁城\n'
        + '- 带谁? → 猫、鸟'
    );
  });

  it('多选一项都不勾是合法回答;多选也能自己写', () => {
    expect(bridge.questionAnswerText(questions, [{ selected: ['上海'] }, { selected: [] }])).toContain('- 带谁? → (一项都没选)');
    expect(bridge.questionAnswerText(questions, [{ selected: ['上海'] }, { selected: ['猫'], other: '还有仓鼠' }])).toContain('- 带谁? → 猫;(我自己写的)还有仓鼠');
  });

  it('回答与题目对不上 ⇒ answer_invalid,❌ 猜着补', () => {
    for (const answers of [
      [{ selected: ['北京'] }],
      [{ selected: ['广州'] }, { selected: ['猫'] }],
      [{ selected: [], other: '  ' }, { selected: ['猫'] }],
    ]) {
      expect(() => bridge.questionAnswerText(questions, answers)).toThrow(expect.objectContaining({ code: 'answer_invalid' }));
    }
  });

  it('prepare:取消键取自声明,拒答没有回答正文', () => {
    const prepared = bridge.prepareQuestionAnswer(claudeTarget, questions, 'decline');
    expect(prepared).toEqual({ cancel: { key: '\u001b', settleMs: 20, maxWaitMs: 2000 }, text: null });
  });

  it('没声明取消键的家 ⇒ no_question_channel', () => {
    const copilot = { ...ptyTarget, providerId: 'copilot' } as unknown as SessionWriteTarget;
    expect(() => bridge.prepareQuestionAnswer(copilot, questions, 'decline')).toThrow(expect.objectContaining({ code: 'no_question_channel' }));
  });

  it('次序:先写取消键,等记录里这道题关上,才发回答', async () => {
    const prepared = bridge.prepareQuestionAnswer(claudeTarget, questions, [{ selected: ['北京'] }, { selected: ['狗'] }]);
    const result = await bridge.deliverQuestionAnswer(claudeTarget, prepared, { askedAt: 1, stillOpen: closesAfter(2) });
    expect(result).toEqual({ ok: true });
    expect(state.calls).toEqual(['key:["\\u001b"]', 'poll', 'poll', 'poll', 'send']);
    expect(state.sentTexts[0]).toContain('- 去哪? → 北京');
  });

  it('拒答:只关选择器,不发消息', async () => {
    const prepared = bridge.prepareQuestionAnswer(claudeTarget, questions, 'decline');
    expect(await bridge.deliverQuestionAnswer(claudeTarget, prepared, { askedAt: 1, stillOpen: closesAfter(0) })).toEqual({ ok: true });
    expect(state.calls).toEqual(['key:["\\u001b"]', 'poll']);
  });

  it('取消键没写进去 ⇒ 原因带回,❌ 发回答', async () => {
    state.cancelResult = { success: false, error: { type: 'question_closed', written: 0 } };
    const prepared = bridge.prepareQuestionAnswer(claudeTarget, questions, [{ selected: ['北京'] }, { selected: ['狗'] }]);
    const result = await bridge.deliverQuestionAnswer(claudeTarget, prepared, { askedAt: 1, stillOpen: closesAfter(0) });
    expect(result).toMatchObject({ ok: false, written: 0, error: { code: 'question_closed' } });
    expect(state.sentTexts).toEqual([]);
  });

  it('写了取消键、记录里迟迟没有结果 ⇒ question_still_open,❌ 发回答', async () => {
    vi.useFakeTimers();
    try {
      const prepared = bridge.prepareQuestionAnswer(claudeTarget, questions, [{ selected: ['北京'] }, { selected: ['狗'] }]);
      const pending = bridge.deliverQuestionAnswer(claudeTarget, prepared, { askedAt: 1, stillOpen: async () => true });
      await vi.advanceTimersByTimeAsync(11_000);
      expect(await pending).toMatchObject({ ok: false, written: 1, error: { code: 'question_still_open' } });
      expect(state.sentTexts).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('选择器关了、回答没发出去 ⇒ answer_not_delivered,带上原因', async () => {
    state.ptyNotLiveTimes = 1;
    const prepared = bridge.prepareQuestionAnswer(claudeTarget, questions, [{ selected: ['北京'] }, { selected: ['狗'] }]);
    const result = await bridge.deliverQuestionAnswer(claudeTarget, prepared, { askedAt: 1, stillOpen: closesAfter(0) });
    expect(result).toMatchObject({ ok: false, written: 1, error: { code: 'answer_not_delivered' } });
    // 原因进日志,文案只留下一步(user-copy-leak-check)。
    expect(state.warnings).toEqual([expect.objectContaining({ error: expect.stringContaining('SESSION_DIRECT_NOT_LIVE') })]);
  });
});
