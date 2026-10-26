import { afterEach, describe, expect, it, vi } from 'vitest';
import { acpRuntimeApiContract } from '@gugu/session-core/acp';
import { defineContract } from '@gugu/session-wire';
import { createTestWire } from '@gugu/session-wire/testing';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { makeAcpHarness, makeStartInput } from '../acp-test-support';
import { AcpRuntime } from './runtime';
import { createAcpProcedures } from '../api/procedures';

const runtimes: AcpRuntime[] = [];
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.dispose(); });

async function setup(reportsState = false) {
  const h = makeAcpHarness({ reportsState });
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


describe('admission review boundaries', () => {
  it('keeps the missing marker across the fully validated runtime wire', async () => {
    const { h, api } = await setup();
    h.agent.prompt.mockRejectedValueOnce(Object.assign(new Error('Internal error'), {
      code: -32603, data: { details: 'Session not found' },
    }));
    const wire = createTestWire(defineContract({ promptDetached: acpRuntimeApiContract.promptDetached }),
      { promptDetached: api.promptDetached }, { validate: 'full' });
    try {
      await expect(wire.client.promptDetached({ sessionId: 'conv-1', prompt: { text: 'hi', origin: 'communication' } }))
        .resolves.toMatchObject({ declined: true, missing: true });
    } finally { wire.dispose(); }
  });

  it.each(['ECONNRESET', 'upstream quota exhausted', '401 Unauthorized'])(
    'owns a real provider failure before output and reports its original cause once: %s', async cause => {
      const { h, rt, api } = await setup();
      h.agent.prompt.mockRejectedValueOnce(new Error(cause));
      const admitted = await api.promptDetached({ sessionId: 'conv-1', prompt: { text: 'hi', origin: 'communication' } });
      expect(admitted.declined).toBe(false);
      await expect(api.waitPromptDetached({ requestId: admitted.requestId })).rejects.toThrow(cause);
      await expect(api.waitPromptDetached({ requestId: admitted.requestId })).rejects.toThrow('was not found');
      expect(h.agent.prompt).toHaveBeenCalledTimes(1);
      expect(rt.sessionsListLiveModel().states.list.snapshot().data['conv-1'])
        .toMatchObject({ isGenerating: false, lastTurnOutcome: 'errored' });
    });
});


describe('stopping recovery', () => {
  it('waits for a pending process exit before admitting a wake, then resumes the same provider session', async () => {
    const { h, rt } = await setup();
    const child = h.lastChild;
    child.kill.mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const stopped = rt.stopSession('conv-1');
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await stopped).toMatchObject({ success: false, error: { type: 'stop_pending' } });
      let wakeSettled = false;
      const wake = rt.startSession(makeStartInput({ providerSessionId: 'session-1' }));
      void wake.then(() => { wakeSettled = true; });
      await vi.advanceTimersByTimeAsync(1);
      const settledBeforeExit = wakeSettled;
      child.emitExit(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(await wake).toMatchObject({ success: true });
      expect(settledBeforeExit).toBe(false);
      expect(h.agent.loadSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1' }));
      expect(child.kill.mock.calls.every(([signal]) => signal === 'SIGTERM')).toBe(true);
    } finally { child.emitExit(0); vi.useRealTimers(); }
  });

  it('retries process teardown after provider close succeeded but signalling failed', async () => {
    const { h, rt, api } = await setup();
    h.lastChild.kill.mockImplementationOnce(() => { throw new Error('signal delivery failed'); });
    expect(await rt.stopSession('conv-1')).toMatchObject({ success: false, error: { type: 'stop_failed' } });
    expect(await rt.startSession(makeStartInput({ providerSessionId: 'session-1' }))).toMatchObject({ success: true });
    expect(h.agent.loadSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1' }));
    const admitted = await api.promptDetached({ sessionId: 'conv-1', prompt: { text: 'hi', origin: 'communication' } });
    expect(admitted.declined).toBe(false);
    await api.waitPromptDetached({ requestId: admitted.requestId });
  });

  it('treats provider Session not found during missing-session teardown as already closed', async () => {
    const { h, api } = await setup();
    const missing = () => Object.assign(new Error('Internal error'), { code: -32603, data: { details: 'Session not found' } });
    h.agent.prompt.mockRejectedValueOnce(missing());
    h.agent.closeSession.mockRejectedValueOnce(missing());
    await expect(api.promptDetached({ sessionId: 'conv-1', prompt: { text: 'hi', origin: 'communication' } }))
      .resolves.toMatchObject({ declined: true, missing: true });
  });
});


describe('bounded native admission', () => {
  it('does not time out a long turn after its first native output', async () => {
    const { h, api } = await setup();
    const finish = Promise.withResolvers<{ stopReason: 'end_turn' }>();
    h.agent.prompt.mockImplementationOnce(() => finish.promise);
    vi.useFakeTimers();
    try {
      const pending = api.promptDetached({ sessionId: 'conv-1', prompt: { text: 'hi', origin: 'communication' } });
      await vi.advanceTimersByTimeAsync(59_000);
      await h.client().sessionUpdate({ sessionId: 'session-1', update: {
        sessionUpdate: 'agent_message_chunk', messageId: 'first-output', content: { type: 'text', text: 'Working' },
      } as SessionUpdate });
      const receipt = await pending;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(h.agent.cancel).not.toHaveBeenCalled();
      finish.resolve({ stopReason: 'end_turn' });
      await expect(api.waitPromptDetached({ requestId: receipt.requestId })).resolves.toMatchObject({ queued: false });
    } finally { finish.resolve({ stopReason: 'end_turn' }); vi.useRealTimers(); }
  });

  it('ends a silent first prompt once, reports timeout, and tears down its provider before another turn', async () => {
    const { h, rt, api } = await setup();
    const child = h.lastChild;
    h.agent.prompt.mockImplementationOnce(() => new Promise(() => {}));
    vi.useFakeTimers();
    try {
      let receipt: Awaited<ReturnType<typeof api.promptDetached>> | undefined;
      const pending = api.promptDetached({ sessionId: 'conv-1', prompt: { text: 'hi', origin: 'communication' } });
      void pending.then(value => { receipt = value; });
      await vi.advanceTimersByTimeAsync(60_001);
      expect(receipt, 'a silent native prompt cannot hold the inbox admission forever').toBeDefined();
      if (!receipt) return;
      expect(receipt.declined).toBe(false);
      await expect(api.waitPromptDetached({ requestId: receipt.requestId })).rejects.toThrow('timed out');
      expect(h.agent.cancel).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(rt.sessionLiveModels('conv-1')).toBeNull();
    } finally { vi.useRealTimers(); }
  });
});


it('keeps the recovery signal when a missing provider process is still stopping', async () => {
  const { h, api } = await setup();
  const child = h.lastChild;
  child.kill.mockImplementation(() => {});
  h.agent.prompt.mockRejectedValueOnce(Object.assign(new Error('Internal error'), { code: -32603, data: { details: 'Session not found' } }));
  vi.useFakeTimers();
  try {
    const missing = api.promptDetached({ sessionId: 'conv-1', prompt: { text: 'hi', origin: 'communication' } });
    void missing.catch(() => {});
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(missing).resolves.toMatchObject({ declined: true, missing: true });
  } finally { child.emitExit(0); vi.useRealTimers(); }
});

it('counts a declared native running state as admission, without requiring output text', async () => {
  const { h, api } = await setup(true);
  const finish = Promise.withResolvers<{ stopReason: 'end_turn' }>();
  h.agent.prompt.mockImplementationOnce(() => finish.promise);
  vi.useFakeTimers();
  try {
    let receipt: Awaited<ReturnType<typeof api.promptDetached>> | undefined;
    const pending = api.promptDetached({ sessionId: 'conv-1', prompt: { text: 'hi', origin: 'communication' } });
    void pending.then(value => { receipt = value; });
    await vi.advanceTimersByTimeAsync(1);
    await h.client().sessionUpdate({ sessionId: 'session-1', update: { sessionUpdate: 'state_update', state: 'running' } as unknown as SessionUpdate });
    await vi.advanceTimersByTimeAsync(1);
    expect(receipt).toBeDefined();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.agent.cancel).not.toHaveBeenCalled();
    finish.resolve({ stopReason: 'end_turn' });
    const accepted = await pending;
    await api.waitPromptDetached({ requestId: accepted.requestId });
  } finally { finish.resolve({ stopReason: 'end_turn' }); vi.useRealTimers(); }
});
