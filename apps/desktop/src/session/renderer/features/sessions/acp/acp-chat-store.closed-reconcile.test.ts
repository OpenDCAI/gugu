// @vitest-environment jsdom
// #1679 — reconciling a session that closed mid-turn.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runInAction } from 'mobx';
import { batch } from 'solid-js';
import type { TranscriptTurn, SessionState } from '@gugu/session-core/acp/client';
import { installAcpChatStoreHost, replica } from './acp-chat-store.test-host';

vi.mock('@renderer/lib/acp/runtime-client', () => ({
  getAcpRuntimeClient: async () => ({ getStoredQueue: async () => [] }),
}));
const toasts = vi.hoisted(() => [] as unknown[]);
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: (value: unknown) => toasts.push(value) }));
const listeners = new Map<string, Set<(data: unknown) => void>>();
const read = vi.fn();
const tail = vi.fn();
installAcpChatStoreHost(
  (channel: string, ...args: unknown[]) => channel.includes('getStoredSettledTurn') ? read(...args)
    : channel.includes('getStoredHistory') ? tail(...args) : Promise.resolve([]),
  (channel: string, callback: (data: unknown) => void) => {
    const set = listeners.get(channel) ?? new Set(); listeners.set(channel, set); set.add(callback);
    return () => set.delete(callback);
  },
);
const { AcpChatStore } = await import('./acp-chat-store');

const ready: SessionState = {
  lifecycle: 'working', activeTurnId: 'runtime:turn:0', pendingPermissions: [], lastStopReason: null,
  lastTurnOutcome: 'none', queuedPrompts: [], backgroundAgentCount: 0, backgroundCommandCount: 0,
  backgroundCommandTaskIds: [], isGenerating: true, canSubmit: false, canCancel: true, failure: null,
};
const live: TranscriptTurn = {
  id: 'runtime:turn:0', referenceId: 'source:run-one', seq: 0, initiator: 'user', startedAt: 10,
  items: [{ kind: 'message', id: 'runtime:turn:0:user', seq: 0, role: 'user', text: 'Keep the real prompt' }],
};
const stored = { originTurnId: live.id, turn: { ...live, id: 'A:turn:s7', seq: 7,
  outcome: { kind: 'cancelled', reason: 'cancelled' } } as TranscriptTurn };
type Internal = { _subscribeLiveSession: (session: unknown) => void };
const stores: InstanceType<typeof AcpChatStore>[] = [];
function attached(id = 'A') {
  const store = new AcpChatStore(id, 'project'); stores.push(store);
  const session = {
    sessionState: replica(ready), activeTurn: replica<TranscriptTurn | null>(live),
    agents: replica([]), plan: replica(null), draft: replica(null), terminals: replica([]), config: replica({}),
    onDraftSyncReady: () => () => {}, canSyncDraft: () => false, dispose: vi.fn(),
    getHistory: async () => ({ success: true, data: { turns: [], count: 0, cursor: { epoch: 'old', seq: 0 } } }),
  };
  runInAction(() => { store.session = session as unknown as typeof store.session;
    store.historyLoading = false; (store as unknown as Internal)._subscribeLiveSession(session); });
  return { store, session, close: () => session.sessionState.push({ ...ready, lifecycle: 'closed', activeTurnId: null, isGenerating: false }) };
}
function receipt(sessionId = 'A', referenceId = live.referenceId) {
  for (const callback of listeners.get('session:turn-settled') ?? []) callback({ sessionId, referenceId, status: 'persisted' });
}
beforeEach(() => { toasts.length = 0; read.mockReset(); read.mockResolvedValue(stored);
  tail.mockReset(); tail.mockResolvedValue({ turns: [stored.turn], originTurnIds: [live.id], nextCursor: null }); });
afterEach(() => { for (const store of stores.splice(0)) store.dispose(); });

it.each(['closed-first', 'active-null-first'] as const)('consumes the actual terminal history when %s', async order => {
  const { store, session, close } = attached();
  expect(store.chatState.transcript.state.activeTurnSnapshot?.referenceId).toBe(live.referenceId);
  if (order === 'active-null-first') session.activeTurn.push(null);
  close();
  session.activeTurn.push(null);
  await vi.waitFor(() => expect(store.chatState.transcript.state.committedTurns.at(-1)?.outcome).toEqual(stored.turn.outcome), { timeout: 500 });
  expect(store.chatState.transcript.state.activeTurnSnapshot).toBeNull();
  expect(store.session).toBeNull();
});

it('an idle close whose last turn already shows its outcome reads nothing and warns nothing (older servers)', async () => {
  read.mockRejectedValue(new Error('No handler registered for sessions.getStoredSettledTurn'));
  const { store, session, close } = attached();
  session.activeTurn.push(null);
  // The normal commit path already settled it on screen before the host closed the session.
  runInAction(() => batch(() => {
    store.chatState.transcript.history.seed([stored.turn]);
    store.chatState.transcript.activeTurn.set(null);
  }));
  close();
  receipt();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(read).not.toHaveBeenCalled();
  expect(store.loadError).toBeNull();
  expect(toasts).toHaveLength(0);
  expect(store.session).toBeNull();
});

it("an earlier turn's outcome does not make a just-stopped turn look settled: its retained frame still reads", async () => {
  const older = { ...stored.turn, id: 'A:turn:s6', seq: 6, referenceId: 'source:older-run' } as TranscriptTurn;
  const { store, session, close } = attached();
  runInAction(() => { store.chatState.transcript.history.seed([older]); store.chatState.transcript.activeTurn.set(live); });
  // The turn ended: its last frame stays on screen until the history read lands (chat-state syncActiveTurn).
  session.activeTurn.push(null);
  expect(store.chatState.transcript.state.activeTurnSnapshot?.referenceId).toBe(live.referenceId);
  close();
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(store.chatState.transcript.state.committedTurns.at(-1)?.referenceId).toBe(live.referenceId));
  expect(store.chatState.transcript.state.committedTurns.at(-1)?.outcome?.kind).toBe('cancelled');
});

it('retains the last real frame until a late matching persistence receipt arrives, without polling', async () => {
  read.mockResolvedValueOnce(null).mockResolvedValue(stored);
  const { store, close } = attached(); close();
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1), { timeout: 500 });
  expect(store.chatState.transcript.state.activeTurnSnapshot?.referenceId).toBe(live.referenceId);
  receipt('B'); receipt('A', 'source:old-run');
  expect(read).toHaveBeenCalledTimes(1);
  receipt();
  await vi.waitFor(() => expect(store.chatState.transcript.state.committedTurns.at(-1)?.referenceId).toBe(live.referenceId), { timeout: 500 });
  expect(read).toHaveBeenCalledTimes(2);
  expect(store.chatState.transcript.state.activeTurnSnapshot).toBeNull();
});

it('accepts a persisted receipt that arrived before closed', async () => {
  const { store, close } = attached(); receipt();
  expect(read).not.toHaveBeenCalled();
  close();
  await vi.waitFor(() => expect(store.chatState.transcript.state.committedTurns.at(-1)?.outcome?.kind).toBe('cancelled'));
  expect(read).toHaveBeenCalledTimes(1);
});

it.each(['before', 'after'])('reports actual persistence failure %s closed without inventing Stopped', async order => {
  read.mockResolvedValue(null);
  const { store, close } = attached();
  const fail = () => { for (const cb of listeners.get('session:turn-settled') ?? []) cb({
    sessionId: 'A', referenceId: live.referenceId, status: 'failed', cause: { name: 'Error', message: 'disk write denied' },
  }); };
  if (order === 'before') fail();
  close();
  if (order === 'after') { await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1)); fail(); }
  await vi.waitFor(() => expect(JSON.stringify(toasts)).toContain('disk write denied'));
  expect(store.loadError).toMatchObject({ kind: 'history_unavailable', message: 'disk write denied' });
  expect(store.chatState.transcript.state.committedTurns.some(turn => turn.outcome?.kind === 'cancelled')).toBe(false);
  expect(store.chatState.transcript.state.activeTurnSnapshot?.items).toEqual(live.items);
});

it('does not let the old handle clear a new turn with the same runtime id', async () => {
  let finish!: (value: typeof stored) => void;
  read.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const { store, session, close } = attached(); close();
  const next = { ...session, activeTurn: replica<TranscriptTurn | null>({ ...live, referenceId: 'source:run-two' }), sessionState: replica(ready) };
  runInAction(() => { store.session = next as unknown as typeof store.session; (store as unknown as Internal)._subscribeLiveSession(next); });
  finish(stored); await Promise.resolve(); await Promise.resolve();
  expect(store.chatState.transcript.state.activeTurnSnapshot?.referenceId).toBe('source:run-two');
  expect(store.chatState.transcript.state.committedTurns).toHaveLength(0);
});

it('settles A without clearing or committing the still-running B', async () => {
  const a = attached(); const b = attached('B'); a.close();
  await vi.waitFor(() => expect(a.store.chatState.transcript.state.committedTurns).toHaveLength(1));
  expect(b.store.chatState.transcript.state.activeTurnSnapshot).toEqual(live);
  expect(b.store.session).not.toBeNull();
  expect(b.store.chatState.transcript.state.committedTurns).toHaveLength(0);
});

it('retains a real process failure rather than replacing it with cancellation', async () => {
  const failed = { ...stored, turn: { ...stored.turn, outcome: { kind: 'error', reason: 'process_closed', detail: 'signal=SIGKILL' } } };
  read.mockResolvedValue(failed);
  const { store, session } = attached();
  session.sessionState.push({ ...ready, lifecycle: 'lost', isGenerating: false, failure: { message: 'adapter exited unexpectedly' } } as unknown as SessionState);
  await vi.waitFor(() => expect(store.chatState.transcript.state.committedTurns.at(-1)?.outcome).toEqual(failed.turn.outcome));
  expect(store.loadError).toMatchObject({ kind: 'adapter_lost' });
});

it('does not wait for a turn that never existed', () => {
  const { store, session, close } = attached();
  session.activeTurn.push(null);
  // A genuinely idle handle has no last live origin.
  const idle = { ...session, activeTurn: replica<TranscriptTurn | null>(null) };
  runInAction(() => { store.session = idle as unknown as typeof store.session; (store as unknown as Internal)._subscribeLiveSession(idle); });
  close();
  expect(read).not.toHaveBeenCalled();
});

it('reports a real history read failure, preserving the original evidence', async () => {
  read.mockRejectedValue(new Error('history read denied'));
  const { store, close } = attached(); close();
  await vi.waitFor(() => expect(store.loadError).toMatchObject({ kind: 'history_unavailable', message: 'history read denied' }));
  expect(store.chatState.transcript.state.activeTurnSnapshot?.items).toEqual(live.items);
  expect(store.chatState.transcript.state.committedTurns).toHaveLength(0);
});

it('clears only its own read failure after a real settlement becomes readable', async () => {
  read.mockRejectedValueOnce(new Error('history read denied')).mockResolvedValue(stored);
  const { store, close } = attached(); close();
  await vi.waitFor(() => expect(store.loadError?.kind).toBe('history_unavailable'));
  receipt();
  await vi.waitFor(() => expect(store.chatState.transcript.state.committedTurns).toHaveLength(1));
  expect(store.loadError).toBeNull();
});

it('accepts a late real failure revision without adding a second turn', async () => {
  const { store, close } = attached(); close();
  await vi.waitFor(() => expect(store.chatState.transcript.state.committedTurns).toHaveLength(1));
  const failure = { kind: 'error', reason: 'process_closed', detail: 'signal=SIGKILL' };
  read.mockResolvedValue({ ...stored, turn: { ...stored.turn, outcome: failure } }); receipt();
  await vi.waitFor(() => expect(store.chatState.transcript.state.committedTurns[0]?.outcome).toEqual(failure));
  expect(store.chatState.transcript.state.committedTurns).toHaveLength(1);
});

it('ignores a read completing after the view has been disposed', async () => {
  let finish!: (value: typeof stored) => void;
  read.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const { store, close } = attached(); close();
  store.dispose(); stores.splice(stores.indexOf(store), 1);
  finish(stored); await Promise.resolve(); await Promise.resolve();
  expect(store.chatState.transcript.state.committedTurns).toHaveLength(0);
});

it('keeps earlier visible runtime turns before the newly persisted final turn', async () => {
  const previous: TranscriptTurn = { ...live, id: 'runtime:previous', referenceId: 'source:previous', seq: -1,
    items: [{ kind: 'message', id: 'previous:user', seq: 0, role: 'user', text: 'Earlier prompt' }], outcome: { kind: 'done' } };
  const previousStored = { ...previous, id: 'A:turn:s6', seq: 6 };
  tail.mockResolvedValue({ turns: [previousStored, stored.turn], originTurnIds: [previous.id, live.id], nextCursor: null });
  const { store, close } = attached();
  (store as unknown as { _runtimeTurns: TranscriptTurn[] })._runtimeTurns = [previous];
  store.chatState.transcript.history.seed([previous]); store.chatState.transcript.activeTurn.set(live);
  close();
  await vi.waitFor(() => expect(store.chatState.transcript.state.activeTurnSnapshot).toBeNull());
  expect(store.chatState.transcript.state.committedTurns.map(turn => turn.referenceId)).toEqual([previous.referenceId, live.referenceId]);
});

it('does not hide a new run whose runtime id was used by a different stored reference', async () => {
  const { store, close } = attached();
  const earlier = { ...stored.turn, id: 'A:turn:s6', seq: 6, referenceId: 'source:earlier-run', outcome: { kind: 'done' as const } };
  const internal = store as unknown as { _storedHistoryTurns: TranscriptTurn[]; _storedOrigins: string[]; _persistedRuntimeTurnIds: Set<string>; _storedBaseSeq: number };
  internal._storedHistoryTurns = [earlier]; internal._storedOrigins = [live.id];
  internal._persistedRuntimeTurnIds = new Set([live.id]); internal._storedBaseSeq = 6;
  store.chatState.transcript.history.seed([earlier]); store.chatState.transcript.activeTurn.set(live);
  close();
  await vi.waitFor(() => expect(store.chatState.transcript.state.activeTurnSnapshot).toBeNull());
  expect(store.chatState.transcript.state.committedTurns.map(turn => turn.referenceId)).toEqual([earlier.referenceId, live.referenceId]);
});

it('revises an already visible stored slot without adding a runtime twin', async () => {
  const { store, close } = attached();
  const internal = store as unknown as { _storedHistoryTurns: TranscriptTurn[]; _storedOrigins: string[]; _persistedRuntimeTurnIds: Set<string> };
  internal._storedHistoryTurns = [{ ...stored.turn, outcome: undefined }]; internal._storedOrigins = [live.id];
  internal._persistedRuntimeTurnIds = new Set([live.id]);
  store.chatState.transcript.history.seed(internal._storedHistoryTurns); store.chatState.transcript.activeTurn.set(live);
  close();
  await vi.waitFor(() => expect(store.chatState.transcript.state.activeTurnSnapshot).toBeNull());
  expect(store.chatState.transcript.state.committedTurns).toHaveLength(1);
  expect(store.chatState.transcript.state.committedTurns[0]).toMatchObject({ id: stored.turn.id, seq: stored.turn.seq, outcome: stored.turn.outcome });
});
