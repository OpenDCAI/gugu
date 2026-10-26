import { describe, expect, it } from 'vitest';
import type { TranscriptTurn } from '@session-chat/model';
import { withSentReplies } from './sent-replies';
import { flattenTier } from './flatten';
import { unit, type ItemSegmenter, type SegmentCtx } from '@session-chat/core/units';
import { defaultChatTranslator } from '@session-chat/localization';
type McpToolCall = Extract<TranscriptTurn['items'][number], { kind: 'mcp-tool-call' }>;

const id = '6417511d-8f36-4cbc-8cbb-81ce9f97df73';
const send = (input: Record<string, unknown> = {}): McpToolCall => ({
  kind: 'mcp-tool-call', id: 'send', toolCallId: 'call', seq: 2, title: 'send',
  tool: 'message_send', server: 'plugin_gugu-product_gugu', status: 'done',
  rawInput: JSON.stringify({ chat_id: 'group', text: '你好，我在。', ...input }),
  outputText: `sent (id=msg:${id})`,
});
function turn(tool = send()): TranscriptTurn {
  return { id: 'turn', seq: 1, initiator: 'user', items: [
    { kind: 'message', id: 'input', seq: 0, role: 'user', text: '<gugu_delivery route="chat" from="Owner" from_id="user:owner" msg="msg:source" chat="group" chat_kind="group"><![CDATA[你好]]></gugu_delivery>' }, tool,
  ] };
}
const words = (record: TranscriptTurn) => record.items.filter(item => item.kind === 'message' && item.role === 'assistant');

describe('session replies sent to IM', () => {
  it('exposes a successful send as ordinary reply text without changing the saved transcript', () => {
    const original = turn();
    expect(words(withSentReplies(original))).toMatchObject([{ text: '你好，我在。' }]);
    expect(words(original)).toHaveLength(0);
    expect(withSentReplies(original).items).toContain(original.items[1]);
  });
  it('keeps a delivered reply reachable in the collapsed transcript', () => {
    const record = turn();
    record.outcome = { kind: 'done', reason: 'end_turn' };
    const segmenters = Object.fromEntries(['message', 'mcp-tool-call', 'turn-process', 'turn-completion'].map(kind => [kind, {
      kind, segment: item => [unit(item.kind, item, item, { key: 'self' })],
    } satisfies ItemSegmenter]));
    const ctx = { caches: {}, expanded: () => false, active: false, foldTurnProcess: true,
      plan: () => null, translate: defaultChatTranslator, pendingToolCallIds: () => new Set(),
      terminalOutputText: () => null, terminalExitStatus: () => null } as unknown as SegmentCtx;
    const rows = flattenTier([record], ctx, segmenters);
    expect(rows.some(row => row.kind === 'message' && row.data !== null && typeof row.data === 'object' && 'text' in row.data && row.data.text === '你好，我在。')).toBe(true);
  });
  it('rejects other chats, whispers, mismatched quotes, nested agents, failed and unconfirmed sends', () => {
    for (const call of [send({ chat_id: 'other' }), send({ whisper: true }), send({ reply_to_message_id: 'other' }),
      { ...send(), parentToolCallId: 'child' }, { ...send(), server: 'other' },
      { ...send(), status: 'error' as const }, { ...send(), status: 'running' as const },
      { ...send(), outputText: 'failed' }, { ...send(), rawInput: 'truncated' },
    ]) expect(words(withSentReplies(turn(call)))).toHaveLength(0);
  });
  it('keeps separate successful replies in order and deduplicates replayed calls by DB message id', () => {
    const record = turn();
    record.items.push({ ...send({ text: '第二条回复' }), id: 'next', outputText: 'sent (id=msg:7417511d-8f36-4cbc-8cbb-81ce9f97df73)' }, send());
    expect(words(withSentReplies(record))).toMatchObject([{ text: '你好，我在。' }, { text: '第二条回复' }]);
  });
  it('includes a reply from a task thread in its own session', () => {
    const record = turn();
    const input = record.items[0];
    if (input.kind !== 'message') throw new Error('fixture');
    input.text = input.text.replace('route="chat"', 'route="chat" thread="msg:task-root"');
    expect(words(withSentReplies(record))).toMatchObject([{ text: '你好，我在。' }]);
  });
  it('does not duplicate an existing assistant reply or an already projected turn', () => {
    const record = turn();
    record.items.push({ kind: 'message', id: 'answer', seq: 3, role: 'assistant', text: '你好，我在。' });
    expect(withSentReplies(record)).toBe(record);
    const projected = withSentReplies(turn());
    expect(withSentReplies(projected)).toBe(projected);
  });
});
