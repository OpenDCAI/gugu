import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeV2SessionUpdate, type NormalizedEvent, type TranscriptTurn } from '@gugu/session-core/acp';
import { makeAcpHarness, makeStartInput } from '../acp-test-support';
import { AcpRuntime } from './runtime';

type Commit = { source: string; turn: TranscriptTurn };
const SESSION = 'terminal-publication';
const PROVIDER = 'session-1';
const rawChunk = (text: string) => decodeV2SessionUpdate({
  sessionUpdate: 'terminal_output_chunk', terminalId: 't', data: Buffer.from(text).toString('base64'),
});
const reference: NormalizedEvent = {
  kind: 'tool_update', toolCallId: 'command', title: 'background output', toolKind: 'execute',
  contentBlocks: [{ type: 'terminal', terminalId: 't' }], status: 'completed',
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function started() {
  const committed: Commit[] = [];
  const h = makeAcpHarness({ nativeState: true,
    onTurnCommitted: ({ source, turn }) => committed.push({ source, turn }),
  });
  const rt = new AcpRuntime(h.deps);
  expect(await rt.startSession(makeStartInput({ sessionId: SESSION }))).toMatchObject({ success: true });
  await vi.runAllTimersAsync();
  const send = (event: NormalizedEvent) => h.client().sessionEvent({ sessionId: PROVIDER, event });
  await send(reference);
  await send({ kind: 'session_notice', code: 'provider-notice', detail: 'A later completed notice' });
  await vi.runAllTimersAsync();
  const launch = rt.getChatHistory(SESSION).committed.find(turn =>
    turn.items.some(item => 'terminalId' in item && item.terminalId),
  );
  expect(launch).toBeDefined();
  committed.length = 0;
  return { h, rt, send, committed, launchId: launch!.id };
}

describe('terminal publication lifecycle', () => {
  it('publishes the first and trailing output while authority stays current and old turns backfill', async () => {
    const { rt, send, committed, launchId } = await started();
    const live = rt.sessionLiveModels(SESSION)!.states.terminals;
    const outputs: string[] = [];
    const unsubscribe = live.subscribe(() => outputs.push(live.snapshot().data[0]?.output ?? ''));
    const sync = vi.spyOn(rt.manager, 'syncTerminals');
    try {
      await send(rawChunk('first'));
      expect(outputs).toEqual(['first']);
      await send(rawChunk(' tail'));
      expect(rt.getTerminals(SESSION)[0]?.output).toBe('first tail');
      expect(outputs).toEqual(['first']);
      await vi.advanceTimersToNextTimerAsync();
      expect(outputs).toEqual(['first', 'first tail']);
      expect(committed.at(-1)).toMatchObject({ source: 'backfill', turn: { id: launchId,
        terminals: [expect.objectContaining({ output: 'first tail' })] } });
      expect(sync).toHaveBeenCalledTimes(2);
      await vi.runAllTimersAsync();
      await send(rawChunk(' sparse'));
      expect(outputs.at(-1)).toBe('first tail sparse');
      expect(sync).toHaveBeenCalledTimes(3);
    } finally {
      unsubscribe();
      expect(await rt.stopSession(SESSION)).toMatchObject({ success: true });
      await rt.dispose();
    }
  });

  it('publishes terminal exit immediately with the pending output tail', async () => {
    const { rt, send, committed, launchId } = await started();
    try {
      await send(rawChunk('first'));
      await send(rawChunk(' LAST_TAIL'));
      await send(decodeV2SessionUpdate({ sessionUpdate: 'terminal_update', terminalId: 't',
        exitStatus: { exitCode: 0, signal: null } }));
      expect(rt.sessionLiveModels(SESSION)!.states.terminals.snapshot().data).toMatchObject([
        { output: 'first LAST_TAIL', exitStatus: { exitCode: 0, signal: null } },
      ]);
      expect(committed.filter(entry => entry.turn.id === launchId).at(-1)).toMatchObject({
        source: 'backfill', turn: { terminals: [expect.objectContaining({ output: 'first LAST_TAIL',
          exitStatus: { exitCode: 0, signal: null } })] },
      });
      const beforeTick = committed.length;
      await vi.runAllTimersAsync();
      expect(committed).toHaveLength(beforeTick);
    } finally {
      expect(await rt.stopSession(SESSION)).toMatchObject({ success: true });
      await rt.dispose();
    }
  });

  it('persists the pending last tail on removal and leaves no publication timer behind', async () => {
    const { rt, send, committed, launchId } = await started();
    await send({ kind: 'agent_state', source: 'agent', state: 'running' });
    await send({ kind: 'message', role: 'assistant', messageId: 'foreground', text: 'working' });
    await send({ kind: 'message', role: 'assistant', messageId: 'foreground', text: ' more' });
    await send(rawChunk('first'));
    await send(rawChunk(' LAST_TAIL'));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    expect(await rt.stopSession(SESSION)).toMatchObject({ success: true });
    expect(committed.filter(entry => entry.turn.id === launchId).at(-1)).toMatchObject({ source: 'backfill', turn: { id: launchId,
      terminals: [expect.objectContaining({ output: 'first LAST_TAIL' })] } });
    expect(rt.sessionLiveModels(SESSION)).toBeNull();
    const afterRemoval = committed.length;
    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();
    expect(committed).toHaveLength(afterRemoval);
    await rt.dispose();
  });

  it('suppresses intermediate replay writes and stores the complete terminal tail at replay end', async () => {
    const committed: Commit[] = [];
    const h = makeAcpHarness({ nativeState: true,
      onTurnCommitted: ({ source, turn }) => committed.push({ source, turn }),
    });
    const loaded = Promise.withResolvers<Record<string, never>>();
    h.agent.loadSession = vi.fn(() => loaded.promise);
    const rt = new AcpRuntime(h.deps);
    const resuming = rt.resumeSession({ ...makeStartInput({ sessionId: SESSION }), providerSessionId: 'replay-provider' });
    await h.agent.called('loadSession');
    const send = (event: NormalizedEvent) => h.client().sessionEvent({ sessionId: 'replay-provider', event });
    try {
      await send({ kind: 'message', role: 'user', messageId: 'first', text: 'run the command' });
      await send(reference);
      await send(rawChunk('REPLAY_TAIL'));
      await send({ kind: 'message', role: 'user', messageId: 'second', text: 'later input' });
      await vi.runAllTimersAsync();
      expect(committed).toEqual([]);
    } finally {
      loaded.resolve({});
    }
    expect(await resuming).toMatchObject({ success: true });
    expect(committed.length).toBeGreaterThan(0);
    expect(committed.every(entry => entry.source === 'replay')).toBe(true);
    expect(committed.some(entry => entry.turn.terminals?.some(t => t.output === 'REPLAY_TAIL'))).toBe(true);
    expect(h.agent.prompt).not.toHaveBeenCalled();
    expect(await rt.stopSession(SESSION)).toMatchObject({ success: true });
    await rt.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
