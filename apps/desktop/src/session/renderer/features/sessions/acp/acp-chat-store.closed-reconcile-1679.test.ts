// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runInAction } from 'mobx';
import type { TranscriptTurn, SessionState } from '@gugu/session-core/acp/client';

vi.mock('@renderer/lib/acp/runtime-client', () => ({
  getAcpRuntimeClient: async () => ({ getStoredQueue: async () => [] }),
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: () => {} }));
const listeners = new Map<string, Set<(data: unknown) => void>>();
const read = vi.fn();
Object.defineProperty(document, 'fonts', { configurable: true, value: { load: async () => [] } });
Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
  invoke: (channel: string, ...args: unknown[]) => channel.includes('getStoredSettledTurn') ? read(...args) : Promise.resolve([]),
  eventSend: () => {}, getPathForFile: () => '',
  eventOn: (channel: string, callback: (data: unknown) => void) => {
    const set = listeners.get(channel) ?? new Set(); listeners.set(channel, set); set.add(callback);
    return () => set.delete(callback);
  },
} });
const { AcpChatStore } = await import('./acp-chat-store');

function replica<T>(initial: T) {
  let value = initial;
  const callbacks = new Set<(next: T) => void>();
  return { current: () => value, onChange: (callback: (next: T) => void) => {
    callbacks.add(callback); return () => callbacks.delete(callback);
  }, onGone: () => () => {}, push: (next: T) => {
    value = next; for (const callback of [...callbacks]) callback(next);
  } };
}
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
beforeEach(() => { read.mockReset(); read.mockResolvedValue(stored); });
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
