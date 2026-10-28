import { expect, it, vi } from 'vitest';
import type { AcpAgentApi } from '@gugu/session-core/agents/plugins';
import { createRequestActivity, decodeV2SessionUpdate, type SessionPromptReceipt } from '@gugu/session-core/acp';
import { noopLogger } from '@gugu/session-shared/logger';
import { SessionCell } from './cell';

it('does not complete a queued user prompt with the preceding autonomous foreground outcome', async () => {
  // Source-derived wire order, not a product recording: bridge 0008's autonomous
  // follow-up (msg_followup), and upstream 5b11f470 src/v2/prompt.ts v2Prompt/
  // v2Foreground: autonomous running/idle can precede inserted(user_message),
  // receipt, and the user's running/idle. A receipt is not a cycle boundary.
  const receipt = Promise.withResolvers<SessionPromptReceipt>();
  const prompt = vi.fn(() => receipt.promise);
  const cell = new SessionCell({ sessionId: 'c', projectId: 'p', providerId: 'fixture', acpSessionId: 's',
    agent: { prompt, cancel: vi.fn(async () => {}) } as unknown as AcpAgentApi,
    resolveAttachment: async () => ({ data: '', mimeType: 'image/png' }), logger: noopLogger });
  cell.applySessionReady();
  const sent = cell.promptDetached({ text: 'the user question' });
  await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
  let completed = false;
  void sent.completion.then(() => { completed = true; });
  const wire = (update: unknown) => cell.push(decodeV2SessionUpdate(update));
  wire({ sessionUpdate: 'state_update', state: 'running' });
  wire({ sessionUpdate: 'agent_message', messageId: 'msg_followup', content: [{ type: 'text', text: 'Background finished' }] });
  wire({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn', _meta: { cycle: 'autonomous' } });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(cell.history().committed[0]?.foreground?._meta).toEqual({ cycle: 'autonomous' });
  expect(completed, 'the user message has not been inserted or accepted yet').toBe(false);

  wire({ sessionUpdate: 'user_message', messageId: 'native-user', content: [{ type: 'text', text: 'the user question' }] });
  receipt.resolve({ status: 'accepted', requestId: 'request', messageId: 'native-user' });
  await receipt.promise;
  wire({ sessionUpdate: 'state_update', state: 'running' });
  wire({ sessionUpdate: 'agent_message', messageId: 'answer', content: [{ type: 'text', text: 'User answer' }] });
  wire({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'max_tokens', _meta: { cycle: 'user' } });
  expect(await sent.completion).toMatchObject({ success: true });
  expect(cell.history().committed.map(turn => turn.initiator)).toEqual(['agent', 'user']);
  expect(cell.history().committed[0]?.items.some(item => item.kind === 'message' && item.role === 'user')).toBe(false);
});

it('a receipt arriving during another autonomous cycle completes only its already committed message', async () => {
  const receipt = Promise.withResolvers<SessionPromptReceipt>();
  const prompt = vi.fn(() => receipt.promise);
  const cell = new SessionCell({ sessionId: 'late', projectId: 'p', providerId: 'fixture', acpSessionId: 's',
    agent: { prompt, cancel: vi.fn(async () => {}) } as unknown as AcpAgentApi,
    resolveAttachment: async () => ({ data: '', mimeType: 'image/png' }), logger: noopLogger });
  cell.applySessionReady();
  const sent = cell.promptDetached({ text: 'question' });
  await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
  cell.push({ kind: 'message', role: 'user', messageId: 'user', text: 'question' });
  cell.push({ kind: 'agent_state', source: 'agent', state: 'running' });
  cell.push({ kind: 'agent_state', source: 'agent', state: 'idle', stopReason: 'max_tokens' });
  cell.push({ kind: 'agent_state', source: 'agent', state: 'running' });
  cell.push({ kind: 'message', role: 'assistant', messageId: 'autonomous', text: 'follow-up' });
  receipt.resolve({ status: 'accepted', requestId: 'r', messageId: 'user' });
  expect(await sent.completion).toMatchObject({ success: true });
  expect(cell.sessionState.lifecycle).toBe('working');
  expect(cell.history().committed[0].outcome).toMatchObject({ kind: 'done', reason: 'max_tokens' });
  cell.push({ kind: 'agent_state', source: 'agent', state: 'idle', stopReason: 'error', error: { code: 1, message: 'autonomous failure' } });
  expect(cell.history().committed[1].outcome).toMatchObject({ kind: 'error' });
});


it.each([false, true])('request-activity cancellation waits for both concurrent replies (reverse=%s)', async reverse => {
  const replies: ReturnType<typeof Promise.withResolvers<{ stopReason: 'cancelled' }>>[] = [];
  const raw = { prompt: vi.fn(() => {
    const reply = Promise.withResolvers<{ stopReason: 'cancelled' }>();
    replies.push(reply);
    return reply.promise;
  }), cancel: vi.fn(async () => {}) };
  const { agent, observe } = createRequestActivity(raw as never, ({ event }) => cell.push(event));
  const cell = new SessionCell({ sessionId: 'v1', projectId: 'p', providerId: 'fixture', acpSessionId: 's', agent,
    resolveAttachment: async () => ({ data: '', mimeType: 'image/png' }), logger: noopLogger });
  cell.applySessionReady();
  const first = cell.promptDetached({ text: 'first' });
  await vi.waitFor(() => expect(raw.prompt).toHaveBeenCalledTimes(1));
  // The provider's first event admits the request and makes it running.
  observe('s', { kind: 'message' });
  const second = cell.promptDetached({ text: 'second' }, { steerIfBusy: true });
  await vi.waitFor(() => expect(raw.prompt).toHaveBeenCalledTimes(2));
  await cell.cancel();
  replies[reverse ? 1 : 0].resolve({ stopReason: 'cancelled' });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(cell.sessionState.lifecycle).toBe('cancelling');
  replies[reverse ? 0 : 1].resolve({ stopReason: 'cancelled' });
  await Promise.all([first.completion, second.completion]);
  expect(cell.sessionState.lifecycle).toBe('ready');
  expect(cell.history().committed).toHaveLength(1);
  expect(cell.history().committed[0].outcome).toEqual({ kind: 'cancelled', reason: 'cancelled' });
});
