import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeDeliveryEnvelopes, renderDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { AcpRuntime, createAcpProcedures } from '@gugu/session-runtime/acp-agents';
import { makeAcpHarness, makeStartInput } from '../../../../../../../packages/session-runtime/src/acp-agents/acp-test-support';
import { injectEmdashPromptDetached } from './inject-prompt';

const state = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('./runtime-process/host', () => ({ getAcpRuntimeClient: async () => state.client }));
vi.mock('../sessions/session-deferred-messages', () => ({
  withDeferredMessagesBeforeAdmission: (_id: string, text: string, admit: (text: string) => unknown) => admit(text),
}));

const runtimes: AcpRuntime[] = [];
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.dispose(); });

async function busySession() {
  const harness = makeAcpHarness({ mergeEnvelopes: mergeDeliveryEnvelopes });
  const runtime = new AcpRuntime(harness.deps);
  runtimes.push(runtime);
  expect((await runtime.startSession(makeStartInput())).success).toBe(true);
  state.client = createAcpProcedures(runtime);
  let finish!: (result: { stopReason: 'end_turn' }) => void;
  harness.agent.prompt.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const first = runtime.sendPrompt('conv-1', { text: 'Run the long tool', origin: 'manual' });
  await harness.agent.called('prompt');
  return { harness, runtime, finish: async () => { finish({ stopReason: 'end_turn' }); await first; } };
}

describe('shared ACP prompt admission', () => {
  it('keeps several idle-only replies as separate user messages with exact provider-visible text', async () => {
    const { harness, runtime, finish } = await busySession();
    const texts = ['Check the first result.\nKeep this line.', 'Check the second result.', 'Check the third result.'];
    const deliveries = [];
    for (const text of texts) deliveries.push(await injectEmdashPromptDetached('conv-1', text));
    expect(deliveries.map(delivery => delivery.outcome)).toEqual(['queued', 'queued', 'queued']);
    await finish();
    await Promise.all(deliveries.map(delivery => delivery.completion));
    const sent = harness.agent.prompt.mock.calls.slice(1).map(([request]) => request.prompt);
    expect(sent).toEqual(texts.map(text => [{ type: 'text', text }]));
    const history = await runtime.getHistory('conv-1');
    expect(history.success).toBe(true);
    if (!history.success) throw new Error('History unavailable');
    const userTexts = history.data.turns.flatMap(turn => turn.items.flatMap(item =>
      item.kind === 'message' && item.role === 'user' ? [item.text] : []));
    expect(userTexts).toEqual(['Run the long tool', ...texts]);
  });

  it('retains delivery merging for real envelopes', async () => {
    const { harness, finish } = await busySession();
    const envelopes = ['first fact', 'second fact'].map((content, index) => renderDeliveryEnvelope({
      route: 'session-direct', from: 'Another task', fromId: 'session:other', messageId: `msg:${index}`,
      at: '2026-10-24 20:00 UTC', content,
    }));
    const deliveries = [];
    for (const text of envelopes) deliveries.push(await injectEmdashPromptDetached('conv-1', text));
    await finish();
    await Promise.all(deliveries.map(delivery => delivery.completion));
    expect(harness.agent.prompt.mock.calls.slice(1).map(([request]) => request.prompt)).toEqual([
      [{ type: 'text', text: mergeDeliveryEnvelopes(envelopes) }],
    ]);
  });
});
