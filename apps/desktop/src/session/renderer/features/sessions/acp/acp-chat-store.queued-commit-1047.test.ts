// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import type { HistoryPage } from '@gugu/session-core/acp/client';

vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: () => {} }));
Object.defineProperty(document, 'fonts', {
  configurable: true, value: { load: vi.fn().mockResolvedValue([]) },
});
Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: { invoke: () => Promise.resolve([]), eventSend: () => {}, eventOn: () => () => {}, getPathForFile: () => '' },
});
const { AcpChatStore } = await import('./acp-chat-store');

function replica<T>(initial: T) {
  let value = initial;
  const listeners = new Set<(next: T) => void>();
  return {
    current: () => value,
    ready: Promise.resolve(),
    onGone: () => () => {},
    onChange: (listener: (next: T) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set(next: T) { value = next; for (const listener of listeners) listener(next); },
  };
}

function turn(id: string, seq: number, text: string): TranscriptTurn {
  return { id, seq, initiator: 'user', items: [
    { kind: 'message', id: `${id}:question`, seq: 0, role: 'user', text: `Question ${id}` },
    { kind: 'message', id: `${id}:answer`, seq: 1, role: 'assistant', text },
  ] };
}

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

it('loads A while queued B is still running, preserves B during the history request, then reconciles idle', async () => {
  const a = turn('A', 0, 'Completed answer A');
  const b = turn('B', 1, 'Streaming answer B');
  const activeTurn = replica<TranscriptTurn | null>(a);
  const pending: Array<(page: { success: true; data: HistoryPage }) => void> = [];
  const session = {
    activeTurn,
    sessionState: replica({ lifecycle: 'working', activeTurnId: a.id, isGenerating: true, queuedPrompts: [], pendingPermissions: [] }),
    agents: replica([]), config: replica({}), plan: replica(null), terminals: replica([]), draft: replica(null),
    getHistory: vi.fn(() => new Promise<{ success: true; data: HistoryPage }>(resolve => { pending.push(resolve); })),
    dispose() {},
  };
  const store = new AcpChatStore('queued-commit', 'project');
  cleanup.push(() => store.dispose());
  const internals = store as unknown as {
    session: unknown;
    _runtimeCursor: { epoch: string; seq: number };
    _subscribeLiveSession(value: unknown): void;
  };
  internals.session = session;
  internals._runtimeCursor = { epoch: 'runtime', seq: 0 };
  internals._subscribeLiveSession(session);
  expect(store.chatState.transcript.state.activeTurnSnapshot?.id).toBe('A');
  expect(session.getHistory).not.toHaveBeenCalled();

  // A->null->B can be coalesced into A->B by the runtime publication tick.
  activeTurn.set(b);
  expect(store.chatState.transcript.state.activeTurnSnapshot?.id).toBe('B');
  expect(session.getHistory, 'A must be reconciled before B becomes idle').toHaveBeenCalledTimes(1);
  activeTurn.set({ ...b, items: [...b.items, { kind: 'message', id: 'B:tail', seq: 2, role: 'assistant', text: 'B keeps streaming' }] });
  expect(session.getHistory, 'same-turn chunks are not commits').toHaveBeenCalledTimes(1);
  pending.shift()!({ success: true, data: { turns: [{ ...a, outcome: { kind: 'done' } }], count: 1,
    nextCursor: null, cursor: { epoch: 'runtime', seq: 1 }, reset: false } });
  await vi.waitFor(() => expect(store.chatState.transcript.state.committedTurns.map(t => t.id)).toEqual(['A']));
  expect(store.chatState.transcript.findItemById('A:question')).toBeDefined();
  expect(store.chatState.transcript.findItemById('A:answer')).toBeDefined();
  expect(store.chatState.transcript.state.activeTurnSnapshot?.id).toBe('B');
  expect(store.chatState.transcript.findItemById('B:tail')).toMatchObject({ text: 'B keeps streaming' });

  activeTurn.set(null);
  expect(session.getHistory).toHaveBeenCalledTimes(2);
  expect(store.chatState.transcript.state.activeTurnSnapshot?.id, 'retain B until history arrives').toBe('B');
  pending.shift()!({ success: true, data: { turns: [{ ...b, outcome: { kind: 'done' } }], count: 2,
    nextCursor: null, cursor: { epoch: 'runtime', seq: 2 }, reset: false } });
  await vi.waitFor(() => expect(store.chatState.transcript.state.committedTurns.map(t => t.id)).toEqual(['A', 'B']));
  expect(store.chatState.transcript.state.activeTurnSnapshot).toBeNull();
});
