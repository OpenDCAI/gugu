/**
 * #6191 —— 协议层回放:Stop 之后跟来一条 agent 文本。
 *
 * 真机(copilot · Work)上这条序列只在一部分次数里出现(原票 1/2):权限请求挂着时点 Stop →
 * `session/prompt` 答 `cancelled` → 之后 copilot 又推一条「Info: Operation cancelled by user」。
 * 这里把同一条序列按协议喂给**真实的** runtime + cell(经 ACP client 的 `sessionUpdate`,
 * 与 stdio 进来的通知同一条路),让它每次都发生:
 *   - 不自报状态的家(copilot 那种):那条尾巴归被停的那一段,会话不再变忙,追问直接发出 ——
 *     修复前这里恒卡死(canCancel 常亮、追问进队列)。
 *   - 自报状态的家(claude 桥接 1.3.0 起):它报 running 才忙、报 idle 才停(阴控)。
 */
import { describe, expect, it, vi } from 'vitest';
import { until } from '../../../../../tests/support/awaitCondition';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { isOk } from '@gugu/session-shared';
import { noopLogger } from '@gugu/session-shared/logger';
import { makeAcpHarness, makeStartInput } from '../acp-test-support';
import { AcpRuntime } from './runtime';

const SESSION = 'session-1';
const text = (t: string) =>
  ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } }) as SessionUpdate;
const agentState = (state: 'running' | 'idle') =>
  ({ sessionUpdate: 'state_update', state }) as unknown as SessionUpdate;

type Committed = { source: string; turnId: string; text: string };

async function stopWithPendingPermission(
  sessionId: string,
  reportsState = false,
  committed: Committed[] = [],
) {
  const h = makeAcpHarness({
    reportsState,
    onTurnCommitted: ({ source, turn }) =>
      committed.push({ source, turnId: turn.id, text: JSON.stringify(turn.items) }),
  });
  const rt = new AcpRuntime(h.deps);
  expect(isOk(await rt.startSession(makeStartInput({ sessionId })))).toBe(true);
  const client = h.client();

  let resolvePrompt!: (value: { stopReason: string }) => void;
  h.agent.prompt = vi
    .fn()
    .mockImplementationOnce(() => new Promise((resolve) => { resolvePrompt = resolve; }))
    .mockResolvedValue({ stopReason: 'end_turn' });

  const turn = rt.sendPrompt(sessionId, { text: 'Use your shell tool to run: sleep 120' });
  await h.agent.called('prompt');
  expect(h.agent.prompt).toHaveBeenCalledTimes(1);
  // 自报状态的桥接收下 prompt 就报 running(每次真机读数都是这个顺序)。
  if (reportsState) await client.sessionUpdate({ sessionId: SESSION, update: agentState('running') });
  await client.sessionUpdate({
    sessionId: SESSION,
    update: { sessionUpdate: 'tool_call', toolCallId: 'call_sleep', title: 'sleep 120', kind: 'execute', status: 'pending' } as SessionUpdate,
  });
  const permission = client.requestPermission({
    sessionId: SESSION,
    toolCall: { toolCallId: 'call_sleep', title: 'sleep 120', kind: 'execute' },
    options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
  } as never);
  await until(
    'permission request is pending',
    () => rt.getSessionState(sessionId).pendingPermissions.length,
    (count) => count >= 1,
  );
  expect(rt.getSessionState(sessionId).pendingPermissions).toHaveLength(1);

  await rt.cancelTurn(sessionId);
  await expect(permission).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
  resolvePrompt({ stopReason: 'cancelled' });
  await turn;
  if (reportsState) await client.sessionUpdate({ sessionId: SESSION, update: agentState('idle') });
  expect(rt.getSessionState(sessionId).canCancel, 'Stop 落定').toBe(false);
  return { h, rt, client };
}

describe('#6191 Stop 之后的尾随 agent 文本', () => {
  it('没声明自发轮的家:尾巴归被停的那一轮,停止键不再亮,追问立刻发出', async () => {
    const { h, rt, client } = await stopWithPendingPermission('conv-copilot-shape');

    await client.sessionUpdate({ sessionId: SESSION, update: text('Info: Operation cancelled by user') });

    const state = rt.getSessionState('conv-copilot-shape');
    expect(state.canCancel, '停止键不许重新亮').toBe(false);
    expect(state.isGenerating).toBe(false);

    const history = rt.getHistory('conv-copilot-shape');
    expect(isOk(history)).toBe(true);
    if (!isOk(history)) return;
    const stopped = history.data.turns.at(-1)!;
    expect(stopped.outcome?.kind, '尾巴在被停的那一轮里,结局不变').toBe('cancelled');
    expect(JSON.stringify(stopped.items)).toContain('Info: Operation cancelled by user');

    await rt.sendPrompt('conv-copilot-shape', { text: 'K4' });
    expect(h.agent.prompt, '追问直接发给 agent,不排队').toHaveBeenCalledTimes(2);
    expect(rt.getSessionState('conv-copilot-shape').queuedPrompts).toEqual([]);
  });

  it('阴控 —— 自报状态的家(claude 桥接 1.3.0):它自己开工就忙,报 idle 才停', async () => {
    const { rt, client } = await stopWithPendingPermission('conv-claude-shape', true);

    await client.sessionUpdate({ sessionId: SESSION, update: agentState('running') });
    await client.sessionUpdate({ sessionId: SESSION, update: text('子任务跑完了') });
    expect(rt.getSessionState('conv-claude-shape').canCancel).toBe(true);

    await client.sessionUpdate({ sessionId: SESSION, update: agentState('idle') });
    expect(rt.getSessionState('conv-claude-shape').canCancel).toBe(false);
  });

  it('尾巴随被停那一轮的修订落盘 —— 那一轮是本次会话 live 落过盘的', async () => {
    const committed: Committed[] = [];
    const { client } = await stopWithPendingPermission('conv-persist', undefined, committed);
    const stoppedId = committed.at(-1)!.turnId;

    await client.sessionUpdate({ sessionId: SESSION, update: text('Info: Operation cancelled by user') });

    expect(committed.map((entry) => entry.source)).toEqual(['live', 'revision']);
    expect(committed[1]!.turnId).toBe(stoppedId);
    expect(committed[1]!.text).toContain('Info: Operation cancelled by user');
  });

  /**
   * 评审 #1:运行时回合 id 每次重开从 0 重数。重放回来的那一轮本次会话没落过盘,库里同 id 的行
   * 属于上一次会话的另一轮 —— 修订它就是改写别人的历史。⇒ 不修订、响亮记错。
   * 评审 #2:重放收口时段计数不许清零,否则尾巴的合成 id 撞上重放那一轮的第一条消息、被并进去。
   */
  it('重放回来的那一轮收到尾巴:不修订库里的行、响亮记错;尾巴另起一条消息', async () => {
    const committed: Committed[] = [];
    const error = vi.fn();
    const h = makeAcpHarness({
      logger: { ...noopLogger, error },
      onTurnCommitted: ({ source, turn }) =>
        committed.push({ source, turnId: turn.id, text: JSON.stringify(turn.items) }),
    });
    const rt = new AcpRuntime(h.deps);
    h.agent.loadSession = vi.fn(async () => {
      await h.client().sessionUpdate({ sessionId: 'session-old', update: text('重放回来的正文') });
      return {};
    });
    expect(isOk(await rt.resumeSession({ ...makeStartInput({ sessionId: 'conv-replayed' }), providerSessionId: 'session-old' }))).toBe(true);
    expect(committed.map((entry) => entry.source)).toEqual(['replay']);

    await h.client().sessionUpdate({ sessionId: 'session-old', update: text('迟到的尾巴') });

    expect(committed.map((entry) => entry.source), '不发修订').toEqual(['replay']);
    expect(error).toHaveBeenCalledWith(
      'SessionManager: revised a turn this session did not persist; stored history left unchanged',
      expect.objectContaining({ sessionId: 'conv-replayed' }),
    );
    const history = rt.getHistory('conv-replayed');
    expect(isOk(history)).toBe(true);
    if (!isOk(history)) return;
    const texts = history.data.turns
      .at(-1)!
      .items.filter((item) => item.kind === 'message')
      .map((item) => (item as { text: string }).text);
    expect(texts).toEqual(['重放回来的正文', '迟到的尾巴']);
    expect(rt.getSessionState('conv-replayed').canCancel).toBe(false);
  });
});
