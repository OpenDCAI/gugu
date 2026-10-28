import { noopLogger } from '@gugu/session-shared/logger';
import { describe, expect, it, vi } from 'vitest';
import { FakeAcpAgent } from '../acp-test-support';
import { SessionCell } from './cell';

const DELIVERY = '<gugu_delivery route="chat" from="B" chat="test">accepted ping</gugu_delivery>';
function runningCell() {
  const agent = new FakeAcpAgent();
  agent.extMethod = vi.fn().mockResolvedValue({ outcome: 'injected' });
  agent.prompt = vi.fn(() => new Promise<{ stopReason: 'end_turn' }>(() => {}));
  const cell = new SessionCell({
    mergeEnvelopes: (texts) => texts.join('\n'), sessionId: 'stopped-steer', projectId: 'proj',
    providerId: 'claude', acpSessionId: 'native', agent, supportsSteering: true,
    resolveAttachment: vi.fn(), logger: noopLogger,
  });
  cell.applySessionReady();
  cell.setReportsState(true);
  cell.push({ kind: 'agent_state', state: 'running' });
  cell.push({ kind: 'tool_call', toolKind: 'execute', parentToolCallId: null, diffs: [], locations: [], toolCallId: 't1', title: 'long tool', status: 'in_progress' });
  return { cell, agent };
}
async function admit(cell: SessionCell) {
  expect(await cell.prompt({ text: DELIVERY, origin: 'communication' }, { steerIfBusy: true }))
    .toEqual({ success: true, data: { queued: false } });
  expect(cell.sessionState.queuedPrompts).toEqual([]);
}
const queued = (cell: SessionCell) => cell.sessionState.queuedPrompts.map(({ text, origin }) => ({ text, origin }));

describe('stopping retains native steering until consumption is observed', () => {
  it('requeues an admitted delivery on stop, including its origin, and never twice on close retry', async () => {
    const { cell } = runningCell();
    await admit(cell);
    await cell.closeSession();
    cell.settleTurn({ kind: 'cancelled', reason: 'cancelled' });
    await cell.closeSession();
    expect(queued(cell)).toEqual([{ text: DELIVERY, origin: 'communication' }]);
  });

  it('does not replay a steer followed by a new tool call; an old tool update is not consumption', async () => {
    const { cell } = runningCell();
    await admit(cell);
    cell.push({ kind: 'tool_update', title: null, toolKind: null, parentToolCallId: null, diffs: [], toolCallId: 't1', status: 'completed' });
    cell.push({ kind: 'tool_call', toolKind: 'execute', parentToolCallId: null, diffs: [], locations: [], toolCallId: 't1', title: 'same tool', status: 'completed' });
    cell.push({ kind: 'tool_call', toolKind: 'execute', parentToolCallId: null, diffs: [], locations: [], toolCallId: 't2', title: 'next tool', status: 'in_progress' });
    await cell.closeSession();
    expect(queued(cell)).toEqual([]);
  });

  it('replays once when consumption is uncertain: assistant text without a new tool or normal completion may duplicate', async () => {
    const { cell } = runningCell();
    await admit(cell);
    cell.push({ kind: 'tool_update', title: null, toolKind: null, parentToolCallId: null, diffs: [], toolCallId: 't1', status: 'completed' });
    cell.push({ kind: 'tool_call', toolKind: 'execute', parentToolCallId: null, diffs: [], locations: [], toolCallId: 't1', title: 'same tool', status: 'completed' });
    cell.push({ kind: 'message', role: 'assistant', messageId: 'a1', text: 'I may already have read the ping.' });
    await cell.closeSession();
    expect(queued(cell)).toEqual([{ text: DELIVERY, origin: 'communication' }]);
  });

  it('does not replay after the agent normally completes its turn', async () => {
    const { cell } = runningCell();
    await admit(cell);
    cell.settleTurn({ kind: 'done', reason: 'end_turn' });
    cell.push({ kind: 'agent_state', state: 'idle' });
    await cell.closeSession();
    expect(queued(cell)).toEqual([]);
  });

  it('retains only steers admitted after the last new-tool boundary', async () => {
    const { cell } = runningCell();
    await admit(cell);
    cell.push({ kind: 'tool_call', toolKind: 'execute', parentToolCallId: null, diffs: [], locations: [], toolCallId: 't2', title: 'next tool', status: 'in_progress' });
    await cell.prompt({ text: 'later', origin: 'typed' }, { steerIfBusy: true });
    await cell.closeSession();
    expect(queued(cell)).toEqual([{ text: 'later', origin: 'typed' }]);
  });
});
