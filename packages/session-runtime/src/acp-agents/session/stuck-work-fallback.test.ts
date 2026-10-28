/*
 * 兜底(2026-10-28 主人撞到):自报状态的家(claude 桥接)一轮已经有了 stopReason,只剩后台命令在跑,
 * agent 却一直不报 idle ⇒ lifecycle 停在 working,用户的下一句进「排队」要手点「现在插入」。
 * 结局在手、静默窗口过了还没 idle ⇒ 按记下的结局落定。负对照:结局没到、等人批准、前台还在出东西、idle 按时来。
 */
import { noopLogger } from '@gugu/session-shared/logger';
import { isOk } from '@gugu/session-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAcpAgent } from '../acp-test-support';
import { SessionCell } from './cell';

const WINDOW_MS = 40;
// 假时钟:CI 机器忙时真定时器会把「窗口内有输出」挤成「窗口外」,断言就飘了。
const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);

function reportingCell() {
  const agent = new FakeAcpAgent();
  const onStuckWork = vi.fn();
  const logger = { ...noopLogger, warn: vi.fn() };
  const cell = new SessionCell({
    mergeEnvelopes: (texts) => texts.join('\n'),
    sessionId: 'conv-1',
    projectId: 'proj-1',
    providerId: 'claude',
    acpSessionId: 'session-1',
    agent,
    resolveAttachment: vi.fn().mockResolvedValue({ data: '', mimeType: 'image/png' }),
    logger,
    onStuckWork,
    stuckWorkFallbackMs: WINDOW_MS,
  });
  cell.applySessionReady();
  cell.setReportsState(true);
  return { cell, agent, onStuckWork, logger };
}

/** 发一句、agent 报 running、出一段正文;返回「让请求答复」的开关。 */
async function startTurn(cell: SessionCell, agent: FakeAcpAgent) {
  let resolvePrompt!: (value: { stopReason: string }) => void;
  agent.prompt = vi.fn()
    .mockImplementationOnce(() => new Promise((resolve) => { resolvePrompt = resolve; }))
    .mockResolvedValue({ stopReason: 'end_turn' });
  const sent = cell.prompt({ text: 'run sleep 300 in the background', origin: 'typed' });
  await Promise.resolve();
  cell.push({ kind: 'agent_state', state: 'running' });
  cell.push({ kind: 'message', role: 'assistant', messageId: 'r1', text: 'Started it in the background.' });
  return { sent, finish: () => resolvePrompt({ stopReason: 'end_turn' }) };
}

describe('SessionCell stuck-work fallback', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('result arrived but idle never does: the turn settles after the window and the next message is sent, not queued', async () => {
    const { cell, agent, onStuckWork, logger } = reportingCell();
    const turn = await startTurn(cell, agent);
    turn.finish();
    await turn.sent;
    expect(cell.sessionState.lifecycle, 'waits for idle first').toBe('working');

    await wait(WINDOW_MS * 2);

    expect(cell.sessionState.lifecycle).toBe('ready');
    expect(cell.history().committed.at(-1)?.outcome).toEqual({ kind: 'done', reason: 'end_turn' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('never reported idle'), expect.objectContaining({ sessionId: 'conv-1', case: 'result-without-idle', waitedMs: expect.any(Number) }));
    expect(onStuckWork).toHaveBeenCalledTimes(1);
    expect(onStuckWork.mock.calls[0]![0]).toBe('conv-1');
    expect(JSON.parse(onStuckWork.mock.calls[0]![1]).events.length).toBeGreaterThan(0);

    const next = await cell.prompt({ text: 'what is this card?', origin: 'typed' });
    expect(isOk(next)).toBe(true);
    expect(cell.sessionState.queuedPrompts, 'not queued behind background work').toEqual([]);
    expect(agent.prompt).toHaveBeenCalledTimes(2);
  });

  it('❌ negative: no result yet (the model is still working) — never settles, however long it is quiet', async () => {
    const { cell, agent, onStuckWork } = reportingCell();
    await startTurn(cell, agent);
    await wait(WINDOW_MS * 3);
    expect(cell.sessionState.lifecycle).toBe('working');
    expect(onStuckWork).not.toHaveBeenCalled();
  });

  it('❌ negative: idle arrives in time — settles on idle, no fallback, no dump', async () => {
    const { cell, agent, onStuckWork, logger } = reportingCell();
    const turn = await startTurn(cell, agent);
    turn.finish();
    await turn.sent;
    cell.push({ kind: 'agent_state', state: 'idle' });
    expect(cell.sessionState.lifecycle).toBe('ready');
    await wait(WINDOW_MS * 2);
    expect(onStuckWork).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('❌ negative: waiting on the user (requires_action) does not count', async () => {
    const { cell, agent, onStuckWork } = reportingCell();
    const turn = await startTurn(cell, agent);
    turn.finish();
    await turn.sent;
    cell.push({ kind: 'agent_state', state: 'requires_action' });
    await wait(WINDOW_MS * 3);
    expect(cell.sessionState.lifecycle).toBe('working');
    expect(onStuckWork).not.toHaveBeenCalled();
  });

  it('❌ negative: foreground output inside the window restarts it — real work is not cut', async () => {
    const { cell, agent, onStuckWork } = reportingCell();
    const turn = await startTurn(cell, agent);
    turn.finish();
    await turn.sent;
    for (let i = 0; i < 4; i += 1) {
      await wait(WINDOW_MS / 2);
      cell.push({ kind: 'message', role: 'assistant', messageId: `r${i + 2}`, text: 'still going' });
    }
    expect(cell.sessionState.lifecycle, 'output kept restarting the window').toBe('working');
    expect(onStuckWork).not.toHaveBeenCalled();
    await wait(WINDOW_MS * 2);
    expect(cell.sessionState.lifecycle, 'then it went quiet').toBe('ready');
  });
});
