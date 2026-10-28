import { decodeSessionUpdate } from '@gugu/session-core/acp';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { makeAcpHarness, makeStartInput } from '../acp-test-support';
import { AcpRuntime } from './runtime';
import { createAcpProcedures } from '../api/procedures';

const runtimes: AcpRuntime[] = [];
afterEach(async () => { vi.useRealTimers(); for (const rt of runtimes.splice(0)) await rt.dispose(); });
async function setup(nativeState = false) {
  const committed = vi.fn();
  const h = makeAcpHarness({ nativeState, onTurnCommitted: committed });
  const rt = new AcpRuntime(h.deps); runtimes.push(rt);
  expect((await rt.startSession(makeStartInput())).success).toBe(true);
  return { h, rt, api: createAcpProcedures(rt), committed };
}

it('cannot reclaim Claude between prompt dispatch and its running update', async () => {
  const { h, rt } = await setup(true);
  const finish = Promise.withResolvers<{ stopReason: 'end_turn' }>();
  h.agent.prompt.mockImplementationOnce(() => finish.promise);
  const pending = rt.sendPrompt('conv-1', { text: 'hi' });
  await h.agent.called('prompt');
  expect(rt.sessionsListLiveModel().states.list.snapshot().data['conv-1']?.isGenerating).toBe(false);
  const stop = await rt.stopSession('conv-1', true);
  finish.resolve({ stopReason: 'end_turn' }); await pending;
  expect(stop.success).toBe(false);
  expect(h.agent.closeSession).not.toHaveBeenCalled();
});

it('does not cancel a runtime without admission signals during compaction and silent reasoning', async () => {
  const { h, api } = await setup(false);
  const finish = Promise.withResolvers<{ stopReason: 'end_turn' }>();
  h.agent.prompt.mockImplementationOnce(() => finish.promise);
  vi.useFakeTimers();
  const pending = api.promptDetached({ sessionId: 'conv-1', prompt: { text: 'hi', origin: 'communication' } });
  await vi.advanceTimersByTimeAsync(30_000);
  await h.client().sessionEvent({ sessionId: 'session-1', event: decodeSessionUpdate({
    sessionUpdate: 'compaction_update', compactionId: 'compact-1', status: 'in_progress',
  } as unknown as SessionUpdate) });
  await vi.advanceTimersByTimeAsync(120_000);
  const cancelled = h.agent.cancel.mock.calls.length;
  finish.resolve({ stopReason: 'end_turn' });
  const receipt = await pending;
  await api.waitPromptDetached({ requestId: receipt.requestId }).catch(() => {});
  expect(cancelled).toBe(0);
});

it('a native receipt within the budget admits; compaction after it is never cancelled', async () => {
  const { h, api } = await setup(true);
  const receipt = Promise.withResolvers<{ status: 'accepted'; requestId: string; messageId: string }>();
  h.agent.prompt.mockImplementationOnce(() => receipt.promise);
  vi.useFakeTimers();
  const pending = api.promptDetached({ sessionId: 'conv-1', prompt: { text: 'hi', origin: 'communication' } });
  await vi.advanceTimersByTimeAsync(30_000);
  const dispatch = h.agent.prompt.mock.calls[0]![1] as { requestId: string };
  await h.client().sessionEvent({ sessionId: 'session-1', event: { kind: 'agent_state', source: 'agent', state: 'running' } });
  await h.client().sessionEvent({ sessionId: 'session-1', event: { kind: 'message', role: 'user', messageId: 'native', text: 'hi', contentMode: 'replace' } });
  receipt.resolve({ status: 'accepted', requestId: dispatch.requestId, messageId: 'native' });
  const accepted = await pending;
  await h.client().sessionEvent({ sessionId: 'session-1', event: decodeSessionUpdate({
    sessionUpdate: 'compaction_update', compactionId: 'compact-1', status: 'in_progress',
  } as unknown as SessionUpdate) });
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.agent.cancel).not.toHaveBeenCalled();
  await h.client().sessionEvent({ sessionId: 'session-1', event: { kind: 'agent_state', source: 'agent', state: 'idle', stopReason: 'end_turn' } });
  await api.waitPromptDetached({ requestId: accepted.requestId });
});

it('does not mistake a host notice for a provider admission update', async () => {
  const { h, rt, api } = await setup(true);
  h.agent.prompt.mockImplementationOnce(() => new Promise(() => {}));
  vi.useFakeTimers();
  const pending = api.promptDetached({ sessionId: 'conv-1', prompt: { text: 'hi', origin: 'communication' } });
  await vi.advanceTimersByTimeAsync(30_000);
  rt.announceSession({ sessionId: 'conv-1', notice: { code: 'agent-renamed', detail: 'Name changed' } });
  await vi.advanceTimersByTimeAsync(30_001);
  await expect(pending).rejects.toThrow('timed out');
  expect(h.agent.cancel).toHaveBeenCalledOnce();
});

it('does not commit a failed hi for a provider refusal before admission', async () => {
  const { h, rt, committed } = await setup();
  h.agent.prompt.mockRejectedValueOnce(Object.assign(new Error('Internal error'), {
    code: -32603, data: { details: 'Session not found' },
  }));
  await rt.sendPrompt('conv-1', { text: 'hi', origin: 'communication' });
  expect(rt.getHistory('conv-1')).toMatchObject({ success: true, data: { turns: [] } });
  expect(committed).not.toHaveBeenCalled();
  expect((await rt.sendPrompt('conv-1', { text: 'hi', origin: 'communication' })).success).toBe(true);
  const history = rt.getHistory('conv-1');
  expect(history.success && history.data.turns).toHaveLength(1);
});

it('retains a newer host context arriving while an unadmitted prompt is refused', async () => {
  const { h, rt } = await setup();
  rt.announceSession({ sessionId: 'conv-1', turnContext: { key: 'resource', text: 'old-context' } });
  const failure = Promise.withResolvers<never>();
  h.agent.prompt.mockImplementationOnce(() => failure.promise);
  const refused = rt.sendPrompt('conv-1', { text: 'hi', origin: 'communication' });
  await h.agent.called('prompt');
  rt.announceSession({ sessionId: 'conv-1', turnContext: { key: 'resource', text: 'latest-context' } });
  failure.reject(Object.assign(new Error('Internal error'), { code: -32603, data: { details: 'Session not found' } }));
  await refused;
  await rt.sendPrompt('conv-1', { text: 'hi', origin: 'communication' });
  const replayed = JSON.stringify(h.agent.prompt.mock.calls[1]);
  expect(replayed).toContain('latest-context');
  expect(replayed).not.toContain('old-context');
});

it.each(['reject', 'hang'])('finishes process teardown when provider close can %s', async mode => {
  const { h, rt } = await setup();
  if (mode === 'reject') h.agent.closeSession.mockRejectedValueOnce(new Error('close transport lost'));
  else h.agent.closeSession.mockImplementationOnce(() => new Promise(() => {}));
  vi.useFakeTimers();
  const stopping = rt.stopSession('conv-1');
  let result: Awaited<typeof stopping> | undefined;
  void stopping.then(value => { result = value; });
  await vi.advanceTimersByTimeAsync(12_001);
  expect(result).toMatchObject({ success: true });
  expect(h.lastChild.kill).toHaveBeenCalledWith('SIGTERM');
  expect(rt.sessionLiveModels('conv-1')).toBeNull();
});
