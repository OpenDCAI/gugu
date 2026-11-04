import { toSerializedError } from '@gugu/session-shared/result';
import { expect, it, vi } from 'vitest';
import type { TranscriptTurn } from '@gugu/session-core/acp/client';
import { persistWithTurnSettlement } from './turn-settlement';

const turn: TranscriptTurn = { id: 'A:turn:0', referenceId: 'source:first-run', seq: 0, initiator: 'user', items: [],
  outcome: { kind: 'cancelled', reason: 'cancelled' } };
it('publishes only after the actual write completes', async () => {
  let finish!: () => void;
  const publish = vi.fn();
  const pending = persistWithTurnSettlement({ sessionId: 'A', source: 'live', turn },
    () => new Promise<void>(resolve => { finish = resolve; }), publish);
  expect(publish).not.toHaveBeenCalled();
  finish(); await pending;
  expect(publish).toHaveBeenCalledExactlyOnceWith({ sessionId: 'A', referenceId: turn.referenceId, status: 'persisted' });
});
it('publishes the actual write failure and still rejects to its owner', async () => {
  const failure = new Error('write rejected'); const publish = vi.fn();
  await expect(persistWithTurnSettlement({ sessionId: 'A', source: 'revision', turn },
    async () => { throw failure; }, publish)).rejects.toBe(failure);
  expect(publish).toHaveBeenCalledExactlyOnceWith({ sessionId: 'A', referenceId: turn.referenceId, status: 'failed', cause: toSerializedError(failure) });
});
it.each(['replay', 'live'])('does not claim an uncommitted/replayed turn is a new settlement (%s)', async source => {
  const publish = vi.fn();
  await persistWithTurnSettlement({ sessionId: 'A', source, turn: source === 'live' ? { ...turn, outcome: undefined } : turn }, async () => {}, publish);
  expect(publish).not.toHaveBeenCalled();
});

it('preserves the structured protocol cause for the existing renderer failure outlet', async () => {
  const failure = Object.assign(new Error('Internal error'), { code: 'SQLITE_READONLY', data: { details: 'history database is read only' } });
  const publish = vi.fn();
  await expect(persistWithTurnSettlement({ sessionId: 'A', source: 'live', turn }, async () => { throw failure; }, publish)).rejects.toBe(failure);
  expect(publish.mock.calls[0]?.[0]).toMatchObject({ status: 'failed', cause: {
    name: 'Error', code: 'SQLITE_READONLY', data: { details: 'history database is read only' },
  } });
});
