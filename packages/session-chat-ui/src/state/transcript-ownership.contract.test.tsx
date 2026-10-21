import { describe, expect, it } from 'vitest';
import { createPlainStore } from '../../../session-wire/src/live/replica/store';
import type { TranscriptTurn } from '../model';
import { collectBackgroundCommandRoster } from '../lib/background-command-roster';
import { createTranscript } from './transcript';

function turn(): TranscriptTurn {
  return {
    id: 'active', seq: 0, initiator: 'user', startedAt: 1,
    items: [
      { kind: 'message', id: 'message', seq: 0, role: 'assistant', text: 'one' },
      { kind: 'execute-tool-call', id: 'background', seq: 1, toolCallId: 'call',
        title: 'background command', status: 'done', backgroundTaskId: 'task' },
    ],
  };
}

const roster = (tx: ReturnType<typeof createTranscript>) =>
  collectBackgroundCommandRoster(tx.history.get(), tx.activeTurn.get(), 'command', null);

describe('immutable wire snapshots and the mutable transcript view (#6035)', () => {
  it('can read the old frame after a patch freezes structurally shared items', () => {
    const wire = createPlainStore<TranscriptTurn>();
    wire.reset(turn());
    const seeded = wire.current();
    const before = structuredClone(seeded);
    const tx = createTranscript();
    tx.activeTurn.set(seeded);
    const next = wire.apply([{ op: 'replace', path: ['items', 0, 'text'], value: 'two' }]);
    // This is the real freeze source, not a separately frozen test fixture.
    expect(Object.isFrozen(next)).toBe(true);
    expect(Object.isFrozen(seeded.items[1])).toBe(true);
    expect(roster(tx).map((entry) => entry.taskId)).toEqual(['task']);
    const item = tx.activeTurn.get()!.items[0];
    tx.activeTurn.set(next);
    for (let i = 0; i < 12; i++) {
      tx.activeTurn.set(wire.apply([
        { op: 'replace', path: ['items', 0, 'text'], value: `update ${i}` },
      ]));
      expect(tx.activeTurn.get()!.items[0]).toBe(item);
      expect(roster(tx)).toHaveLength(1);
    }
    expect(tx.activeTurn.get()!.items[0]).toMatchObject({ text: 'update 11' });
    expect(seeded).toEqual(before);
    expect(seeded.items[1]).toBe(next.items[1]);
    expect(Object.getOwnPropertySymbols(seeded.items[1])).toEqual([]);
  });

  it('does not mutate even unfrozen inputs or replace their frozen children', () => {
    const tx = createTranscript();
    const input = turn();
    const child = Object.freeze(input.items[1]);
    const before = structuredClone(input);
    tx.activeTurn.set(input);
    roster(tx);
    const next = turn();
    next.items[0] = { ...next.items[0], text: 'updated' } as TranscriptTurn['items'][number];
    tx.activeTurn.set(next);
    expect(input).toEqual(before);
    expect(input.items[1]).toBe(child);
    expect(Object.getOwnPropertySymbols(input)).toEqual([]);
    expect(Object.getOwnPropertySymbols(input.items[0])).toEqual([]);
  });

  it('accepts its own proxy after history reconciliation and a replay/reset', () => {
    const tx = createTranscript();
    const source = turn();
    tx.activeTurn.set(source);
    const frame = tx.state.activeTurnSnapshot!;
    roster(tx);
    const history: TranscriptTurn[] = [{
      id: 'committed', seq: -1, initiator: 'user',
      items: [{ kind: 'message', id: 'past', seq: 0, role: 'user', text: 'past' }],
    }];
    tx.history.seed(history);
    tx.activeTurn.set(frame);
    expect(roster(tx)).toHaveLength(1);
    expect(tx.history.get()).toBe(history);
    const restored = tx.activeTurn.get()!;
    // Also accept a new snapshot containing nested proxies (story reducers).
    tx.activeTurn.set({ ...restored, items: [...restored.items] });
    expect(tx.activeTurn.get()!.items[0]).toBe(restored.items[0]);
    tx.reset();
    tx.history.seed(history);
    tx.activeTurn.set(source);
    expect(roster(tx)).toHaveLength(1);
    expect(tx.history.get()).toBe(history);
    tx.activeTurn.commit();
    expect(tx.state.activeTurnSnapshot).toBeNull();
    expect(tx.history.get()[0]).toBe(history[0]);
    expect(source.outcome).toBeUndefined();
  });
});
