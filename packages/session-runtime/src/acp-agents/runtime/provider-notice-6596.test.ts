import { decodeSessionUpdate } from '@gugu/session-core/acp';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { TranscriptSessionNotice, TranscriptTurn } from '@gugu/session-core/acp';
import { describe, expect, it, vi } from 'vitest';
import { until } from '../../../../../tests/support/awaitCondition';
import { makeAcpHarness, makeStartInput } from '../acp-test-support';
import { AcpRuntime } from './runtime';

/**
 * #6596 —— 按了后台命令的停止键,会话一直 working、下一句永远排队。
 *
 * 根因:桥接的提示(「Task stopped by user」等)在没声明 `session.notices` 时伪装成一段不带
 * messageId 的 agent 文本;闲着时来一条,就开出一段没人收口的活。
 * 现在声明了能力,提示以 `notice` 来、解成 `session_notice`:它是会话里发生的一件事,
 * 闲着时来就自成一组落定,agent 干活时来就归那一组 —— 按内容判,❌ 按是谁开的工判。
 */

const SESSION = 'session-1';
/** Notices are independent of the transport that supplies foreground facts. */
const REPORTS_STATE = {} as const;
const agentState = (state: 'running' | 'idle'): SessionUpdate =>
  ({ sessionUpdate: 'state_update', state }) as unknown as SessionUpdate;

/** claude 桥接 1.1.1 声明 notices 之后发的那 5 类;title 是 dist 源码里的原文。 */
const PROVIDER_NOTICES: Array<{ severity: string; title: string; description?: string }> = [
  { severity: 'info', title: 'Task stopped by user', description: 'sleep 613.' }, // async-tasks.js
  { severity: 'warning', title: 'Auto mode unavailable', description: 'The selected model does not support Auto mode; using Accept edits instead.' }, // session-mode.js
  { severity: 'warning', title: 'Fast mode turned off', description: 'Fast mode is not available for this model.' }, // acp-agent.js
  { severity: 'warning', title: 'Model fallback', description: 'claude-a declined this request; retried with claude-b.' }, // acp-agent.js
  { severity: 'warning', title: 'Stop hook blocked continuation.' }, // informational(warning),splitNoticeText 的形状
];

const notice = (n: (typeof PROVIDER_NOTICES)[number]): SessionUpdate =>
  ({ sessionUpdate: 'notice', ...n }) as unknown as SessionUpdate;

async function started(options: Parameters<typeof makeAcpHarness>[0] = REPORTS_STATE, sessionId = 'c') {
  const h = makeAcpHarness(options);
  const runtime = new AcpRuntime(h.deps);
  expect((await runtime.startSession(makeStartInput({ sessionId }))).success).toBe(true);
  return { h, runtime };
}

const noticesIn = (turn: TranscriptTurn | null | undefined): TranscriptSessionNotice[] =>
  (turn?.items ?? []).filter((item): item is TranscriptSessionNotice => item.kind === 'session-notice');

/** sendPrompt 只管交出去;等那一轮真落定(committed 到 n 条)再往下 —— 等「至少 n 条」,确切条数交给断言。 */
const committedCount = async (runtime: AcpRuntime, sessionId: string, n: number) => {
  await until(
    `${sessionId} has ${n} committed turn(s)`,
    () => runtime.getChatHistory(sessionId).committed.length,
    (count) => count >= n,
  );
  expect(runtime.getChatHistory(sessionId).committed).toHaveLength(n);
};

/** 挂住下一次 prompt,返回放行函数。 */
function holdPrompt(h: ReturnType<typeof makeAcpHarness>): () => void {
  let release!: () => void;
  h.agent.prompt = vi
    .fn()
    .mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ stopReason: 'end_turn' }); }))
    .mockResolvedValue({ stopReason: 'end_turn' });
  return () => release();
}

describe('#6596 供应商提示(notice)', () => {
  it('握手声明 session.notices —— 不声明,桥接就把提示伪装成不带 messageId 的 agent 文本', async () => {
    const { h, runtime } = await started();
    try {
      const request = h.agent.initialize.mock.calls[0]![0] as { clientCapabilities: { session?: unknown } };
      expect(request.clientCapabilities.session).toEqual({ compaction: {}, notices: {} });
    } finally { await runtime.dispose(); }
  });

  it('闲着时来:5 类各自成一轮落定,不开自发轮,下一句立刻发出', async () => {
    const { h, runtime } = await started();
    try {
      await runtime.sendPrompt('c', { text: 'hi', origin: 'typed' });
      await committedCount(runtime, 'c', 1);
      for (const [i, n] of PROVIDER_NOTICES.entries()) {
        await h.client().sessionEvent({ sessionId: SESSION, event: decodeSessionUpdate(notice(n)) });
        const history = runtime.getChatHistory('c');
        expect(history.active, n.title).toBeNull();
        expect(history.committed).toHaveLength(2 + i);
        expect(noticesIn(history.committed.at(-1))).toEqual([
          expect.objectContaining({ code: 'provider-notice', title: n.title, detail: n.description ?? n.title }),
        ]);
        const state = runtime.getSessionState('c');
        expect(state.lifecycle, n.title).toBe('ready');
        expect(state.canCancel, n.title).toBe(false);
      }
      await runtime.sendPrompt('c', { text: 'next', origin: 'typed' });
      await h.agent.called('prompt', 2);
      expect(h.agent.prompt).toHaveBeenCalledTimes(2);
      expect(runtime.getSessionState('c').queuedPrompts, '下一句不排队').toEqual([]);
    } finally { await runtime.dispose(); }
  });

  it('停后台命令:「跑完了」那一行先懒开一轮,notice 归进去、当场一起落定(❌ 开到下一句才提交)', async () => {
    const { h, runtime } = await started();
    try {
      const release = holdPrompt(h);
      const sent = runtime.sendPrompt('c', { text: 'sleep 711 in the background', origin: 'typed' });
      await h.agent.called('prompt');
      expect(h.agent.prompt).toHaveBeenCalledOnce();
      await h.client().sessionEvent({
        sessionId: SESSION,
        event: decodeSessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 'call_bg', title: 'sleep 711', kind: 'execute', status: 'completed' } as SessionUpdate),
      });
      await h.client().sessionEvent({
        sessionId: SESSION,
        event: decodeSessionUpdate({ sessionUpdate: 'async_task_progress', asyncTaskId: 'bg-1', toolCallId: 'call_bg' } as unknown as SessionUpdate),
      });
      release();
      await sent;
      await committedCount(runtime, 'c', 1);

      // 桥接 stopAsyncTask 的顺序:先发终态,再发 notice(async-tasks.js taskStopped)。
      await h.client().sessionEvent({
        sessionId: SESSION,
        event: decodeSessionUpdate({ sessionUpdate: 'async_task_state_update', asyncTaskId: 'bg-1', state: 'stopped' } as unknown as SessionUpdate),
      });
      const lazy = runtime.getChatHistory('c').active;
      expect(lazy?.items.map((item) => item.kind), '前提:「跑完了」那一行懒开了一组').toEqual(['background-command-done-tool-call']);
      expect(runtime.getSessionState('c').lifecycle).toBe('ready');

      await h.client().sessionEvent({ sessionId: SESSION, event: decodeSessionUpdate(notice(PROVIDER_NOTICES[0]!)) });
      const { committed, active } = runtime.getChatHistory('c');
      expect(active, '那一轮当场落定').toBeNull();
      expect(committed).toHaveLength(2);
      expect(committed[1]!.items.map((item) => item.kind)).toEqual(['background-command-done-tool-call', 'session-notice']);
      await runtime.sendPrompt('c', { text: 'next', origin: 'typed' });
      await h.agent.called('prompt', 2);
      expect(h.agent.prompt).toHaveBeenCalledTimes(2);
      expect(runtime.getSessionState('c').queuedPrompts).toEqual([]);
    } finally { await runtime.dispose(); }
  });

  it('对照家(没声明自发轮):同样自成一轮,❌ 当成上一轮的尾巴', async () => {
    const { h, runtime } = await started({});
    try {
      await runtime.sendPrompt('c', { text: 'hi', origin: 'typed' });
      await committedCount(runtime, 'c', 1);
      await h.client().sessionEvent({ sessionId: SESSION, event: decodeSessionUpdate(notice(PROVIDER_NOTICES[0]!)) });
      const { committed, active } = runtime.getChatHistory('c');
      expect(active).toBeNull();
      expect(committed).toHaveLength(2);
      expect(noticesIn(committed[0]), '不折进答完的那一轮').toEqual([]);
      expect(noticesIn(committed[1])).toHaveLength(1);
      expect(runtime.getSessionState('c').lifecycle).toBe('ready');
    } finally { await runtime.dispose(); }
  });

  it('prompt 在跑时来:归那一轮,不另起一轮', async () => {
    const { h, runtime } = await started();
    try {
      const release = holdPrompt(h);
      const sent = runtime.sendPrompt('c', { text: 'sleep 25', origin: 'typed' });
      await h.agent.called('prompt');
      expect(h.agent.prompt).toHaveBeenCalledOnce();
      await h.client().sessionEvent({ sessionId: SESSION, event: decodeSessionUpdate(notice(PROVIDER_NOTICES[0]!)) });
      expect(runtime.getChatHistory('c').committed, '回合中不单独落一轮').toHaveLength(0);
      expect(noticesIn(runtime.getChatHistory('c').active)).toHaveLength(1);
      release();
      await sent;
      await committedCount(runtime, 'c', 1);
      const { committed, active } = runtime.getChatHistory('c');
      expect(active).toBeNull();
      expect(committed).toHaveLength(1);
      expect(committed[0]!.initiator).toBe('user');
      expect(noticesIn(committed[0])).toHaveLength(1);
    } finally { await runtime.dispose(); }
  });

  it('agent 自己开工时来:归那一组,agent 报 idle 时一起落定', async () => {
    const { h, runtime } = await started();
    try {
      await h.client().sessionEvent({ sessionId: SESSION, event: decodeSessionUpdate(agentState('running')) });
      expect(runtime.getSessionState('c').lifecycle).toBe('working');
      await h.client().sessionEvent({
        sessionId: SESSION,
        event: decodeSessionUpdate({ sessionUpdate: 'agent_message_chunk', messageId: 'resp_1', content: { type: 'text', text: '子任务跑完了' } } as SessionUpdate),
      });
      await h.client().sessionEvent({ sessionId: SESSION, event: decodeSessionUpdate(notice(PROVIDER_NOTICES[3]!)) });
      expect(runtime.getChatHistory('c').committed).toHaveLength(0);
      expect(noticesIn(runtime.getChatHistory('c').active)).toHaveLength(1);
      // 带 cost 的 usage 不再是「停了」:只有 agent 报的 idle 是。
      await h.client().sessionEvent({
        sessionId: SESSION,
        event: decodeSessionUpdate({ sessionUpdate: 'usage_update', used: 1, size: 200_000, cost: { amount: 0.01, currency: 'USD' } } as unknown as SessionUpdate),
      });
      expect(runtime.getSessionState('c').lifecycle).toBe('working');
      await h.client().sessionEvent({ sessionId: SESSION, event: decodeSessionUpdate(agentState('idle')) });
      const { committed } = runtime.getChatHistory('c');
      expect(committed).toHaveLength(1);
      expect(committed[0]!.initiator).toBe('agent');
      expect(noticesIn(committed[0])).toHaveLength(1);
      expect(runtime.getSessionState('c').lifecycle).toBe('ready');
    } finally { await runtime.dispose(); }
  });

  it('同一轮里连来两条是两件事:两行,❌ 按 code 并成一行', async () => {
    const { h, runtime } = await started();
    try {
      const release = holdPrompt(h);
      const sent = runtime.sendPrompt('c', { text: 'stop both', origin: 'typed' });
      await h.agent.called('prompt');
      expect(h.agent.prompt).toHaveBeenCalledOnce();
      await h.client().sessionEvent({ sessionId: SESSION, event: decodeSessionUpdate(notice(PROVIDER_NOTICES[0]!)) });
      await h.client().sessionEvent({ sessionId: SESSION, event: decodeSessionUpdate(notice({ ...PROVIDER_NOTICES[0]!, description: 'sleep 614.' })) });
      release();
      await sent;
      await committedCount(runtime, 'c', 1);
      const rows = noticesIn(runtime.getChatHistory('c').committed[0]);
      expect(rows.map((row) => row.detail)).toEqual(['sleep 613.', 'sleep 614.']);
      expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    } finally { await runtime.dispose(); }
  });

  it('a domain notice enters directly without creating a tool row', async () => {
    const { h, runtime } = await started();
    try {
      await h.client().sessionEvent({ sessionId: SESSION,
        event: decodeSessionUpdate({ sessionUpdate: 'notice', ...PROVIDER_NOTICES[0]! }) });
      expect(runtime.getChatHistory('c').committed.flatMap(turn => turn.items).map(item => item.kind))
        .toEqual(['session-notice']);
      expect(runtime.getSessionState('c').lifecycle).toBe('ready');
    } finally { await runtime.dispose(); }
  });});

/**
 * 我们自己合成的 notice(改名、启动时的模型/推理档回退)走的是同一条规则 —— 这次**没改**那条规则,
 * 只让供应商提示也进了它。这组钉住三种状态下的行为与改之前一致(同一组用例在 dev 上照样绿)。
 */
describe('#6596 合成的 notice:starting / prompt 在跑 / 空闲 三种状态行为不变', () => {
  const renamed = {
    code: 'agent-renamed' as const,
    detail: '"Claude 29" had already been used; registered as "Claude 30"',
    previousValue: 'Claude 29',
    effectiveValue: 'Claude 30',
  };

  it('starting:等就绪之后自成一轮,不叫 agent', async () => {
    const h = makeAcpHarness(REPORTS_STATE);
    const modelOptions = [{
      id: 'model', name: 'Model', category: 'model' as const, type: 'select' as const,
      currentValue: 'model-a', options: [{ value: 'model-a', name: 'A' }, { value: 'model-b', name: 'B' }],
    }];
    h.agent.newSession.mockResolvedValue({ sessionId: SESSION, configOptions: modelOptions });
    let releaseModel!: () => void;
    h.agent.setSessionConfigOption.mockImplementationOnce(() => new Promise((resolve) => {
      releaseModel = () => resolve({ configOptions: modelOptions.map((o) => ({ ...o, currentValue: 'model-b' })) });
    }));
    const runtime = new AcpRuntime(h.deps);
    try {
      const start = runtime.startSession(makeStartInput({ sessionId: 's', model: 'model-b' }));
      await h.agent.called('setSessionConfigOption');
      expect(runtime.announceSession({ sessionId: 's', notice: renamed })).toEqual({ delivered: true });
      expect(JSON.stringify(runtime.getChatHistory('s'))).not.toContain('agent-renamed');
      releaseModel();
      expect((await start).success).toBe(true);
      await until('the held notice is drawn once the session is ready', () =>
        JSON.stringify(runtime.getChatHistory('s')).includes('agent-renamed'));
      const { committed, active } = runtime.getChatHistory('s');
      expect(active).toBeNull();
      expect(committed.filter((turn) => noticesIn(turn).length > 0)).toHaveLength(1);
      expect(h.agent.prompt).not.toHaveBeenCalled();
      expect(runtime.getSessionState('s').lifecycle).toBe('ready');
    } finally { await runtime.dispose(); }
  });

  it('prompt 在跑:归那一轮', async () => {
    const { h, runtime } = await started();
    try {
      const release = holdPrompt(h);
      const sent = runtime.sendPrompt('c', { text: 'hi', origin: 'typed' });
      await h.agent.called('prompt');
      expect(h.agent.prompt).toHaveBeenCalledOnce();
      expect(runtime.announceSession({ sessionId: 'c', notice: renamed })).toEqual({ delivered: true });
      expect(runtime.getChatHistory('c').committed).toHaveLength(0);
      expect(noticesIn(runtime.getChatHistory('c').active)).toHaveLength(1);
      release();
      await sent;
      await committedCount(runtime, 'c', 1);
      const { committed } = runtime.getChatHistory('c');
      expect(committed).toHaveLength(1);
      expect(noticesIn(committed[0])).toEqual([expect.objectContaining({ code: 'agent-renamed' })]);
    } finally { await runtime.dispose(); }
  });

  it('空闲:当场自成一轮,不开自发轮,下一句立刻发出', async () => {
    const { h, runtime } = await started();
    try {
      await runtime.sendPrompt('c', { text: 'hi', origin: 'typed' });
      await committedCount(runtime, 'c', 1);
      expect(runtime.announceSession({ sessionId: 'c', notice: renamed })).toEqual({ delivered: true });
      const { committed, active } = runtime.getChatHistory('c');
      expect(active).toBeNull();
      expect(committed).toHaveLength(2);
      expect(noticesIn(committed[1])).toEqual([expect.objectContaining({ code: 'agent-renamed' })]);
      expect(runtime.getSessionState('c').lifecycle).toBe('ready');
      await runtime.sendPrompt('c', { text: 'next', origin: 'typed' });
      await h.agent.called('prompt', 2);
      expect(h.agent.prompt).toHaveBeenCalledTimes(2);
      expect(runtime.getSessionState('c').queuedPrompts).toEqual([]);
    } finally { await runtime.dispose(); }
  });
});
