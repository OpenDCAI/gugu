import { expect, it } from 'vitest';
import type { TranscriptTurn } from '@gugu/session-core/acp/client';
import type { NativeSessionRecord } from '@gugu/session-core/session-record/contract';
import { mergeNativeRecordPage, projectNativeRecord } from '../../../../apps/desktop/src/mobile/agent-watch/native-record-state';

const source: TranscriptTurn = { id: 's:turn:s60', seq: 60, initiator: 'user', items: [{ kind: 'message', id: 'input', seq: 0, role: 'user', text: 'Work' }] };
const notice: TranscriptTurn = { id: 's:turn:s59', seq: 59, initiator: 'agent', items: [{ kind: 'message', id: 'notice', seq: 0, role: 'assistant', text: 'Review',
  ownerNotification: { requestId: 'request', requestHash: 'hash', sourceTurnId: 'provider-source' } }] };
const page = (turns: TranscriptTurn[], epoch = 0): NativeSessionRecord => ({ turns, originTurnIds: turns.map(turn => turn === source ? 'provider-source' : 'owner-notify:request'),
  latestStoredSeq: 60, hasNewer: turns.at(-1)?.seq !== 60, nextCursor: 59, activeTurn: null, nativeOwnerNotificationEpoch: epoch });
const ids = (record: NativeSessionRecord | null) => record!.turns.flatMap(turn => turn.items.flatMap(item => item.kind === 'message' && item.ownerNotification ? [item.ownerNotification.requestId] : []));

it('merges raw phone pages before projection and keeps one request through newer, poll and older reads', () => {
  let raw = mergeNativeRecordPage(null, page([notice]), 'poll', false);
  expect(ids(projectNativeRecord(raw))).toEqual(['request']);
  raw = mergeNativeRecordPage(raw, page([source]), 'newer', false);
  expect(projectNativeRecord(raw)!.turns.map(turn => turn.id)).toEqual([source.id]);
  expect(ids(projectNativeRecord(raw))).toEqual(['request']);
  raw = mergeNativeRecordPage(raw, page([source]), 'poll', false);
  raw = mergeNativeRecordPage(raw, page([notice]), 'older', false);
  expect(ids(projectNativeRecord(raw))).toEqual(['request']);
  expect(raw.turns).toEqual([notice, source]);
  expect(source.items).toHaveLength(1);
});

it('discards the prior phone cache when a revert reuses sequences in a new epoch', () => {
  const old = page([notice, source]);
  const replacement = { ...notice, items: [{ ...notice.items[0]!, id: 'replacement', ownerNotification: { requestId: 'new-request', requestHash: 'new' } }] } as TranscriptTurn;
  const current = mergeNativeRecordPage(old, page([replacement], 1), 'poll', false);
  expect(ids(projectNativeRecord(current))).toEqual(['new-request']);
  expect(current.turns).toEqual([replacement]);
  expect(current.nativeOwnerNotificationEpoch).toBe(1);
});
