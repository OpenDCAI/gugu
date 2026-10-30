import { describe, expect, it } from 'vitest';
import type { TranscriptTurn } from '@session-chat/model';
import { withSentReplies } from './sent-replies';
import { flattenTier } from './flatten';
import { unit, type ItemSegmenter, type SegmentCtx } from '@session-chat/core/units';
import { defaultChatTranslator } from '@session-chat/localization';
import { conversationMessages } from './conversation-messages';
import { messageReplyReference } from './conversation-density';
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
type Message = Extract<TranscriptTurn['items'][number], { kind: 'message' }>;
const words = (record: TranscriptTurn) => record.items.filter((item): item is Message => item.kind === 'message' && item.role === 'assistant');

describe('session replies sent to IM', () => {
  it('exposes a successful send as ordinary reply text without changing the saved transcript', () => {
    const original = turn();
    expect(words(withSentReplies(original))).toMatchObject([{ text: '你好，我在。' }]);
    expect(words(original)).toHaveLength(0);
    expect(withSentReplies(original).items).toContain(original.items[1]);
  });
  it('keeps a delivered reply reachable in the collapsed transcript, once, as the agent\'s words', () => {
    const record = turn();
    record.outcome = { kind: 'done', reason: 'end_turn' };
    const segmenters = Object.fromEntries(['message', 'mcp-tool-call', 'agent-send', 'turn-process', 'turn-completion'].map(kind => [kind, {
      kind, segment: item => [unit(item.kind, item, item, { key: 'self' })],
    } satisfies ItemSegmenter]));
    const ctx = { caches: {}, expanded: () => false, active: false, foldTurnProcess: true,
      plan: () => null, translate: defaultChatTranslator, pendingToolCallIds: () => new Set(),
      terminalSnapshot: () => null } as unknown as SegmentCtx;
    const rows = flattenTier([record], ctx, segmenters);
    // On the session page the send is drawn as the agent's words (agent-send); the reply copied out of it is not drawn again.
    const said = rows.filter(row => (row.kind === 'agent-send' && (row.data as { send?: { text?: string } }).send?.text === '你好，我在。')
      || (row.kind === 'message' && (row.data as { text?: string }).text === '你好，我在。'));
    expect(said.map(row => row.kind)).toEqual(['agent-send']);
  });
  it('rejects other chats, whispers, mismatched quotes, nested agents, failed and unconfirmed sends', () => {
    for (const call of [send({ chat_id: 'other' }), send({ whisper: true }), send({ reply_to_message_id: 'other' }),
      { ...send(), parentToolCallId: 'child' }, { ...send(), server: 'other' },
      { ...send(), status: 'error' as const }, { ...send(), status: 'running' as const },
      { ...send(), outputText: 'failed' }, { ...send(), rawInput: 'truncated' },
    ]) expect(words(withSentReplies(turn(call)))).toHaveLength(0);
  });
  it('carries the reply_to_message_id the agent passed, and nothing when it passed none', () => {
    const quoted = words(withSentReplies(turn(send({ chat_id: 'other', reply_to_message_id: 'msg:abc' })), { allDestinations: true }));
    expect(quoted).toMatchObject([{ sentReplyTo: 'abc', sentChat: 'other' }]);
    expect(words(withSentReplies(turn(send({ chat_id: 'other' })), { allDestinations: true }))[0]).not.toHaveProperty('sentReplyTo');
  });
  it('in the agent conversation keeps a send even when the turn also said the same words', () => {
    const record = turn(send({ text: '完成' }));
    record.items.push({ kind: 'message', id: 'final', seq: 3, role: 'assistant', text: '完成' });
    // MBP 验收 10-28:发到群里的「完成」和最后说的「完成」是两条输出,❌ 撞字就丢了发出去的那条。
    expect(words(withSentReplies(record, { allDestinations: true })).map(item => item.id)).toEqual([`send:sent:${id}`, 'final']);
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

it('projects proactive confirmed sends to another chat only in agent-centered mode', () => {
  const record = turn(send({ chat_id: 'another-chat', text: '天天，你好。' }));
  expect(words(withSentReplies(record))).toHaveLength(0);
  expect(words(withSentReplies(record, { allDestinations: true }))).toMatchObject([{ text: '天天，你好。' }]);
  const direct = { ...record, items: [{ kind: 'message' as const, id: 'direct', seq: 0, role: 'user' as const, text: '给天天发个你好' }, record.items[1]] };
  expect(words(withSentReplies(direct, { allDestinations: true }))).toMatchObject([{ text: '天天，你好。' }]);
  for (const call of [{ ...send(), status: 'error' as const }, { ...send(), parentToolCallId: 'nested' }, { ...send(), outputText: 'unknown' }]) {
    expect(words(withSentReplies(turn(call), { allDestinations: true }))).toHaveLength(0);
  }
});

it('places the actual sent message immediately after its successful call, before the final commentary', () => {
  const record = turn(send({ chat_id: 'another-chat', text: '天天，你好。' }));
  record.items.push({ kind: 'message', id: 'summary', seq: 3, role: 'assistant', text: '已发送。' });
  expect(withSentReplies(record, { allDestinations: true }).items.map(item => item.id)).toEqual(['input', 'send', `send:sent:${id}`, 'summary']);
});

it('binds a tool-only group reply to its footer instead of a duplicate process heading', () => {
  const record = turn();
  record.startedAt = 1000;
  record.endedAt = 24000;
  record.outcome = { kind: 'done', reason: 'end_turn' };
  Object.assign(record.items[1], { completedAt: 4000 });
  record.items.push({ kind: 'message', id: 'silence', seq: 3, role: 'assistant', text: '[NO_REPLY]' });
  const segmenters = Object.fromEntries(['message', 'mcp-tool-call', 'turn-process', 'turn-completion', 'day-separator'].map(kind => [kind, {
    kind, segment: item => [unit(item.kind, item, item, { key: 'self' })],
  } satisfies ItemSegmenter]));
  const ctx = { caches: {}, expanded: () => false, active: false, foldTurnProcess: true, agentConversation: true,
    plan: () => null, translate: defaultChatTranslator, pendingToolCallIds: () => new Set(),
    terminalSnapshot: () => null } as unknown as SegmentCtx;
  const rows = flattenTier([record], ctx, segmenters);
  expect(rows.filter(row => row.kind === 'turn-process').map(row => row.data)).toMatchObject([{ silent: true }]);
  const head = rows.find(row => row.kind === 'message' && (row.data as { conversationPart?: string }).conversationPart === 'head')?.data;
  const delivered = rows.find(row => row.itemId.includes(':sent:') && !row.itemId.endsWith(':head'))?.data;
  expect(head).toMatchObject({ conversationPart: 'head', conversationProcess: { startedAt: 1000, endedAt: 4000 } });
  expect(delivered).toMatchObject({ text: '你好，我在。', conversationPart: 'body' });
});

it('projects text, a confirmed file card and text at their actual call positions in every agent conversation', () => {
  const first = send({ text: 'First' });
  const file = { ...send(), id: 'file', toolCallId: 'file', seq: 3, tool: 'message_send_file',
    rawInput: JSON.stringify({ chat_id: 'group', file_path: '/private/proof.txt' }),
    outputText: JSON.stringify({ status: 'sent', message_id: '7417511d-8f36-4cbc-8cbb-81ce9f97df73', file_name: 'proof.txt', file: `gugu-file://${id}?v=2` }) };
  const last = { ...send({ text: 'Last' }), id: 'last', toolCallId: 'last', seq: 4, outputText: 'sent (id=msg:8417511d-8f36-4cbc-8cbb-81ce9f97df73)' };
  const record = { ...turn(first), items: [turn(first).items[0], first, file, last] };
  const projected = withSentReplies(record, { allDestinations: true });
  expect(words(projected).map(item => item.kind === 'message' ? item.text : '')).toEqual(['First', 'proof.txt', 'Last']);
  expect(words(projected)[1]).toMatchObject({ sentAttachment: { name: 'proof.txt', href: `gugu-file://${id}?v=2` } });
  expect(withSentReplies(projected, { allDestinations: true })).toBe(projected);
});

it('keeps direct output after an injected DM reply, without adding a source arrow', () => {
  const record = turn();
  const input = record.items[0];
  if (input.kind !== 'message') throw new Error('fixture');
  input.text = input.text.replace('chat_kind="group"', 'chat_kind="dm"');
  record.items.push({ kind: 'message', id: 'task-summary', seq: 3, role: 'assistant', text: 'T1062-ADJ-OK 已回复。' });
  expect(words(withSentReplies(record, { allDestinations: true })).map(item => item.text)).toEqual(['你好，我在。', 'T1062-ADJ-OK 已回复。']);
  const direct = conversationMessages([record])[0]!.items.find(item => item.id === 'task-summary');
  expect(direct).toMatchObject({ text: 'T1062-ADJ-OK 已回复。' });
  expect(direct?.kind === 'message' && messageReplyReference(direct)).toBeNull();
  expect(record.items.at(-1)?.id).toBe('task-summary');
});

it('keeps a normal task response and the explanation of an unsuccessful DM reply', () => {
  const record = turn({ ...send(), status: 'error' });
  const input = record.items[0];
  if (input.kind !== 'message') throw new Error('fixture');
  input.text = input.text.replace('chat_kind="group"', 'chat_kind="dm"');
  record.items.push({ kind: 'message', id: 'error', seq: 3, role: 'assistant', text: 'The send failed.' });
  expect(words(withSentReplies(record, { allDestinations: true })).map(item => item.kind === 'message' ? item.text : '')).toEqual(['The send failed.']);
  input.text = 'A task typed directly in this session';
  expect(words(withSentReplies(record, { allDestinations: true })).map(item => item.kind === 'message' ? item.text : '')).toEqual(['The send failed.']);
});

it('keeps one file projection and direct commentary after an injected DM attachment send', () => {
  const file = { ...send({ chat_id: 'group', file_name: 'reply.txt' }), tool: 'message_send_file',
    rawInput: JSON.stringify({ chat_id: 'group', file_name: 'reply.txt', file_path: '/fixture/reply.txt' }),
    outputText: JSON.stringify({ status: 'sent', message_id: id, file_name: 'reply.txt' }) };
  const record = turn(file);
  const input = record.items[0];
  if (input.kind !== 'message') throw new Error('fixture');
  input.text = input.text.replace('chat_kind="group"', 'chat_kind="dm"');
  record.items.push({ kind: 'message', id: 'summary', seq: 3, role: 'assistant', text: 'I sent the file.' });
  const projected = withSentReplies(record, { allDestinations: true });
  expect(words(projected)).toMatchObject([{ text: 'reply.txt', sentAttachment: { messageId: id } }, { text: 'I sent the file.' }]);
  expect(words(projected)[0]).toMatchObject({ sentTo: { kind: 'chat', conversationId: null, chatId: 'group', threadRootId: null, whisper: false, peer: 'Owner' } });
  expect(projected.items.filter(item => item.kind === 'message' && 'sentAttachment' in item && item.sentAttachment)).toHaveLength(1);
  expect(withSentReplies(projected, { allDestinations: true })).toBe(projected);
  expect(record.items.at(-1)?.id).toBe('summary');
});

it('keeps a distant DM reply and direct output in order', () => {
  const record = turn(send({ reply_to_message_id: 'older', text: 'T1062-DISTANT-OK' }));
  const input = record.items[0];
  if (input.kind !== 'message') throw new Error('fixture');
  input.text = input.text.replace('chat_kind="group"', 'chat_kind="dm"');
  record.items.push({ kind: 'message', id: 'direct', seq: 3, role: 'assistant', text: 'T1062-DISTANT-OK 已发出。' });
  expect(words(withSentReplies(record, { allDestinations: true })).map(item => item.text)).toEqual(['T1062-DISTANT-OK', 'T1062-DISTANT-OK 已发出。']);
  const direct = conversationMessages([record])[0]!.items.find(item => item.id === 'direct');
  expect(direct?.kind === 'message' && messageReplyReference(direct)).toBeNull();
});
