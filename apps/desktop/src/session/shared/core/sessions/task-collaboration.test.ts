import { describe, expect, it } from 'vitest';
import { buildSessionDirectEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { taskExchangeFromRow } from './task-collaboration';

const row = {
  id: 'm-1', position: 1, sessionId: 'task', timestamp: '2026-10-16 12:00:00',
  metadata: JSON.stringify({ kind: 'session-direct', state: 'accepted' }),
  content: buildSessionDirectEnvelope({ senderSessionId: 'assistant', senderTitle: '助理', messageId: 'm-1', content: '请整理报告', at: '2026-10-16 20:00 北京时间' }),
};

describe('task collaboration receipt projection', () => {
  it('keeps original content, sender and receipt time without showing the platform envelope', () => {
    expect(taskExchangeFromRow(row, 'assistant')).toEqual({ id: 'm-1', position: 1, fromSessionId: 'assistant', toSessionId: 'task', content: '请整理报告', createdAt: '2026-10-16T12:00:00Z' });
  });
  it('preserves subsecond UTC ordering for new receipts while still reading legacy timestamps', () => {
    expect(taskExchangeFromRow({ ...row, timestamp: '2026-10-16 12:00:00.123' }, 'assistant')?.createdAt).toBe('2026-10-16T12:00:00.123Z');
  });
  it('does not include another task, even when its body mentions the desired sender', () => {
    expect(taskExchangeFromRow({ ...row, content: buildSessionDirectEnvelope({ senderSessionId: 'other-task', senderTitle: '另一个任务', messageId: 'm-1', content: 'session:assistant', at: '2026-10-16 20:00 北京时间' }) }, 'assistant')).toBeNull();
  });
  it.each(['queued', 'dispatching', 'failed', 'outcome-unknown'])('does not present a %s receipt as a delivered message', (state) => {
    expect(taskExchangeFromRow({ ...row, metadata: JSON.stringify({ kind: 'session-direct', state }) }, 'assistant')).toBeNull();
  });
  it.each(['broken', 'null', '{"kind":"ordinary-message","state":"accepted"}'])('rejects non-direct or unreadable metadata %s', (metadata) => {
    expect(taskExchangeFromRow({ ...row, metadata }, 'assistant')).toBeNull();
  });
  it('does not treat plain transcript text as an assistant message', () => {
    expect(taskExchangeFromRow({ ...row, content: 'session:assistant 请整理报告' }, 'assistant')).toBeNull();
  });
});
