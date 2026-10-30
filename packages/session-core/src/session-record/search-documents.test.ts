import { describe, expect, it } from 'vitest';
import type { TranscriptTurn, TranscriptItem } from '../acp/models/turns/turn';
import { taskSearchDocuments } from './search-documents';
import { renderDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';

const at = '2026-10-30T12:00:00.000Z';
const turn = (items: TranscriptItem[]): TranscriptTurn => ({ id: 's:turn:s0', referenceId: 'live', seq: 0, initiator: 'user', items });
const message = (text: string, role: 'user' | 'assistant' = 'user'): TranscriptItem => ({ kind: 'message', id: 's:turn:s0:m', seq: 0, role, text, at: Date.parse(at) });
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
    const envelope = renderDeliveryEnvelope({ route, from: 'Sender', fromId: 'user:person', messageId: 'msg:delivery', at: original, content: 'delivered input' });
    expect(taskSearchDocuments('s', turn([message(envelope)]))).toEqual([{
      id: `task:s:delivery:${route}:msg:delivery`, taskId: 's', reference: 'live:m', seq: 0, role: 'user',
      text: 'delivered input', senderId: 'person', createdAt: original,
    }]);
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
  it('uses the same visible private-reply projection as the transcript, excluding a hidden task summary', () => {
    const envelope = renderDeliveryEnvelope({ route: 'chat', chat: 'chat', chatKind: 'dm', from: 'Human', fromId: 'user:person', fromType: 'human', messageId: 'msg:cloud', at, content: 'input' });
    const output = JSON.stringify({ message_id: '11111111-1111-4111-8111-111111111111' });
    expect(taskSearchDocuments('s', turn([message(envelope), send('message_send', 'done', output),
      { ...message('not a second visible reply', 'assistant'), id: 's:turn:s0:summary' }]))).toEqual([]);
  });
  it('leaves canonical successful message_send rows to the chat index', () => {
    const output = JSON.stringify({ message_id: '11111111-1111-4111-8111-111111111111' });
    expect(taskSearchDocuments('s', turn([send('message_send', 'done', output)]))).toEqual([]);
  });
});
