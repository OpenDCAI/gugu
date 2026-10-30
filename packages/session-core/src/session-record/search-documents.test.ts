import { describe, expect, it } from 'vitest';
import type { TranscriptTurn, TranscriptItem } from '../acp/models/turns/turn';
import { taskSearchDocuments } from './search-documents';
import { renderDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';

const at = '2026-10-30T12:00:00Z';
const turn = (items: TranscriptItem[]): TranscriptTurn => ({ id: 's:turn:s0', referenceId: 'live', seq: 0, initiator: 'user', items });
const message = (text: string, role: 'user' | 'assistant' = 'user'): TranscriptItem => ({ kind: 'message', id: 's:turn:s0:m', seq: 0, role, text });
const send = (tool: string, status = 'done', output = '{}'): TranscriptItem => ({ kind: 'mcp-tool-call', id: 's:turn:s0:tool', seq: 1,
  toolCallId: 'call', server: 'gugu', tool, title: tool, status, rawInput: JSON.stringify({ text: 'delivered', chat_id: 'chat' }), rawOutput: output }) as TranscriptItem;

describe('visible task search projection', () => {
  it('preserves the entire visible body and its durable source identity', () => {
    const text = 'x'.repeat(70_000) + 'tailneedle';
    expect(taskSearchDocuments('s', turn([message(text)]), at)).toEqual([{
      id: 'task:s:live:m', taskId: 's', reference: 'live:m', seq: 0, role: 'user', text, createdAt: at,
    }]);
  });
  it('deduplicates envelope IDs, never body equality, and excludes thinking and generic tools', () => {
    const envelope = renderDeliveryEnvelope({ route: 'chat', chat: 'chat', chatKind: 'dm', from: 'Human', fromId: 'user:person', fromType: 'human', messageId: 'msg:cloud', at, content: 'same words' });
    const items = [message(envelope), { ...message('same words', 'assistant'), id: 's:turn:s0:a' },
      { kind: 'thinking', id: 'thought', seq: 2, text: 'private thought' } as TranscriptItem, send('some_tool')];
    expect(taskSearchDocuments('s', turn(items), at).map(doc => doc.text)).toEqual(['same words']);
  });
  it('includes successful Gugu session delivery bodies and excludes failed or unfinished sends', () => {
    expect(taskSearchDocuments('s', turn([send('session_message')]), at).map(doc => doc.text)).toEqual(['delivered']);
    expect(taskSearchDocuments('s', turn([send('session_message', 'error'), send('session_message', 'running')]), at)).toEqual([]);
  });
  it('leaves canonical successful message_send rows to the chat index', () => {
    const output = JSON.stringify({ message_id: '11111111-1111-4111-8111-111111111111' });
    expect(taskSearchDocuments('s', turn([send('message_send', 'done', output)]), at)).toEqual([]);
  });
});
