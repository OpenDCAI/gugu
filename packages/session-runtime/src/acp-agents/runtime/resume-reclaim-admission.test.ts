import { afterEach, describe, expect, it } from 'vitest';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { makeAcpHarness, makeStartInput } from '../acp-test-support';
import { AcpRuntime } from './runtime';
import { createAcpProcedures } from '../api/procedures';

const runtimes: AcpRuntime[] = [];
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.dispose(); });

async function setup() {
  const h = makeAcpHarness();
  const rt = new AcpRuntime(h.deps);
  runtimes.push(rt);
  expect((await rt.startSession(makeStartInput())).success).toBe(true);
  return { h, rt, api: createAcpProcedures(rt) };
}

describe('resume and reclaim admission', () => {
  it('does not reclaim a new turn admitted after the idle sweep took its snapshot', async () => {
    const { h, rt } = await setup();
    let finish!: (value: { stopReason: 'end_turn' }) => void;
    h.agent.prompt.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const running = rt.sendPrompt('conv-1', { text: 'new work' });
    await h.agent.called('prompt');
    const stopped = await rt.stopSession('conv-1', true);
    expect(stopped.success).toBe(false);
    expect(h.agent.closeSession).not.toHaveBeenCalled();
    finish({ stopReason: 'end_turn' });
    expect((await running).success).toBe(true);
  });
  it('withdraws delivery before close, and lets the same conversation resume only after teardown', async () => {
    const { h, rt, api } = await setup();
    let finishClose!: (value: object) => void;
    h.agent.closeSession.mockImplementationOnce(() => new Promise(resolve => { finishClose = resolve; }));
    const stopping = rt.stopSession('conv-1');
    await h.agent.called('closeSession');
    expect(rt.sessionsListLiveModel().states.list.snapshot().data['conv-1']?.closing).toBe(true);
    await expect(api.promptDetached({ sessionId: 'conv-1', prompt: { text: 'hi', origin: 'communication' } }))
      .resolves.toMatchObject({ declined: true });
    expect(h.agent.prompt).not.toHaveBeenCalled();
    const restored = rt.startSession(makeStartInput({ providerSessionId: 'session-1' }));
    expect(h.agent.loadSession).not.toHaveBeenCalled();
    finishClose({});
    expect((await stopping).success).toBe(true);
    expect((await restored).success).toBe(true);
    expect(h.agent.loadSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1' }));
    expect(rt.sessionsListLiveModel().states.list.snapshot().data['conv-1']?.closing).toBeUndefined();
  });

  it('declines a native Session not found before admission and accepts the same message after recovery', async () => {
    const { h, rt, api } = await setup();
    h.agent.prompt.mockRejectedValueOnce(Object.assign(new Error('Internal error'), {
      code: -32603, data: { details: 'Session not found' },
    }));
    const message = { sessionId: 'conv-1', prompt: { text: 'hi', origin: 'communication' as const } };
    await expect(api.promptDetached(message)).resolves.toMatchObject({ declined: true });
    expect(rt.sessionLiveModels('conv-1')).toBeNull();
    expect((await rt.startSession(makeStartInput({ providerSessionId: 'session-1' }))).success).toBe(true);
    const admitted = await api.promptDetached(message);
    expect(admitted.declined).toBe(false);
    await api.waitPromptDetached({ requestId: admitted.requestId });
    expect(h.agent.prompt).toHaveBeenCalledTimes(2);
    expect(rt.sessionsListLiveModel().states.list.snapshot().data['conv-1']).toMatchObject({ lifecycle: 'ready', isGenerating: false });
  });

  it('admits on native output before turn completion, and keeps a later provider failure a real failure', async () => {
    const { h, rt, api } = await setup();
    let fail!: (error: Error) => void;
    h.agent.prompt.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const admission = api.promptDetached({ sessionId: 'conv-1', prompt: { text: 'hi', origin: 'communication' } });
    await h.agent.called('prompt');
    await h.client().sessionUpdate({ sessionId: 'session-1', update: {
      sessionUpdate: 'agent_message_chunk', messageId: 'native-answer',
      content: { type: 'text', text: 'Working' },
    } as SessionUpdate });
    const accepted = await admission;
    expect(accepted.declined).toBe(false);
    fail(Object.assign(new Error('Internal error'), { code: -32603, data: { details: 'Session not found' } }));
    await expect(api.waitPromptDetached({ requestId: accepted.requestId })).rejects.toThrow('Internal error');
    expect(rt.sessionsListLiveModel().states.list.snapshot().data['conv-1']).toMatchObject({
      lifecycle: 'ready', isGenerating: false, lastTurnOutcome: 'errored',
    });
  });
});
