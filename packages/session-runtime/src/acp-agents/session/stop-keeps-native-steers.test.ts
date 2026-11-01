import { noopLogger } from '@gugu/session-shared/logger';
import { describe, expect, it, vi } from 'vitest';
import { FakeAcpAgent, requestActivityCell } from '../acp-test-support';
import type { SessionCell } from './cell';

const DELIVERY = '<gugu_delivery route="chat" from="B" chat="test">accepted ping</gugu_delivery>';
function runningCell(providerId = 'claude') {
  const agent = new FakeAcpAgent();
  agent.extMethod = vi.fn().mockResolvedValue({ outcome: 'injected' });
  agent.prompt = vi.fn(() => new Promise<{ stopReason: 'end_turn' }>(() => {}));
  const cell = requestActivityCell(agent, {
    mergeEnvelopes: (texts) => texts.join('\n'), sessionId: 'stopped-steer', projectId: 'proj',
    providerId, acpSessionId: 'native', supportsSteering: true,
    resolveAttachment: vi.fn(), logger: noopLogger,
  });
  cell.applySessionReady();
  cell.push({ kind: 'agent_state', source: 'agent', state: 'running' });
  cell.push({ kind: 'tool_call', toolKind: 'execute', parentToolCallId: null, locations: [], toolCallId: 't1', title: 'long tool', status: 'in_progress' });
  return { cell, agent };
}
async function admit(cell: SessionCell) {
  expect(await cell.prompt({ text: DELIVERY, origin: 'communication' }, { steerIfBusy: true }))
    .toEqual({ success: true, data: { queued: false } });
  expect(cell.sessionState.queuedPrompts).toEqual([]);
}
const queued = (cell: SessionCell) => cell.sessionState.queuedPrompts.map(({ text, origin }) => ({ text, origin }));

describe('stopping retains native steering until consumption is observed', () => {
  it.each(['codex', 'claude'])('%s: cancelling a turn replays an admitted delivery once, like its waiting queue', async providerId => {
    const { cell, agent } = runningCell(providerId);
    try {
      await admit(cell);
      await cell.queueBehindTurn({ text: 'already waiting', origin: 'manual' });
      await cell.cancel();
      cell.push({ kind: 'agent_state', source: 'agent', state: 'idle', stopReason: 'cancelled' });
      await agent.called('prompt');
      expect(agent.prompt).toHaveBeenCalledTimes(1);
      expect(agent.prompt.mock.calls[0][0].prompt).toEqual([{ type: 'text', text: DELIVERY }]);
      expect(queued(cell)).toEqual([{ text: 'already waiting', origin: 'manual' }]);
    } finally { cell.dispose(); }
  });

  it('retains a steer whose injected result arrives after cancellation has settled', async () => {
    const { cell, agent } = runningCell();
    try {
      const receipt = Promise.withResolvers<{ outcome: 'injected' }>();
      agent.extMethod.mockImplementationOnce(() => receipt.promise);
      const sending = cell.prompt({ text: DELIVERY, origin: 'communication' }, { steerIfBusy: true });
      await agent.called('extMethod');
      await cell.cancel();
      cell.push({ kind: 'agent_state', source: 'agent', state: 'idle', stopReason: 'cancelled' });
      receipt.resolve({ outcome: 'injected' });
      expect((await sending).success).toBe(true);
      await agent.called('prompt');
      expect(agent.prompt).toHaveBeenCalledTimes(1);
      expect(agent.prompt.mock.calls[0][0].prompt).toEqual([{ type: 'text', text: DELIVERY }]);
    } finally { cell.dispose(); }
  });

  it('requeues an admitted delivery on stop, including its origin, and never twice on close retry', async () => {
    const { cell } = runningCell();
    await admit(cell);
    await cell.closeSession();
    cell.push({ kind: 'agent_state', source: 'agent', state: 'idle', stopReason: 'cancelled' });
    await cell.closeSession();
    expect(queued(cell)).toEqual([{ text: DELIVERY, origin: 'communication' }]);
  });

  it('does not replay a steer followed by a new tool call; an old tool update is not consumption', async () => {
    const { cell } = runningCell();
    await admit(cell);
    cell.push({ kind: 'tool_update', title: null, toolKind: null, parentToolCallId: null, toolCallId: 't1', status: 'completed' });
    cell.push({ kind: 'tool_call', toolKind: 'execute', parentToolCallId: null, locations: [], toolCallId: 't1', title: 'same tool', status: 'completed' });
    cell.push({ kind: 'tool_call', toolKind: 'execute', parentToolCallId: null, locations: [], toolCallId: 't2', title: 'next tool', status: 'in_progress' });
    await cell.closeSession();
    expect(queued(cell)).toEqual([]);
  });

  it('replays once when consumption is uncertain: assistant text without a new tool or normal completion may duplicate', async () => {
    const { cell } = runningCell();
    await admit(cell);
    cell.push({ kind: 'tool_update', title: null, toolKind: null, parentToolCallId: null, toolCallId: 't1', status: 'completed' });
    cell.push({ kind: 'tool_call', toolKind: 'execute', parentToolCallId: null, locations: [], toolCallId: 't1', title: 'same tool', status: 'completed' });
    cell.push({ kind: 'message', role: 'assistant', messageId: 'a1', text: 'I may already have read the ping.' });
    await cell.closeSession();
    expect(queued(cell)).toEqual([{ text: DELIVERY, origin: 'communication' }]);
  });

  it('does not replay after the agent normally completes its turn', async () => {
    const { cell } = runningCell();
    await admit(cell);
    cell.push({ kind: 'agent_state', source: 'agent', state: 'idle', stopReason: 'end_turn' });
    cell.push({ kind: 'agent_state', source: 'agent', state: 'idle' });
    await cell.closeSession();
    expect(queued(cell)).toEqual([]);
  });

  it('retains only steers admitted after the last new-tool boundary', async () => {
    const { cell } = runningCell();
    await admit(cell);
    cell.push({ kind: 'tool_call', toolKind: 'execute', parentToolCallId: null, locations: [], toolCallId: 't2', title: 'next tool', status: 'in_progress' });
    await cell.prompt({ text: 'later', origin: 'typed' }, { steerIfBusy: true });
    await cell.closeSession();
    expect(queued(cell)).toEqual([{ text: 'later', origin: 'typed' }]);
  });
});
