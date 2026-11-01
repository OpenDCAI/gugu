import { PassThrough, Writable } from 'node:stream';
import * as v2 from '@agentclientprotocol/sdk/experimental/v2';
import type { AcpAgentApi } from '@gugu/session-core/agents/plugins';
import { describe, expect, it, vi } from 'vitest';
import { connectStdioAcpV2 } from '../../../../packages/session-plugins/src/agents/helpers/acp-v2';
import { nodeReadableToWeb } from '../../../../packages/session-plugins/src/agents/helpers/acp-stdio';
import { makeAcpHarness, makeStartInput } from '../../../../packages/session-runtime/src/acp-agents/acp-test-support';
import { AcpRuntime } from '../../../../packages/session-runtime/src/acp-agents/runtime/runtime';
import { createAcpProcedures } from '../../../../packages/session-runtime/src/acp-agents/api/procedures';

/**
 * #552 on the real runtime: the facts session-life's ACP leg turns into a lost channel and one redelivery.
 * An executor that ended before admission refuses the prompt and the runtime marks the session lost (zero bytes taken);
 * the leg reports `channel-lost`, the row goes back to the queue, and a fresh run loads the same provider session,
 * where the same message is admitted once.
 */
describe('#552 native admission recovery (the facts behind channel-lost)', () => {
  it('an ended executor refuses before admission and the session reads lost; a fresh run resumes it and admits the message once', async () => {
    const h = makeAcpHarness({ nativeState: true });
    h.agent.initialize.mockResolvedValue({ protocolVersion: 2, agentCapabilities: { loadSession: true } });
    h.agent.prompt = vi.fn<AcpAgentApi['prompt']>()
      .mockRejectedValueOnce(Object.assign(new Error('Internal error'), { code: -32603, data: { details: 'Session not found' } }))
      .mockImplementation(async (_params, dispatch) => {
        h.client().sessionEvent({ sessionId: 'session-1', event: { kind: 'agent_state', source: 'agent', state: 'running' } });
        h.client().sessionEvent({ sessionId: 'session-1', event: { kind: 'message', role: 'user', messageId: 'dm-accepted', text: dispatch!.message.text, contentMode: 'replace' } });
        return { status: 'accepted', requestId: dispatch!.requestId, messageId: 'dm-accepted' };
      });
    const runtime = new AcpRuntime(h.deps);
    const api = createAcpProcedures(runtime);
    const input = makeStartInput({ sessionId: 'ended-executor' });
    try {
      expect((await runtime.startSession(input)).success).toBe(true);
      // The first dispatch: refused before admission — no byte taken (`missing`, the leg's channel-lost), session gone.
      await expect(api.promptDetached({ sessionId: input.sessionId, prompt: { text: 'same human DM', origin: 'manual' } }))
        .resolves.toMatchObject({ declined: true, missing: true });
      expect(runtime.getSessionState(input.sessionId).lifecycle).toBe('closed'); // the leg reads lost and closed alike
      // The fresh run session-life starts for the row: the same provider session comes back.
      expect((await runtime.startSession({ ...input, providerSessionId: 'session-1' })).success).toBe(true);
      expect(h.agent.loadSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1' }));
      const redelivered = await api.promptDetached({ sessionId: input.sessionId, prompt: { text: 'same human DM', origin: 'manual' } });
      expect(redelivered).toMatchObject({ declined: false });
      h.client().sessionEvent({ sessionId: 'session-1', event: { kind: 'agent_state', source: 'agent', state: 'idle', stopReason: 'end_turn' } });
      await api.waitPromptDetached({ requestId: redelivered.requestId });
      expect(h.agent.newSession).toHaveBeenCalledTimes(1);
      expect(h.agent.prompt).toHaveBeenCalledTimes(2);
      const history = runtime.getHistory(input.sessionId);
      if (!history.success) throw new Error('resumed history unavailable');
      expect(history.data.turns.flatMap(turn => turn.items).filter(item => item.kind === 'message' && item.text === 'same human DM')).toHaveLength(1);
    } finally {
      await runtime.dispose();
    }
  });

  it('does not accept a real v2 request cancelled before native admission (a refusal, not a lost channel)', async () => {
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
    h.agent.prompt = vi.fn<AcpAgentApi['prompt']>((params, dispatch) => transport.prompt(params, dispatch).then(receipt => { accepted(); return receipt; }));
    const runtime = new AcpRuntime(h.deps);
    const api = createAcpProcedures(runtime);
    const input = makeStartInput({ sessionId: 'cancelled-before-admission' });
    try {
      expect((await runtime.startSession(input)).success).toBe(true);
      await expect(api.promptDetached({ sessionId: input.sessionId, prompt: { text: 'never admitted', origin: 'communication' } })).rejects.toThrow('Request cancelled');
      expect(native).toHaveBeenCalledTimes(1);
      expect(accepted).not.toHaveBeenCalled();
      expect(h.lastChild.kill).not.toHaveBeenCalled();
      // The session lives on: the leg rethrows (the owner's exit), it is not a lost channel.
      expect(runtime.getSessionState(input.sessionId).lastTurnOutcome).toBe('stopped');
    } finally {
      await runtime.dispose();
      toAgent.end();
      toClient.end();
    }
  });
});
