import { decodeSessionUpdate } from '@gugu/session-core/acp';
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
  it.each(['claude', 'codex'])('%s admits a source once across stop and resume', async (providerId) => {
    const h = makeAcpHarness({ providerId, recoverDelivery: recoverDeliveryEnvelopes });
    h.agent.initialize.mockResolvedValue({
      protocolVersion: 1, agentCapabilities: { loadSession: true },
      _meta: { steering: { supported: true } },
    });
    h.agent.extMethod.mockResolvedValue({ outcome: 'injected' });
    h.agent.prompt.mockImplementationOnce(() => new Promise(() => {}));
    const rt = new AcpRuntime(h.deps);
    const start = makeStartInput({ providerId, sessionId: 'stop-dedup' });
    expect(isOk(await rt.startSession(start))).toBe(true);
    expect(isOk(rt.promptDetached(start.sessionId, { text: 'long task', origin: 'manual' }))).toBe(true);
    await h.agent.called('prompt');
    expect(isOk(await rt.sendPrompt(start.sessionId, { text: DELIVERY, origin: 'communication' }, { steerIfBusy: true }))).toBe(true);
    await rt.stopSession(start.sessionId);
    expect(h.deps.promptQueueStore?.load(start.sessionId)).toHaveLength(1);

    // Canonical provider history, not the host's optimistic row recorded at admission.
    h.agent.loadSession.mockImplementation(async () => {
      await h.client().sessionEvent({
        sessionId: 'session-1',
        event: decodeSessionUpdate({
          sessionUpdate: 'user_message_chunk', messageId: 'native-persisted-user',
          content: { type: 'text', text: DELIVERY },
        }),
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

  it.each(['claude', 'codex'])('%s sends an unsent delivery behind the owner; an assistant quote is not a receipt', async (providerId) => {
    const h = makeAcpHarness({ providerId, recoverDelivery: recoverDeliveryEnvelopes });
    h.agent.prompt.mockImplementationOnce(() => new Promise(() => {}));
    const rt = new AcpRuntime(h.deps);
    const start = makeStartInput({ providerId, sessionId: 'owner-then-delivery' });
    await rt.startSession(start);
    rt.promptDetached(start.sessionId, { text: 'long task', origin: 'manual' });
    await h.agent.called('prompt');
    await rt.queuePrompt(start.sessionId, { text: 'owner queued input', origin: 'manual' });
    await rt.queuePrompt(start.sessionId, { text: DELIVERY, origin: 'communication' });
    await rt.stopSession(start.sessionId);
    h.agent.loadSession.mockImplementation(async () => {
      await h.client().sessionEvent({ sessionId: 'session-1', event: decodeSessionUpdate({
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: DELIVERY },
      } as SessionUpdate) });
      return {};
    });
    await rt.startSession({ ...start, providerSessionId: 'session-1' });
    await vi.waitFor(() => expect(h.agent.prompt).toHaveBeenCalledTimes(3));
    expect(h.agent.prompt.mock.calls.map(([request]) => requestText(request as PromptRequest)))
      .toEqual(['long task', 'owner queued input', DELIVERY]);
  });

  it('replays an explicitly unknown history even when partial user replay contains the id, and marks the envelope', async () => {
    const h = makeAcpHarness({ providerId: 'codex', recoverDelivery: recoverDeliveryEnvelopes });
    const rt = new AcpRuntime(h.deps);
    h.agent.loadSession.mockImplementation(async () => {
      await h.client().sessionEvent({ sessionId: 'native-old', event: decodeSessionUpdate({
        sessionUpdate: 'user_message_chunk', content: { type: 'text', text: DELIVERY },
      } as SessionUpdate) });
      throw new RequestError(-32015, 'History unknown', {
        kind: 'history_unknown', sessionId: 'native-old', reason: 'history read failed',
      });
    });
    const result = await rt.startSession(makeStartInput({
      providerId: 'codex', sessionId: 'unknown-history', providerSessionId: 'native-old',
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

  it.each(['claude', 'codex'])('%s resumed without replay drops a delivery the host found in the record (#980)', async (providerId) => {
    const h = makeAcpHarness({ providerId, recoverDelivery: recoverDeliveryEnvelopes });
    const rt = new AcpRuntime(h.deps);
    expect(isOk(await rt.startSession(makeStartInput({
      providerId, sessionId: 'no-replay-received', providerSessionId: 'native-old',
      replayHistory: false, recordedDeliveryIds: ['msg:accepted-1'],
      initialQueue: [{ text: DELIVERY, origin: 'communication' }],
    })))).toBe(true);
    await vi.waitFor(() => expect(rt.getSessionState('no-replay-received').lifecycle).toBe('ready'));
    expect(h.agent.loadSession.mock.calls[0][0]._meta).toMatchObject({ history: { replay: false } });
    expect(h.agent.prompt).not.toHaveBeenCalled();
    expect(h.deps.promptQueueStore?.load('no-replay-received')).toEqual([]);
  });

  it('resumed without replay numbers new turns after the stored ones instead of from zero (#980)', async () => {
    const h = makeAcpHarness({ providerId: 'claude', recoverDelivery: recoverDeliveryEnvelopes });
    const rt = new AcpRuntime(h.deps);
    expect(isOk(await rt.startSession(makeStartInput({
      providerId: 'claude', sessionId: 'no-replay-ids', providerSessionId: 'native-old',
      replayHistory: false, recordedDeliveryIds: [], turnIndexBase: 7,
    })))).toBe(true);
    await vi.waitFor(() => expect(rt.getSessionState('no-replay-ids').lifecycle).toBe('ready'));
    expect(isOk(await rt.sendPrompt('no-replay-ids', { text: 'hello again', origin: 'manual' }))).toBe(true);
    await vi.waitFor(() => expect(rt.getChatHistory('no-replay-ids').committed.length
      + (rt.getChatHistory('no-replay-ids').active ? 1 : 0)).toBeGreaterThan(0));
    const history = rt.getChatHistory('no-replay-ids');
    const first = history.committed[0] ?? history.active;
    expect(first?.id).toBe('no-replay-ids:turn:7');
  });

  it('resumed without replay and an unreadable record redelivers marked as possibly received (#980)', async () => {
    const h = makeAcpHarness({ providerId: 'codex', recoverDelivery: recoverDeliveryEnvelopes });
    const rt = new AcpRuntime(h.deps);
    expect(isOk(await rt.startSession(makeStartInput({
      providerId: 'codex', sessionId: 'no-replay-unknown', providerSessionId: 'native-old',
      replayHistory: false, recordedDeliveryIds: null,
      initialQueue: [{ text: DELIVERY, origin: 'communication' }],
    })))).toBe(true);
    await vi.waitFor(() => expect(h.agent.prompt).toHaveBeenCalledTimes(1));
    expect(requestText(h.agent.prompt.mock.calls[0][0] as PromptRequest)).toContain('possibly_received="true"');
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

  it.each([
    ['retired batch', '[route=session-direct from_id=session:b msg=msg:one at=now] first\n[route=session-direct from_id=session:b msg=msg:two at=now] second'],
    ['envelope with trailing text', `${DELIVERY}\nadditional retained text`],
    ['unrecognized text', 'legacy communication without an envelope'],
  ])('opens with unknown Codex history and redelivers %s unchanged', async (_kind, text) => {
    const h = makeAcpHarness({ providerId: 'codex', recoverDelivery: recoverDeliveryEnvelopes });
    h.agent.loadSession.mockRejectedValue(new RequestError(-32015, 'History unknown', {
      kind: 'history_unknown', sessionId: 'native-old', reason: 'history read failed',
    }));
    const rt = new AcpRuntime(h.deps);
    const sessionId = 'unknown-legacy';
    expect(isOk(await rt.startSession(makeStartInput({
      providerId: 'codex', sessionId, providerSessionId: 'native-old',
      initialQueue: [{ text, origin: 'communication' }],
    })))).toBe(true);
    await vi.waitFor(() => expect(h.agent.prompt).toHaveBeenCalledTimes(1));
    expect(requestText(h.agent.prompt.mock.calls[0][0] as PromptRequest)).toBe(text);
    expect(h.deps.promptQueueStore?.load(sessionId)).toEqual([]);
    expect(h.agent.newSession).not.toHaveBeenCalled();
    expect(JSON.stringify(rt.getChatHistory(sessionId))).toContain('History unknown: history read failed');
  });
});
