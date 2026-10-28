/*
 * 2026-10-28 主人撞到:新管家 agent 自己开的一轮(处理群消息)跑了几分钟,主人打的话一直「排队」。
 * 人在**别人开的**一轮里打字(投递开的、agent 自己开的)⇒ 下一个工具边界插进去,越过排着的投递;
 * 人自己开的那一轮里再打字,照旧排到讲完。
 */
import { noopLogger } from '@gugu/session-shared/logger';
import { describe, expect, it, vi } from 'vitest';
import { FakeAcpAgent } from '../acp-test-support';
import { SessionCell } from './cell';

function steeringCell(reportsState = false, callbacks?: ConstructorParameters<typeof SessionCell>[0]['callbacks']) {
  const agent = new FakeAcpAgent();
  agent.extMethod = vi.fn().mockResolvedValue({ outcome: 'injected' });
  agent.prompt = vi.fn(() => new Promise<{ stopReason: 'end_turn' }>(() => {}));
  const cell = new SessionCell({
    mergeEnvelopes: (texts) => texts.join('\n'),
    sessionId: 'conv-1',
    projectId: 'proj-1',
    providerId: 'claude',
    acpSessionId: 'session-1',
    agent,
    supportsSteering: true,
    resolveAttachment: vi.fn().mockResolvedValue({ data: '', mimeType: 'image/png' }),
    logger: noopLogger,
    ...(callbacks ? { callbacks } : {}),
  });
  cell.applySessionReady();
  if (reportsState) cell.setReportsState(true);
  return { cell, agent };
}

const steeredTexts = (agent: FakeAcpAgent) =>
  (agent.extMethod as ReturnType<typeof vi.fn>).mock.calls
    .filter(([method]) => method === '_session/steering')
    .map(([, params]) => (params as { prompt: { text: string }[] }).prompt[0]!.text);

const DELIVERY = '<gugu_delivery route="chat" from="B" chat="chat-gugu">ping</gugu_delivery>';

describe('SessionCell: the owner is not queued behind a turn someone else started', () => {
  it('in a turn a delivery started, the owner\'s message steers in at once, ahead of a queued delivery', async () => {
    const { cell, agent } = steeringCell();
    void cell.prompt({ text: DELIVERY, origin: 'communication' });
    await Promise.resolve();
    expect(cell.sessionState.lifecycle).toBe('working');
    expect(cell.history().active?.trigger).toEqual({ kind: 'delivery', chatIds: ['chat-gugu'] });
    await cell.queueBehindTurn({ text: DELIVERY.replace('ping', 'pong'), origin: 'communication' });
    expect(cell.sessionState.queuedPrompts, 'a later delivery waits').toHaveLength(1);

    const owner = await cell.queueBehindTurn({ text: 'what is this card?', origin: 'manual' });

    expect(owner).toEqual({ success: true, data: { queued: false } });
    expect(steeredTexts(agent)).toEqual(['what is this card?']);
    expect(cell.sessionState.queuedPrompts.map((p) => p.origin), 'only the delivery is still queued').toEqual(['communication']);
  });

  it('in a turn the agent started on its own (no prompt in flight), the owner\'s message steers in at once', async () => {
    const { cell, agent } = steeringCell(true);
    cell.push({ kind: 'agent_state', state: 'running' });
    expect(cell.sessionState.lifecycle).toBe('working');
    cell.push({ kind: 'message', role: 'assistant', messageId: 'a1', text: 'Background job finished; checking.' });
    expect(cell.history().active?.trigger).toEqual({ kind: 'agent' });

    const owner = await cell.queueBehindTurn({ text: 'stop and look at this', origin: 'manual' });

    expect(owner).toEqual({ success: true, data: { queued: false } });
    expect(steeredTexts(agent)).toEqual(['stop and look at this']);
    expect(cell.sessionState.queuedPrompts).toEqual([]);
  });

  it('❌ negative: in a turn the owner started, the next message is queued as before', async () => {
    const { cell, agent } = steeringCell();
    void cell.prompt({ text: 'do the long task', origin: 'manual' });
    await Promise.resolve();
    expect(cell.sessionState.lifecycle).toBe('working');
    expect(cell.history().active?.trigger).toEqual({ kind: 'owner' });

    const next = await cell.queueBehindTurn({ text: 'and then this', origin: 'manual' });

    expect(next).toEqual({ success: true, data: { queued: true } });
    expect(steeredTexts(agent)).toEqual([]);
    expect(cell.sessionState.queuedPrompts.map((p) => p.text)).toEqual(['and then this']);
  });

  it('❌ negative: the owner started it, the agent then reports running — still the owner\'s turn, still queued', async () => {
    const { cell, agent } = steeringCell(true);
    void cell.prompt({ text: 'do the long task', origin: 'manual' });
    await Promise.resolve();
    cell.push({ kind: 'agent_state', state: 'running' });

    const next = await cell.queueBehindTurn({ text: 'and then this', origin: 'manual' });

    expect(next).toEqual({ success: true, data: { queued: true } });
    expect(steeredTexts(agent)).toEqual([]);
  });

  it('typed text (sent verbatim from elsewhere, e.g. a startup delegation) is not the owner: its turn is a delivery, and the owner steers in', async () => {
    const { cell, agent } = steeringCell();
    void cell.prompt({ text: 'please review the migration', origin: 'typed' });
    await Promise.resolve();
    expect(cell.sessionState.lifecycle).toBe('working');
    expect(cell.history().active?.trigger).toEqual({ kind: 'delivery' });

    const owner = await cell.queueBehindTurn({ text: 'skip the tests for now', origin: 'manual' });

    expect(owner).toEqual({ success: true, data: { queued: false } });
    expect(steeredTexts(agent)).toEqual(['skip the tests for now']);
  });

  it('❌ negative: typed text arriving in the owner\'s turn does not overtake; it is queued', async () => {
    const { cell, agent } = steeringCell();
    void cell.prompt({ text: 'do the long task', origin: 'manual' });
    await Promise.resolve();

    const typed = await cell.queueBehindTurn({ text: 'a verbatim note', origin: 'typed' });

    expect(typed).toEqual({ success: true, data: { queued: true } });
    expect(steeredTexts(agent)).toEqual([]);
  });

  it('a turn a scheduled run starts is tagged schedule; several deliveries in one turn keep every chat id', async () => {
    const scheduled = steeringCell();
    void scheduled.cell.prompt({ text: '<gugu_delivery route="scheduled" schedule="daily">run it</gugu_delivery>', origin: 'communication' });
    await Promise.resolve();
    expect(scheduled.cell.history().active?.trigger).toEqual({ kind: 'schedule' });

    const merged = steeringCell();
    void merged.cell.prompt({
      text: '<gugu_deliveries count="2"><gugu_delivery route="chat" chat="c1">a</gugu_delivery><gugu_delivery route="chat" chat="c2">b</gugu_delivery></gugu_deliveries>',
      origin: 'communication',
    });
    await Promise.resolve();
    expect(merged.cell.history().active?.trigger).toEqual({ kind: 'delivery', chatIds: ['c1', 'c2'] });
  });

  it('the first frame a scheduled turn is visible in already carries its trigger, before the engine reports running', async () => {
    const frames: Array<{ lifecycle: string; active: boolean; trigger: unknown }> = [];
    let cell!: SessionCell;
    const record = () => {
      const active = cell.history().active;
      frames.push({ lifecycle: cell.sessionState.lifecycle, active: !!active, trigger: active?.trigger });
    };
    cell = steeringCell(true, { onTranscriptChanged: record, onSessionStateChanged: record }).cell;

    void cell.prompt({ text: '<gugu_delivery route="scheduled" schedule="daily">run it</gugu_delivery>', origin: 'communication' });
    await Promise.resolve();
    cell.push({ kind: 'agent_state', state: 'running' });

    const visible = frames.filter((frame) => frame.active || frame.lifecycle === 'working');
    expect(visible.length).toBeGreaterThan(0);
    expect(visible[0], 'no frame shows the turn without knowing what started it').toMatchObject({ active: true, trigger: { kind: 'schedule' } });
    expect(visible.every((frame) => frame.active && (frame.trigger as { kind?: string })?.kind === 'schedule')).toBe(true);
  });
});
