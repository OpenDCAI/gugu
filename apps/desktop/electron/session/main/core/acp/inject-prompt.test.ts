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
  it('publishes uncertainty and joins the original late admission instead of submitting another input', async () => {
    const late = Promise.withResolvers<{ queued: boolean }>();
    const uncertain = { name: 'AdmissionUncertain', message: 'No native activity', code: 'prompt_admission_timeout' };
    const promptDetached = vi.fn(async () => ({ requestId: 'original', queued: false, declined: false, uncertain }));
    const waitPromptDetached = vi.fn((input: { admissionOnly?: boolean }) => input.admissionOnly ? late.promise : Promise.resolve({ queued: false }));
    state.client = { promptDetached, waitPromptDetached };
    const onUncertain = vi.fn();
    const pending = injectEmdashPromptDetached('conv-1', 'original input', { origin: 'communication', onUncertain });
    await vi.waitFor(() => expect(onUncertain).toHaveBeenCalledExactlyOnceWith(uncertain));
    expect(waitPromptDetached).toHaveBeenCalledExactlyOnceWith({ requestId: 'original', admissionOnly: true });
    late.resolve({ queued: false });
    const result = await pending;
    await result.completion;
    expect(result).toMatchObject({ outcome: 'started', turnId: 'original' });
    expect(promptDetached).toHaveBeenCalledTimes(1);
    expect(waitPromptDetached.mock.calls).toEqual([[{ requestId: 'original', admissionOnly: true }], [{ requestId: 'original' }]]);
  });

  it('keeps client custody through the real runtime queue and its transcript', async () => {
    const { runtime, finish } = await busySession();
    const deliveries = [];
    for (const clientMessageId of ['client-single', 'client-triple']) {
      deliveries.push(await injectEmdashPromptDetached('conv-1', clientMessageId, { clientMessageId }));
    }
    expect(runtime.getSessionState('conv-1').queuedPrompts.map(prompt => prompt.clientMessageId))
      .toEqual(['client-single', 'client-triple']);
    await finish();
    await Promise.all(deliveries.map(delivery => delivery.completion));
    await vi.waitFor(() => {
      const history = runtime.getHistory('conv-1');
      if (!history.success) throw new Error('History unavailable');
      expect(history.data.turns.flatMap(turn => turn.items.flatMap(item => item.kind === 'message' && item.role === 'user'
        && item._meta?.guguClientMessageId ? [item._meta.guguClientMessageId] : [])))
        .toEqual(['client-single', 'client-triple']);
    });
  });

  it('keeps image references on the same native prompt instead of making a second input', async () => {
    const promptDetached = vi.fn(async () => ({ requestId: 'native-1', queued: true }));
    state.client = { promptDetached, waitPromptDetached: async () => ({}) };
    const attachments = [{ type: 'attachment' as const, id: 'image-a', mimeType: 'image/png' as const }];
    const result = await injectEmdashPromptDetached('conv-1', 'caption', { origin: 'manual', attachments });
    await result.completion;
    expect(promptDetached).toHaveBeenCalledExactlyOnceWith({ sessionId: 'conv-1', prompt: { text: 'caption', origin: 'manual', attachments } });
  });
  it('keeps several idle-only replies as separate user messages with exact provider-visible text', async () => {
    const { harness, runtime, finish } = await busySession();
    const texts = ['Check the first result.\nKeep this line.', 'Check the second result.', 'Check the third result.'];
    const deliveries = [];
    for (const text of texts) deliveries.push(await injectEmdashPromptDetached('conv-1', text));
    expect(deliveries.map(delivery => delivery.outcome)).toEqual(['queued', 'queued', 'queued']);
    await finish();
    await Promise.all(deliveries.map(delivery => delivery.completion));
    await harness.agent.called('prompt', texts.length + 1);
    const sent = harness.agent.prompt.mock.calls.slice(1).map(([request]) => request.prompt);
    expect(sent).toEqual(texts.map(text => [{ type: 'text', text }]));
    const history = runtime.getHistory('conv-1');
    expect(history.success).toBe(true);
    if (!history.success) throw new Error('History unavailable');
    const userTexts = history.data.turns.flatMap(turn => turn.items.flatMap(item =>
      item.kind === 'message' && item.role === 'user' ? [item.text] : []));
    expect(userTexts).toEqual(['Run the long tool', ...texts]);
  });

  it('keeps human DMs in the same editable manual queue as project prompts', async () => {
    const { harness, runtime, finish } = await busySession();
    const envelopes = ['first request', 'second request'].map((content, index) => renderDeliveryEnvelope({
      route: 'chat', chat: 'dm-1', chatKind: 'ai', from: 'Owner', fromId: 'user:owner', fromType: 'human',
      messageId: `msg:human-${index}`, at: '2026-10-24 20:00 UTC', content,
    }));
    const deliveries = [];
    for (const text of envelopes) deliveries.push(await injectEmdashPromptDetached('conv-1', text));
    const state = runtime.getSessionState('conv-1');
    expect(state.queuedPrompts.map(prompt => prompt.origin)).toEqual(['manual', 'manual']);
    await finish();
    await Promise.all(deliveries.map(delivery => delivery.completion));
    await harness.agent.called('prompt', envelopes.length + 1);
    expect(harness.agent.prompt.mock.calls.slice(1).map(([request]) => request.prompt))
      .toEqual(envelopes.map(text => [{ type: 'text', text }]));
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
    await harness.agent.called('prompt', 2);
    expect(harness.agent.prompt.mock.calls.slice(1).map(([request]) => request.prompt)).toEqual([
      [{ type: 'text', text: mergeDeliveryEnvelopes(envelopes) }],
    ]);
  });
});
