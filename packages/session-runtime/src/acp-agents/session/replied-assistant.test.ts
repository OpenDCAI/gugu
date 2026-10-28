import { describe, expect, it, vi } from 'vitest';
import { renderDeliveryEnvelope, mergeDeliveryEnvelopes } from '@gugu/core/local/agent/deliveryEnvelope';
import { noopLogger } from '@gugu/session-shared/logger';
import { FakeAcpAgent, requestActivityCell } from '../acp-test-support';
import { deferred } from '../../../../../tests/support/testHarness';

const owner = 'owner';
const chat = 'chat';
const sourceId = 'f9e41e17-9630-4f24-a3ed-782616738ed0';
const receiptId = '63369ee5-81b5-4f1f-89e9-9481095c84ed';
const delivery = (messageId: string, fromId = 'user:owner', destination = chat) => renderDeliveryEnvelope({
  route: 'chat', from: 'Owner', fromId, messageId: 'msg:' + messageId, chat: destination,
  chatKind: 'dm', at: '2026-10-27T04:10:00Z', content: 'Keep the unfinished task; answer this new message.',
});

function fixture(extra: Record<string, unknown> = {}) {
  const agent = new FakeAcpAgent();
  const old = deferred<{ stopReason: 'cancelled' | 'end_turn' }>();
  agent.prompt.mockReturnValueOnce(old.promise);
  const cell = requestActivityCell(agent, {
    sessionId: 'session', projectId: 'project', providerId: 'claude', acpSessionId: 'native',
    resolveAttachment: async () => { throw Error('No fixture attachments'); }, mergeEnvelopes: mergeDeliveryEnvelopes,
    logger: noopLogger, assistantOwnerId: owner, queuedPromptsPersisted: () => true, ...extra,
  });
  cell.applySessionReady();
  const first = cell.promptDetached({ origin: 'communication', text: delivery(sourceId) });
  // Admission is the provider's first event for the request.
  void agent.called('prompt').then(() => cell.push({ kind: 'thinking', messageId: 'started', text: 'Reading the message.' }));
  const sent = (input: Record<string, unknown> = {}, status: 'completed' | 'failed' = 'completed') => {
    cell.push({ kind: 'tool_call', toolCallId: 'send', title: 'mcp__gugu__message_send', toolName: 'mcp__gugu__message_send',
      toolKind: 'other', status: 'in_progress', parentToolCallId: null, locations: [],
      rawInput: JSON.stringify({ chat_id: chat, text: 'Already delivered', reply_to_message_id: 'msg:' + sourceId, ...input }) });
    cell.push({ kind: 'tool_update', toolCallId: 'send', title: null, toolKind: null, status,
      parentToolCallId: null, outputText: `replied (id=msg:${receiptId})` });
  };
  return { cell, agent, old, first, sent };
}

describe('new owner input after an assistant reply', () => {
  it('queues the original message before cancelling the old continuation and resumes it exactly once', async () => {
    const f = fixture();
    await f.first.admission;
    await f.agent.called('prompt');
    f.sent();
    const next = delivery('40529fa8-8d6f-4b8f-9a42-f257a788fbdf');
    f.agent.cancel.mockImplementation(async () => {
      expect(f.cell.sessionState.queuedPrompts.map(p => p.text)).toEqual([next]);
      f.old.resolve({ stopReason: 'cancelled' });
      return {};
    });
    const later = f.cell.promptDetached({ origin: 'communication', text: next }, { steerIfBusy: true });
    await later.admission;
    await vi.waitFor(() => expect(f.agent.cancel).toHaveBeenCalledTimes(1));
    await f.first.completion;
    await vi.waitFor(() => expect(f.agent.prompt).toHaveBeenCalledTimes(2));
    expect(f.agent.prompt.mock.calls[1][0].prompt).toEqual([{ type: 'text', text: next }]);
    expect(f.cell.history().committed[0].outcome).toMatchObject({ reason: 'interrupted_for_message' });
  });

  it.each([
    ['unconfirmed reply', {}, false, 'completed'],
    ['failed send', {}, true, 'failed'],
    ['another chat', { chat_id: 'other' }, true, 'completed'],
    ['another source', { reply_to_message_id: 'msg:other' }, true, 'completed'],
    ['whisper', { whisper: true }, true, 'completed'],
  ] as const)('does not interrupt for %s', async (_name, input, didSend, status) => {
    const f = fixture();
    await f.first.admission;
    await f.agent.called('prompt');
    if (didSend) f.sent(input, status);
    await f.cell.promptDetached({ origin: 'communication', text: delivery('next') }).admission;
    expect(f.agent.cancel).not.toHaveBeenCalled();
    f.old.resolve({ stopReason: 'end_turn' });
    await f.first.completion;
  });

  it.each([
    ['a task agent', { assistantOwnerId: undefined }, 'user:owner'],
    ['unpersisted queue', { queuedPromptsPersisted: () => false }, 'user:owner'],
    ['an incoming agent', {}, 'user:another-agent'],
  ] as const)('keeps the existing queue path for %s', async (_name, extra, fromId) => {
    const f = fixture(extra);
    await f.first.admission;
    await f.agent.called('prompt');
    f.sent();
    await f.cell.promptDetached({ origin: 'communication', text: delivery('next', fromId) }).admission;
    expect(f.agent.cancel).not.toHaveBeenCalled();
    f.old.resolve({ stopReason: 'end_turn' });
    await f.first.completion;
  });

  it('keeps acknowledgement followed by work on the normal path, including after its tool finishes', async () => {
    const f = fixture();
    await f.first.admission;
    await f.agent.called('prompt');
    f.sent();
    const tool = { toolCallId: 'read', title: 'Read', toolKind: 'read' as const, parentToolCallId: null, locations: [] };
    f.cell.push({ kind: 'tool_call', ...tool, status: 'in_progress' });
    await f.cell.promptDetached({ origin: 'communication', text: delivery('next') }).admission;
    expect(f.agent.cancel).not.toHaveBeenCalled();
    f.cell.push({ kind: 'tool_update', ...tool, status: 'completed' });
    expect(f.agent.cancel).not.toHaveBeenCalled();
    f.old.resolve({ stopReason: 'end_turn' });
    await f.first.completion;
    await vi.waitFor(() => expect(f.agent.prompt).toHaveBeenCalledTimes(2));
    expect(f.agent.prompt.mock.calls[1][0].prompt).toEqual([{ type: 'text', text: delivery('next') }]);
  });

  it('abandons a yield if an old-turn tool starts during queue persistence', async () => {
    let armed = false;
    const tool = { toolCallId: 'late', title: 'Read', toolKind: 'read' as const, parentToolCallId: null, locations: [] };
    const f: ReturnType<typeof fixture> = fixture({ callbacks: { onSessionStateChanged: () => {
      if (!armed || !f.cell.sessionState.queuedPrompts.length) return;
      armed = false;
      f.cell.push({ kind: 'tool_call', ...tool, status: 'in_progress' });
    } } });
    await f.first.admission;
    await f.agent.called('prompt');
    f.sent();
    armed = true;
    await f.cell.promptDetached({ origin: 'communication', text: delivery('next') }).admission;
    expect(f.cell.sessionState.queuedPrompts).toHaveLength(1);
    expect(f.agent.cancel).not.toHaveBeenCalled();
    f.cell.push({ kind: 'tool_update', ...tool, status: 'completed' });
    expect(f.agent.cancel).not.toHaveBeenCalled();
    f.old.resolve({ stopReason: 'end_turn' });
    await f.first.completion;
    await vi.waitFor(() => expect(f.agent.prompt).toHaveBeenCalledTimes(2));
  });

  it('retains two arrivals during cancellation and drains them once in arrival order', async () => {
    const f = fixture();
    await f.first.admission;
    await f.agent.called('prompt');
    f.sent();
    const texts = [delivery('second'), delivery('third')];
    await f.cell.promptDetached({ origin: 'communication', text: texts[0] }).admission;
    await f.cell.promptDetached({ origin: 'communication', text: texts[1] }, { steerIfBusy: true }).admission;
    expect(f.agent.cancel).toHaveBeenCalledTimes(1);
    expect(f.cell.sessionState.queuedPrompts.map(p => p.text)).toEqual(texts);
    f.old.resolve({ stopReason: 'cancelled' });
    await f.first.completion;
    await vi.waitFor(() => expect(f.agent.prompt).toHaveBeenCalledTimes(2));
    expect(f.agent.prompt.mock.calls[1][0].prompt).toEqual([{ type: 'text', text: mergeDeliveryEnvelopes(texts) }]);
  });

  it('does not withdraw another input that the native adapter already admitted', async () => {
    const f = fixture({ supportsSteering: true });
    await f.first.admission;
    await f.agent.called('prompt');
    f.sent();
    f.agent.extMethod.mockResolvedValue({ outcome: 'injected' });
    await f.cell.promptDetached({ origin: 'communication', text: delivery('peer', 'user:peer') }, { steerIfBusy: true }).admission;
    await f.cell.promptDetached({ origin: 'communication', text: delivery('owner-next') }).admission;
    expect(f.agent.cancel).not.toHaveBeenCalled();
    f.old.resolve({ stopReason: 'end_turn' });
    await f.first.completion;
  });

  it('waits for a background agent instead of cancelling its work', async () => {
    const f = fixture();
    await f.first.admission;
    await f.agent.called('prompt');
    f.sent();
    f.cell.push({ kind: 'subagent', toolCallId: 'child', agentId: 'child', subagentSessionId: 'child',
      title: 'Background work', status: 'in_progress', parentToolCallId: null });
    await f.cell.promptDetached({ origin: 'communication', text: delivery('next') }).admission;
    expect(f.agent.cancel).not.toHaveBeenCalled();
    f.cell.push({ kind: 'subagent_done', toolCallId: 'child', agentId: 'child', subagentSessionId: 'child', status: 'completed' });
    expect(f.agent.cancel).not.toHaveBeenCalled();
    f.old.resolve({ stopReason: 'end_turn' });
    await f.first.completion;
  });
});
