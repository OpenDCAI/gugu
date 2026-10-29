import { PassThrough, Writable } from 'node:stream';
import * as v2 from '@agentclientprotocol/sdk/experimental/v2';
import type { AcpAgentApi } from '@gugu/session-core/agents/plugins';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeAcpHarness, makeStartInput } from '../../../../packages/session-runtime/src/acp-agents/acp-test-support';
import { AcpRuntime } from '../../../../packages/session-runtime/src/acp-agents/runtime/runtime';
import { createAcpProcedures } from '../../../../packages/session-runtime/src/acp-agents/api/procedures';
import { connectStdioAcpV2 } from '../../../../packages/session-plugins/src/agents/helpers/acp-v2';
import { nodeReadableToWeb } from '../../../../packages/session-plugins/src/agents/helpers/acp-stdio';

vi.mock('../../../../apps/desktop/electron/lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));
import { emdashAgentRegistry } from '../../../../apps/desktop/electron/sessionpage/emdash-agent-registry';
import { SessionpageLocalDeliveryRouter } from '../../../../apps/desktop/electron/sessionpage/session-injection';

function delivery(runtime: AcpRuntime, sessionId: string, wake: () => Promise<void>) {
  const api = createAcpProcedures(runtime);
  emdashAgentRegistry.setBridge({
    emdashSessionSummaries: async () => [{ sessionId, providerId: 'claude', ...runtime.getSessionState(sessionId) }],
    injectEmdashPromptDetached: async (target, text, opts) => {
      const result = await api.promptDetached({ sessionId: target, prompt: { text, origin: 'communication' }, steerIfBusy: opts?.steerIfBusy });
      return {
        outcome: result.declined ? 'declined' : result.queued ? 'queued' : 'started',
        turnId: result.requestId,
        completion: api.waitPromptDetached({ requestId: result.requestId }).then(() => {}),
      };
    },
  });
  const router = new SessionpageLocalDeliveryRouter([emdashAgentRegistry], { wakeSession: wake, processRunning: () => false });
  return (text: string) => router.injectWithWake(sessionId, async () => {
    const result = await emdashAgentRegistry.tryInjectSessionMessage(sessionId, { id: text, text, kind: 'session-direct' });
    return result === false ? 'not-live' : result;
  });
}

describe('native admission through local message delivery', () => {
  afterEach(() => emdashAgentRegistry.setBridge(null));

  it('does not accept a real v2 request cancelled before native admission', async () => {
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const native = vi.fn(async () => { throw new v2.RequestError(-32800, 'Request cancelled'); });
    v2.agent({ name: 'cancel-before-admission' })
      .onRequest(v2.methods.agent.initialize, async () => ({
        protocolVersion: 2, info: { name: 'cancel-before-admission', version: '1' }, capabilities: {},
      }))
      .onRequest(v2.methods.agent.session.prompt, native)
      .connect(v2.ndJsonStream(Writable.toWeb(toClient) as WritableStream<Uint8Array>, nodeReadableToWeb(toAgent)));
    const transport = connectStdioAcpV2({ stdin: toAgent, stdout: toClient }, () => ({
      sessionEvent: () => {}, requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    }) as never);
    await transport.initialize({ protocolVersion: 1 });
    const h = makeAcpHarness({ nativeState: true });
    const accepted = vi.fn();
    // The host's prompt goes through the real v2 transport; its receipt is the only admission.
    h.agent.prompt = vi.fn<AcpAgentApi['prompt']>((params, dispatch) => transport.prompt(params, dispatch).then(receipt => { accepted(); return receipt; }));
    const runtime = new AcpRuntime(h.deps);
    const input = makeStartInput({ sessionId: 'cancelled-before-admission' });
    const wake = vi.fn(async () => {});
    try {
      expect((await runtime.startSession(input)).success).toBe(true);
      await expect(delivery(runtime, input.sessionId, wake)('never admitted')).rejects.toThrow('Request cancelled');
      expect(native).toHaveBeenCalledTimes(1);
      expect(accepted).not.toHaveBeenCalled();
      expect(wake).not.toHaveBeenCalled();
      expect(h.lastChild.kill).not.toHaveBeenCalled();
      expect(runtime.getSessionState(input.sessionId).lastTurnOutcome).toBe('stopped');
      const history = runtime.getHistory(input.sessionId);
      expect(history.success).toBe(true);
      if (!history.success) throw new Error('cancelled turn history unavailable');
      expect(history.data.turns.at(-1)?.outcome).toEqual({ kind: 'cancelled', reason: 'cancelled' });
    } finally {
      await runtime.dispose();
      toAgent.end();
      toClient.end();
    }
  });

  it('resumes and redelivers the same message after native steering finds an ended executor', async () => {
    const h = makeAcpHarness({ nativeState: true });
    h.agent.initialize.mockResolvedValue({ protocolVersion: 2, agentCapabilities: { loadSession: true }, _meta: { steering: { supported: true } } });
    h.agent.extMethod.mockRejectedValue(Object.assign(new Error('native executor ended'), { code: -32603 }));
    // After recovery the provider takes the redelivered message: it echoes it, then returns the native receipt.
    h.agent.prompt = vi.fn<AcpAgentApi['prompt']>(async (_params, dispatch) => {
      h.client().sessionEvent({ sessionId: 'session-1', event: { kind: 'agent_state', source: 'agent', state: 'running' } });
      h.client().sessionEvent({ sessionId: 'session-1', event: { kind: 'message', role: 'user', messageId: 'redelivered', text: dispatch!.message.text, contentMode: 'replace' } });
      return { status: 'accepted', requestId: dispatch!.requestId, messageId: 'redelivered' };
    });
    const runtime = new AcpRuntime(h.deps);
    const input = makeStartInput({ sessionId: 'ended-steering' });
    const wake = vi.fn(async () => {
      const result = await runtime.startSession(input);
      if (!result.success) throw new Error(result.error.message);
    });
    try {
      expect((await runtime.startSession(input)).success).toBe(true);
      h.client().sessionEvent({ sessionId: 'session-1', event: { kind: 'agent_state', source: 'agent', state: 'running' } });
      expect(runtime.getSessionState(input.sessionId).lifecycle).toBe('working');
      await expect(delivery(runtime, input.sessionId, wake)('same unaccepted message')).resolves.toMatchObject({ turnId: expect.any(String) });
      expect(h.agent.extMethod).toHaveBeenCalledExactlyOnceWith('_session/steering', expect.objectContaining({
        sessionId: 'session-1', prompt: [{ type: 'text', text: 'same unaccepted message' }],
      }));
      expect(wake).toHaveBeenCalledTimes(1);
      expect(h.children).toHaveLength(2);
      expect(h.agent.newSession).toHaveBeenCalledTimes(1);
      expect(h.agent.loadSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: 'session-1' }));
      expect(h.agent.prompt).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        sessionId: 'session-1', prompt: [{ type: 'text', text: 'same unaccepted message' }],
      }), expect.objectContaining({ requestId: expect.any(String) }));
    } finally {
      await runtime.dispose();
    }
  });
});
