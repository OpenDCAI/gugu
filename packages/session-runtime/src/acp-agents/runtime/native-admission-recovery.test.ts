import type { AcpAgentApi } from '@gugu/session-core/agents/plugins';
import { describe, expect, it, vi } from 'vitest';
import { makeAcpHarness, makeStartInput } from '../acp-test-support';
import { createAcpProcedures } from '../api/procedures';
import { AcpRuntime } from './runtime';

async function nativeSession() {
  const harness = makeAcpHarness();
  Object.assign(harness.agent, { protocolVersion: 2 });
  const runtime = new AcpRuntime(harness.deps);
  const input = makeStartInput({ sessionId: 'native-admission' });
  expect((await runtime.startSession(input)).success).toBe(true);
  return { harness, runtime, input, api: createAcpProcedures(runtime) };
}

describe('native prompt admission and recovery', () => {
  it('rejects delivery, retires the refused executor, and resumes the original session for the next prompt', async () => {
    const { harness, runtime, input, api } = await nativeSession();
    const failure = Object.assign(new Error('The Claude Agent session has ended. Please start a new session.'), { name: 'RequestError', code: -32603 });
    harness.agent.prompt.mockRejectedValueOnce(failure);
    await expect(api.promptDetached({ sessionId: input.sessionId, prompt: { text: 'refused', origin: 'communication' } }))
      .rejects.toThrow(failure.message);
    expect(runtime.getSessionState(input.sessionId).lifecycle).toBe('lost');
    expect(runtime.getSessionState(input.sessionId).lastTurnOutcome).toBe('errored');
    expect(harness.lastChild.kill).toHaveBeenCalledWith('SIGTERM');
    const history = runtime.getHistory(input.sessionId);
    expect(history.success).toBe(true);
    if (!history.success) throw new Error('failed session history is unavailable');
    expect(history.data.turns.at(-1)?.outcome).toMatchObject({ kind: 'error', detail: expect.stringContaining(failure.message) });

    const prompt = vi.fn<AcpAgentApi['prompt']>().mockImplementation(async (_request, onAccepted) => {
      onAccepted?.();
      return { stopReason: 'end_turn' };
    });
    harness.agent.prompt = prompt;
    const next = await runtime.queuePrompt(input.sessionId, { text: 'next message' }, input);
    expect(next.success).toBe(true);
    expect(harness.children).toHaveLength(2);
    expect(harness.agent.newSession).toHaveBeenCalledTimes(1);
    expect(harness.agent.loadSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1' }));
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0]?.[0].prompt).toEqual([{ type: 'text', text: 'next message' }]);
    expect(runtime.getSessionState(input.sessionId).lifecycle).toBe('ready');
    await runtime.dispose();
  });

  it('leaves a failed recovery lost and does not submit the incoming message', async () => {
    const { harness, runtime, input, api } = await nativeSession();
    harness.agent.prompt.mockRejectedValueOnce(Object.assign(new Error('native refusal'), { code: -32603 }));
    await expect(api.promptDetached({ sessionId: input.sessionId, prompt: { text: 'refused' } })).rejects.toThrow('native refusal');
    harness.agent.loadSession.mockRejectedValueOnce(new Error('resume failed'));
    const result = await runtime.queuePrompt(input.sessionId, { text: 'unsent' }, input);
    expect(result.success).toBe(false);
    expect(runtime.getSessionState(input.sessionId).lifecycle).toBe('lost');
    expect(harness.agent.newSession).toHaveBeenCalledTimes(1);
    expect(harness.agent.prompt).toHaveBeenCalledTimes(1);
    await runtime.dispose();
  });

  it('returns genuine admission before completion and keeps admitted turn failures on their original executor', async () => {
    const { harness, runtime, input, api } = await nativeSession();
    const turn = Promise.withResolvers<Awaited<ReturnType<AcpAgentApi['prompt']>>>();
    const accept = Promise.withResolvers<() => void>();
    harness.agent.prompt = vi.fn<AcpAgentApi['prompt']>().mockImplementation((_request, onAccepted) => {
      accept.resolve(onAccepted!);
      return turn.promise;
    });
    const detached = api.promptDetached({ sessionId: input.sessionId, prompt: { text: 'accepted' } });
    (await accept.promise)();
    const receipt = await detached;
    expect(receipt.declined).toBe(false);
    turn.reject(Object.assign(new Error('provider turn failed after admission'), { name: 'RequestError', code: -32603 }));
    await expect(api.waitPromptDetached({ requestId: receipt.requestId })).rejects.toThrow('provider turn failed after admission');
    expect(harness.lastChild.kill).not.toHaveBeenCalled();
    expect(runtime.getSessionState(input.sessionId).lifecycle).toBe('ready');
    await runtime.dispose();
  });

  it("a delivery failure carries the provider's sentence from data.details, not the bare JSON-RPC message (qwen quota)", async () => {
    const harness = makeAcpHarness();
    const runtime = new AcpRuntime(harness.deps);
    const input = makeStartInput({ sessionId: 'qwen-quota' });
    expect((await runtime.startSession(input)).success).toBe(true);
    const api = createAcpProcedures(runtime);
    // qwen-code 0.22.3 against an endpoint answering 400 "usage limit" (mac1, 10-28, raw ACP).
    harness.agent.prompt.mockRejectedValueOnce(Object.assign(new Error('Internal error'), {
      name: 'RequestError', code: -32603, data: { details: "400 You've hit your usage limit. Upgrade or try again later." },
    }));
    const delivered = (async () => {
      const receipt = await api.promptDetached({ sessionId: input.sessionId, prompt: { text: 'hi', origin: 'communication' } });
      await api.waitPromptDetached({ requestId: receipt.requestId });
    })();
    await expect(delivered).rejects.toThrow("400 You've hit your usage limit. Upgrade or try again later.");
    await runtime.dispose();
  });

  it('reports invalid input without retiring a usable executor', async () => {
    const { harness, runtime, input, api } = await nativeSession();
    harness.agent.prompt.mockRejectedValueOnce(Object.assign(new Error('invalid prompt'), { code: -32602 }));
    await expect(api.promptDetached({ sessionId: input.sessionId, prompt: { text: 'invalid' } })).rejects.toThrow('invalid prompt');
    expect(harness.lastChild.kill).not.toHaveBeenCalled();
    expect(runtime.getSessionState(input.sessionId).lifecycle).toBe('ready');
    await runtime.dispose();
  });
});
