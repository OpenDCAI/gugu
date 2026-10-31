import { describe, expect, it, vi } from 'vitest';
import type { TranscriptTurn, TranscriptItem } from '../acp/models/turns/turn';
import type { TranscriptMessage } from '../acp/models/turns/messages';
import { taskSearchDocuments } from './search-documents';
import { formatDeliveryTimestamp, parseDeliveryTimestamp, renderDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';

const at = '2026-10-30T12:00:00.000Z';
const turn = (items: TranscriptItem[]): TranscriptTurn => ({ id: 's:turn:s0', referenceId: 'live', seq: 0, initiator: 'user', items });
const message = (text: string, role: 'user' | 'assistant' = 'user'): TranscriptMessage => ({ kind: 'message', id: 's:turn:s0:m', seq: 0, role, text, at: Date.parse(at) });
const send = (tool: string, status = 'done', output = '{}'): TranscriptItem => ({ kind: 'mcp-tool-call', id: 's:turn:s0:tool', seq: 1,
  toolCallId: 'call', server: 'gugu', tool, title: tool, status, rawInput: JSON.stringify({ text: 'delivered', chat_id: 'chat' }), rawOutput: output }) as TranscriptItem;

describe('visible task search projection', () => {
  it('preserves the entire visible body and its durable source identity', () => {
    const text = 'x'.repeat(70_000) + 'tailneedle';
    expect(taskSearchDocuments('s', turn([message(text)]))).toEqual([{
      id: 'task:s:live:m', taskId: 's', reference: 'live:m', seq: 0, role: 'user', text, createdAt: at,
    }]);
  });
  it('deduplicates envelope IDs, never body equality, and excludes thinking and generic tools', () => {
    const envelope = renderDeliveryEnvelope({ route: 'chat', chat: 'chat', chatKind: 'dm', from: 'Human', fromId: 'user:person', fromType: 'human', messageId: 'msg:cloud', at, content: 'same words' });
    const items = [message(envelope), { ...message('same words', 'assistant'), id: 's:turn:s0:a' },
      { kind: 'thinking', id: 'thought', seq: 2, text: 'private thought' } as TranscriptItem, send('some_tool')];
    expect(taskSearchDocuments('s', turn(items)).map(doc => doc.text)).toEqual(['same words']);
  });
  it.each(['session-direct', 'scheduled', 'extension', 'system'] as const)('keeps %s delivery bodies with their original envelope clock', route => {
    const original = '2026-09-01T12:00:00.000Z';
    const envelope = renderDeliveryEnvelope({ route, from: 'Sender', fromId: 'user:person', messageId: 'msg:delivery', at: formatDeliveryTimestamp(original), content: 'delivered input' });
    expect(taskSearchDocuments('s', turn([message(envelope)]))).toEqual([{
      id: `task:s:delivery:0:${route}:msg:delivery`, taskId: 's', reference: 'live:m', seq: 0, role: 'user',
      text: 'delivered input', senderId: 'person', createdAt: original,
    }]);
  });
  it.each([
    ['2026-10-31 02:37 北京时间', '2026-10-30T18:37:00.000Z'],
    ['2026-10-31 00:07 UTC+5.5', '2026-10-30T18:37:00.000Z'],
    ['2026-10-30 15:07 UTC-3.5', '2026-10-30T18:37:00.000Z'],
    ['2026-10-31 00:22 UTC+5.75', '2026-10-30T18:37:00.000Z'],
    [at, at],
  ])('reads the original delivery clock %s', (clock, expected) => {
    const envelope = renderDeliveryEnvelope({ route: 'session-direct', from: 'Sender', fromId: 'user:person',
      messageId: 'msg:delivery', at: clock, content: 'dated input' });
    expect(taskSearchDocuments('s', turn([{ ...message(envelope), at: undefined }]))[0].createdAt).toBe(expected);
  });
  it.each(['Asia/Shanghai', 'Asia/Kolkata', 'America/St_Johns', 'Asia/Kathmandu'])('round-trips the real formatter in %s at its minute precision', timezone => {
    vi.stubEnv('TZ', timezone);
    try {
      const original = '2026-10-30T18:37:42.123Z';
      expect(parseDeliveryTimestamp(formatDeliveryTimestamp(original))).toBe(Date.parse('2026-10-30T18:37:00.000Z'));
    } finally { vi.unstubAllEnvs(); }
  });
  it('falls through an invalid envelope clock to the item and turn clocks, otherwise preserves unknown', () => {
    const envelope = renderDeliveryEnvelope({ route: 'system', from: 'System', fromId: 'system:gugu',
      messageId: 'msg:delivery', at: '2026-02-30 12:00 北京时间', content: 'dated input' });
    expect(parseDeliveryTimestamp('2026-02-30 12:00 北京时间')).toBeNull();
    expect(taskSearchDocuments('s', turn([message(envelope)]))[0].createdAt).toBe(at);
    const unknown = { ...message(envelope), at: undefined };
    expect(taskSearchDocuments('s', { ...turn([unknown]), startedAt: Date.parse(at) })[0].createdAt).toBe(at);
    expect(taskSearchDocuments('s', turn([unknown]))[0].createdAt).toBeNull();
  });
  it('preserves unknown dates and uses the actual send completion before the turn clock', () => {
    const unknown = { ...message('unknown'), at: undefined };
    expect(taskSearchDocuments('s', turn([unknown]))[0].createdAt).toBeNull();
    const completedAt = Date.parse('2026-09-02T12:00:00.000Z');
    const sent = { ...send('session_message'), completedAt } as TranscriptItem;
    expect(taskSearchDocuments('s', { ...turn([sent]), startedAt: Date.parse(at) })[0].createdAt).toBe(new Date(completedAt).toISOString());
  });
  it('does not turn an old runtime counter into a durable source reference', () => {
    const unstable = { ...turn([message('temporary')]), id: 's:turn:0', referenceId: undefined };
    expect(taskSearchDocuments('s', unstable)).toEqual([]);
  });
  it('includes successful Gugu session delivery bodies and excludes failed or unfinished sends', () => {
    expect(taskSearchDocuments('s', turn([send('session_message')])).map(doc => doc.text)).toEqual(['delivered']);
    expect(taskSearchDocuments('s', turn([send('session_message', 'error'), send('session_message', 'running')]))).toEqual([]);
  });
  it('keeps direct output after a canonical send and hides only shared silence markers', () => {
    const envelope = renderDeliveryEnvelope({ route: 'chat', chat: 'chat', chatKind: 'dm', from: 'Human', fromId: 'user:person', fromType: 'human', messageId: 'msg:cloud', at, content: 'input' });
    const output = JSON.stringify({ message_id: '11111111-1111-4111-8111-111111111111' });
    expect(taskSearchDocuments('s', turn([message(envelope), send('message_send', 'done', output),
      { ...message('visible direct reply', 'assistant'), id: 's:turn:s0:summary' }]))
      .map(doc => doc.text)).toEqual(['visible direct reply']);
    expect(taskSearchDocuments('s', turn([message('[NO_REPLY]', 'assistant')]))).toEqual([]);
    expect(taskSearchDocuments('s', turn([message('`[NO_REPLY]`', 'assistant')]))).toEqual([]);
  });
  it('leaves canonical successful message_send rows to the chat index', () => {
    const output = JSON.stringify({ message_id: '11111111-1111-4111-8111-111111111111' });
    expect(taskSearchDocuments('s', turn([send('message_send', 'done', output)]))).toEqual([]);
  });
});
