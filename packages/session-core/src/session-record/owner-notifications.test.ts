import { expect, it } from 'vitest';
import type { TranscriptTurn } from '../acp/client';
import { projectOwnerNotifications } from './owner-notifications';

const runtime: TranscriptTurn = { id: 'runtime', seq: 0, initiator: 'user', startedAt: 100, items: [
  { kind: 'message', id: 'input', seq: 0, role: 'user', text: 'Investigate', at: 100 },
  { kind: 'message', id: 'reply', seq: 1, role: 'assistant', text: 'Working', at: 200 },
] };
const notice: TranscriptTurn = { id: 'session:turn:s3', seq: 3, initiator: 'agent', startedAt: 300, outcome: { kind: 'done' }, items: [
  { kind: 'message', id: 'session:turn:s3:message:notice', seq: 0, role: 'assistant', text: 'Please review', at: 300,
    ownerNotification: { requestId: '11111111-1111-4111-8111-111111111111', requestHash: 'hash', sourceTurnId: 'runtime' } },
] };

it('shows a durable notification in the exact active turn without changing provider state', () => {
  const projected = projectOwnerNotifications([notice], runtime);
  expect(projected.turns).toEqual([]);
  expect(projected.activeTurn!.items.map(item => item.id)).toEqual(['input', 'reply', notice.items[0]!.id]);
  expect(runtime.items).toHaveLength(2);
  expect(notice.items).toHaveLength(1);
});

it('keeps the same notification identity after the source turn is committed and renumbered', () => {
  const stored = { ...runtime, id: 'session:turn:s4', seq: 4, outcome: { kind: 'done' as const } };
  const projected = projectOwnerNotifications([notice, stored], null, new Map([[stored.id, 'runtime']]));
  expect(projected.turns).toHaveLength(1);
  expect(projected.turns[0]!.items.at(-1)!.id).toBe(notice.items[0]!.id);
  const twice = projectOwnerNotifications([notice, ...projected.turns], null, new Map([[stored.id, 'runtime']]));
  expect(twice.turns[0]!.items).toHaveLength(3);
});

it('keeps the independent notification readable when its source is outside the loaded history page', () => {
  const unrelated = { ...runtime, id: 'another-turn', startedAt: 300 };
  const projected = projectOwnerNotifications([notice], unrelated);
  expect(projected.turns).toEqual([notice]);
  expect(projected.activeTurn).toBe(unrelated);
});
