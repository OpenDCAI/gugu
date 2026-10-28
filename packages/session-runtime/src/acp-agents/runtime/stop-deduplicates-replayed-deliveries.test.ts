import { RequestError, type SessionUpdate } from '@agentclientprotocol/sdk';
import { isOk } from '@gugu/session-shared';
import { describe, expect, it, vi } from 'vitest';
import { makeAcpHarness, makeStartInput } from '../acp-test-support';
import { AcpRuntime } from './runtime';
import { recoverDeliveryEnvelopes } from '../../../../core/src/local/agent/deliveryEnvelope';

const DELIVERY = '<gugu_delivery route="chat" from="B" from_id="user:b" chat="test" msg="msg:accepted-1"><![CDATA[accepted ping]]></gugu_delivery>';
type PromptRequest = { prompt: Array<{ type: string; text?: string }> };
const requestText = (request: PromptRequest) => request.prompt
  .filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n');

describe('a stopped native delivery already in provider history', () => {
  it('is admitted once across stop and resume, instead of submitting the same source message again', async () => {
    const h = makeAcpHarness({ recoverDelivery: recoverDeliveryEnvelopes });
    h.agent.initialize.mockResolvedValue({
      protocolVersion: 1, agentCapabilities: { loadSession: true },
      _meta: { steering: { supported: true } },
    });
    h.agent.extMethod.mockResolvedValue({ outcome: 'injected' });
    h.agent.prompt.mockImplementationOnce(() => new Promise(() => {}));
    const rt = new AcpRuntime(h.deps);
    const start = makeStartInput({ sessionId: 'stop-dedup' });
    expect(isOk(await rt.startSession(start))).toBe(true);
    expect(isOk(rt.promptDetached(start.sessionId, { text: 'long task', origin: 'manual' }))).toBe(true);
    await h.agent.called('prompt');
    expect(isOk(await rt.sendPrompt(start.sessionId, { text: DELIVERY, origin: 'communication' }, { steerIfBusy: true }))).toBe(true);
    await rt.stopSession(start.sessionId);
    expect(h.deps.promptQueueStore?.load(start.sessionId)).toHaveLength(1);

    // Canonical provider history, not the host's optimistic row recorded at admission.
    h.agent.loadSession.mockImplementation(async () => {
      await h.client().sessionUpdate({
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'user_message_chunk', messageId: 'native-persisted-user',
          content: { type: 'text', text: DELIVERY },
        } as SessionUpdate,
      });
      return {};
    });
    expect(isOk(await rt.startSession({ ...start, providerSessionId: 'session-1' }))).toBe(true);
    await vi.waitFor(() => expect(rt.getSessionState(start.sessionId).lifecycle).toBe('ready'));
    expect(isOk(await rt.sendPrompt(start.sessionId, { text: 'next explicit input', origin: 'manual' }))).toBe(true);

    const steers = h.agent.extMethod.mock.calls
      .filter(([method]) => method === '_session/steering')
      .map(([, request]) => requestText(request as PromptRequest));
    const prompts = h.agent.prompt.mock.calls.map(([request]) => requestText(request as PromptRequest));
    expect([...steers, ...prompts].filter((text) => text.includes('msg="msg:accepted-1"'))).toHaveLength(1);
  });

  it('sends an unsent delivery behind the owner once; an assistant quote is not a user receipt', async () => {
    const h = makeAcpHarness({ recoverDelivery: recoverDeliveryEnvelopes });
    h.agent.prompt.mockImplementationOnce(() => new Promise(() => {}));
    const rt = new AcpRuntime(h.deps);
    const start = makeStartInput({ sessionId: 'owner-then-delivery' });
    await rt.startSession(start);
    rt.promptDetached(start.sessionId, { text: 'long task', origin: 'manual' });
    await h.agent.called('prompt');
    await rt.queuePrompt(start.sessionId, { text: 'owner queued input', origin: 'manual' });
    await rt.queuePrompt(start.sessionId, { text: DELIVERY, origin: 'communication' });
    await rt.stopSession(start.sessionId);
    h.agent.loadSession.mockImplementation(async () => {
      await h.client().sessionUpdate({ sessionId: 'session-1', update: {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: DELIVERY },
      } });
      return {};
    });
    await rt.startSession({ ...start, providerSessionId: 'session-1' });
    await vi.waitFor(() => expect(h.agent.prompt).toHaveBeenCalledTimes(3));
    expect(h.agent.prompt.mock.calls.map(([request]) => requestText(request as PromptRequest)))
      .toEqual(['long task', 'owner queued input', DELIVERY]);
  });

  it('replays an explicitly unknown history even when partial user replay contains the id, and marks the envelope', async () => {
    const h = makeAcpHarness({ recoverDelivery: recoverDeliveryEnvelopes });
    const rt = new AcpRuntime(h.deps);
    h.agent.loadSession.mockImplementation(async () => {
      await h.client().sessionUpdate({ sessionId: 'native-old', update: {
        sessionUpdate: 'user_message_chunk', content: { type: 'text', text: DELIVERY },
      } });
      throw new RequestError(-32015, 'History unknown', {
        kind: 'history_unknown', sessionId: 'native-old', reason: 'history read failed',
      });
    });
    const result = await rt.startSession(makeStartInput({
      sessionId: 'unknown-history', providerSessionId: 'native-old',
      initialQueue: [{ text: DELIVERY, origin: 'communication' }],
    }));
    expect(isOk(result)).toBe(true);
    await vi.waitFor(() => expect(h.agent.prompt).toHaveBeenCalledTimes(1));
    const text = requestText(h.agent.prompt.mock.calls[0][0] as PromptRequest);
    expect(text).toContain('msg="msg:accepted-1"');
    expect(text).toContain('possibly_received="true"');
    expect(text).toContain('This message may already have been received.');
    expect(h.agent.newSession).not.toHaveBeenCalled();
    expect(JSON.stringify(rt.getChatHistory('unknown-history'))).toContain('History unknown: history read failed');
  });

  it('does not mistake an ordinary failed load or another thread receipt for history_unknown', async () => {
    for (const error of [new Error('ordinary load failure'), Object.assign(new Error('wrong thread'), {
      data: { kind: 'history_unknown', sessionId: 'another-thread', reason: 'read failed' },
    })]) {
      const h = makeAcpHarness({ recoverDelivery: recoverDeliveryEnvelopes });
      h.agent.loadSession.mockRejectedValue(error);
      const rt = new AcpRuntime(h.deps);
      expect(isOk(await rt.startSession(makeStartInput({
        sessionId: 'failed-history', providerSessionId: 'native-old',
        initialQueue: [{ text: DELIVERY, origin: 'communication' }],
      })))).toBe(false);
      expect(h.agent.prompt).not.toHaveBeenCalled();
    }
  });
});
