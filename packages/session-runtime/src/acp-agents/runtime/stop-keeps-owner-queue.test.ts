/*
 * 2026-10-28 07:34:06 主人撞到:会话正在关的时候,这一轮落定、队列出队,主人排的那条被 `Session is closing` 拒掉,
 * 日志一句「not re-queued」就没了;停止又把队列快照清空,重起之后也找不回来。
 * 现在:关的时候不出队;停下时队列快照只留主人排的话(origin `manual`),重起后照常先发它。投递信封照旧清掉。
 */
import { isOk } from '@gugu/session-shared';
import { noopLogger } from '@gugu/session-shared/logger';
import { describe, expect, it, vi } from 'vitest';
import { FakeAcpAgent, makeAcpHarness, makeStartInput } from '../acp-test-support';
import { SessionCell } from '../session/cell';
import { AcpRuntime } from './runtime';

const DELIVERY = '<gugu_delivery route="chat" from="B" chat="216125">ping</gugu_delivery>';

const sentTexts = (agent: FakeAcpAgent) =>
  agent.prompt.mock.calls.map(([request]) =>
    (request as { prompt: { type: string; text?: string }[] }).prompt
      .filter((block) => block.type === 'text').map((block) => block.text).join('\n'));

describe('stopping a session keeps the owner\'s queued message for the next start', () => {
  it('the owner\'s queued message survives the stop and is sent first after the restart', async () => {
    const h = makeAcpHarness();
    h.agent.prompt.mockImplementationOnce(() => new Promise(() => {}));
    const rt = new AcpRuntime(h.deps);
    const start = makeStartInput({ sessionId: 'conv-stop-queue' });
    expect(isOk(await rt.startSession(start))).toBe(true);

    expect(isOk(rt.promptDetached('conv-stop-queue', { text: 'the long task', origin: 'manual' }))).toBe(true);
    await h.agent.called('prompt');
    await expect(rt.queuePrompt('conv-stop-queue', { text: 'and then this', origin: 'manual' }))
      .resolves.toEqual({ success: true, data: { queued: true } });

    await expect(rt.stopSession('conv-stop-queue')).resolves.toEqual({ success: true, data: undefined });
    expect(h.deps.promptQueueStore?.load('conv-stop-queue').map((prompt) => prompt.text)).toEqual(['and then this']);

    expect(isOk(await rt.startSession({ ...start, providerSessionId: 'session-1' }))).toBe(true);
    await vi.waitFor(() => expect(h.agent.prompt).toHaveBeenCalledTimes(2));
    expect(sentTexts(h.agent).at(-1)).toContain('and then this');
  });

  it('❌ negative: a queued delivery envelope is cleared on stop as before, so the restart does not deliver it a second time', async () => {
    const h = makeAcpHarness();
    h.agent.prompt.mockImplementationOnce(() => new Promise(() => {}));
    const rt = new AcpRuntime(h.deps);
    const start = makeStartInput({ sessionId: 'conv-stop-delivery' });
    expect(isOk(await rt.startSession(start))).toBe(true);

    expect(isOk(rt.promptDetached('conv-stop-delivery', { text: 'the long task', origin: 'manual' }))).toBe(true);
    await h.agent.called('prompt');
    await rt.queuePrompt('conv-stop-delivery', { text: DELIVERY, origin: 'communication' });
    await rt.queuePrompt('conv-stop-delivery', { text: 'and then this', origin: 'manual' });

    await rt.stopSession('conv-stop-delivery');
    expect(h.deps.promptQueueStore?.load('conv-stop-delivery').map((prompt) => prompt.origin)).toEqual(['manual']);

    expect(isOk(await rt.startSession({ ...start, providerSessionId: 'session-1' }))).toBe(true);
    await vi.waitFor(() => expect(h.agent.prompt).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sentTexts(h.agent).filter((text) => text.includes('ping')), 'the envelope is not sent again').toEqual([]);
    expect(h.agent.prompt).toHaveBeenCalledTimes(2);
  });

  it('a turn that settles while the cell is closing does not dequeue — the queued prompt is not thrown away', async () => {
    const agent = new FakeAcpAgent();
    agent.prompt = vi.fn(() => new Promise<{ stopReason: 'end_turn' }>(() => {}));
    const cell = new SessionCell({
      mergeEnvelopes: (texts) => texts.join('\n'),
      sessionId: 'conv-closing',
      projectId: 'proj-1',
      providerId: 'claude',
      acpSessionId: 'session-1',
      agent,
      resolveAttachment: vi.fn().mockResolvedValue({ data: '', mimeType: 'image/png' }),
      logger: noopLogger,
    });
    cell.applySessionReady();
    void cell.prompt({ text: 'the long task', origin: 'manual' });
    await Promise.resolve();
    await cell.queueBehindTurn({ text: 'and then this', origin: 'manual' });

    await cell.closeSession();
    cell.settleTurn({ kind: 'cancelled', reason: 'cancelled' });
    await Promise.resolve();

    expect(cell.sessionState.queuedPrompts.map((prompt) => prompt.text)).toEqual(['and then this']);
    expect(agent.prompt).toHaveBeenCalledTimes(1);
  });
});
