import { describe, expect, it } from 'vitest';
import { liveReplyOf } from './live-reply';
import { agentSendOf, canYieldRepliedAssistant, filterTurnsForChat, messageSendTargetOf, replyProcess, replyProcesses } from './reply-process';
import { renderDeliveryEnvelope, mergeDeliveryEnvelopes } from '@gugu/core/local/agent/deliveryEnvelope';
import type { TranscriptTurn } from '../acp/models/turns/turn';
import type { McpToolCall } from '../acp/models/turns/tool-calls';
const messageId = '6417511d-8f36-4cbc-8cbb-81ce9f97df73';
const send = (input: Record<string, unknown> = {}): McpToolCall => ({
  kind: 'mcp-tool-call', id: 'send', toolCallId: 'call', seq: 3, title: 'send',
  tool: 'message_send', server: 'plugin_gugu-product_gugu', status: 'running',
  rawInput: JSON.stringify({ chat_id: 'dm', text: 'First part', ...input }),
});
function turn(tool = send()): TranscriptTurn {
  return { id: 'turn', seq: 1, initiator: 'user', items: [
    { kind: 'message', id: 'input', seq: 0, role: 'user', text: '<gugu_delivery route="chat" from="Owner" from_id="user:owner" msg="msg:source" chat="dm" chat_kind="dm"><![CDATA[Hi]]></gugu_delivery>' },
    { kind: 'thinking', id: 'thought', seq: 1, segmentId: 'segment', text: 'reason', status: 'done', startedAt: 1000, durationMs: 2350 },
    { kind: 'execute-tool-call', id: 'exec', toolCallId: 'cmd', seq: 2, title: 'command', command: 'pwd', status: 'done' }, tool,
  ] };
}
describe('explicit message streaming and reply effort', () => {
  it('uses a real owner envelope and successful root receipt to authorize yielding', () => {
    const next = renderDeliveryEnvelope({ route: 'chat', from: 'Owner', fromId: 'user:owner',
      chat: 'dm', messageId: 'msg:' + messageId, content: 'Next', at: '2026-10-27T04:10:00Z' });
    const sent = { ...send(), status: 'done' as const, outputText: `replied (id=msg:${messageId})` };
    const record = turn(sent);
    expect(canYieldRepliedAssistant(record, next, 'owner')).toBe(true);
    expect(canYieldRepliedAssistant(record, next, 'another-owner')).toBe(false);
    expect(canYieldRepliedAssistant(record, 'typed text', 'owner')).toBe(false);
    for (const tool of [{ ...sent, parentToolCallId: 'child' }, { ...sent, server: 'not-gugu' },
      { ...sent, status: 'error' as const }, { ...sent, outputText: 'I sent it' },
      { ...sent, rawInput: '{truncated' }]) {
      expect(canYieldRepliedAssistant(turn(tool), next, 'owner')).toBe(false);
    }
    record.items.push({ kind: 'message', id: 'new-unanswered', seq: 5, role: 'user', text: next });
    expect(canYieldRepliedAssistant(record, next, 'owner')).toBe(false);
  });
  it('yields after a reply to the last owner delivery in a batch, never a mixed-sender batch', () => {
    const envelope = (id: string, fromId = 'user:owner') => renderDeliveryEnvelope({ route: 'chat', from: 'Sender', fromId,
      chat: 'dm', messageId: 'msg:' + id, content: 'Hi', at: '2026-10-27T04:10:00Z' });
    const record = turn({ ...send({ reply_to_message_id: 'msg:last' }), status: 'done', outputText: `replied (id=msg:${messageId})` });
    const input = record.items[0]; if (input.kind !== 'message') throw Error('fixture');
    input.text = mergeDeliveryEnvelopes([envelope('first'), envelope('last')]);
    expect(canYieldRepliedAssistant(record, envelope('next'), 'owner')).toBe(true);
    input.text = mergeDeliveryEnvelopes([envelope('first', 'user:peer'), envelope('last')]);
    expect(canYieldRepliedAssistant(record, envelope('next'), 'owner')).toBe(false);
  });
  it('previews growing explicit text while message_send is still running', () => {
    expect(liveReplyOf(turn())?.activity).toEqual({ phase: 'draft', id: 'send', text: 'First part' });
    expect(liveReplyOf(turn(send({ text: 'First part, then more' })))?.activity).toMatchObject({ text: 'First part, then more' });
    expect(liveReplyOf(turn())?.sourceMessageId).toBe('msg:source');
  });
  it('matches public chat numbers to the canonical source link, bound to this exact message', () => {
    const chat = '127ec4f0-30b1-4583-b469-706756153bdd';
    const source = 'ee1a78d8-55f3-42ac-b437-4cf4e81a4741';
    const tool = { ...send({ chat_id: chat }), status: 'done' as const, outputText: `replied (id=msg:${messageId})` };
    const record = turn(tool); const input = record.items[0];
    if (input.kind !== 'message') throw new Error('fixture');
    input.text = input.text.replace('chat="dm"', `chat="213036" source_link="gugu-chat://${chat}/${source}"`).replace('msg:source', 'msg:' + source);
    expect(liveReplyOf(record)?.activity).toMatchObject({ phase: 'draft' });
    expect(replyProcesses([record], chat).get(messageId)?.thoughts).toBe(1);
    input.text = input.text.replace('/' + source + '"', '/' + messageId + '"');
    expect(liveReplyOf(record)?.activity.phase).not.toBe('draft');
    expect(replyProcesses([record], chat).size).toBe(0);
  });

  it('does not promote other destinations, tools, subagents, whispers or failed sends', () => {
    const base = send();
    for (const tool of [send({ chat_id: 'other' }), send({ whisper: true }), send({ reply_to_message_id: 'other' }),
      { ...base, server: 'unrelated' }, { ...base, tool: 'message_send_as_owner' }, { ...base, parentToolCallId: 'parent' }, { ...base, status: 'error' as const },
    ]) expect(liveReplyOf(turn(tool))?.activity.phase).not.toBe('draft');
    const batch = turn(); batch.items.push({ kind: 'message', id: 'new', seq: 5, role: 'user', text: 'different request' });
    expect(liveReplyOf(batch)).toBeNull();
  });
  it('binds historical effort to the successful send result, not an inferred final answer', () => {
    const tool = { ...send(), status: 'done' as const, rawOutput: JSON.stringify({ content: [{ type: 'text', text: `sent (id=msg:${messageId})` }] }) };
    const record = turn(tool);
    expect(replyProcesses([record], 'dm').get(messageId)).toEqual({ thoughts: 1, thinkingMs: 2350, tools: 1, commands: 1 });
    expect(replyProcesses([record], 'other').size).toBe(0);
    expect(replyProcesses([turn({ ...tool, rawInput: '{"text":"truncated' })], 'dm').get(messageId)).toEqual({ thoughts: 1, thinkingMs: 2350, tools: 1, commands: 1 });
    expect(replyProcesses([turn({ ...tool, status: 'error' })], 'dm').size).toBe(0);
    expect(replyProcesses([turn({ ...tool, rawOutput: 'some unrelated id=' + messageId })], 'dm').size).toBe(0);
  });
  it('counts grouped root calls once and does not invent unknown thinking seconds', () => {
    const record = turn(); const thought = record.items[1];
    if (thought.kind !== 'thinking') throw new Error('fixture'); delete thought.durationMs;
    const exec = record.items.splice(2, 1)[0];
    if (!exec || exec.kind !== 'execute-tool-call') throw new Error('fixture');
    record.items.splice(2, 0, { kind: 'tool-group', id: 'group', seq: 2, label: 'commands', groupKind: 'read-batch', status: 'done', children: [exec, { ...exec, id: 'child', parentToolCallId: 'parent' }] });
    expect(replyProcess(record, 'send')).toEqual({ thoughts: 1, thinkingMs: 0, tools: 1, commands: 1 });
  });
});

describe('agentSendOf: what the agent said through 咕咕, and where it went', () => {
  const chat = '127ec4f0-30b1-4583-b469-706756153bdd';
  const groupInput = (facts: { thread?: string } = {}) => renderDeliveryEnvelope({ route: 'chat', from: 'Owner', fromId: 'user:owner',
    chat: '216012', chatKind: 'group', sourceLink: `gugu-chat://${chat}/${messageId}`, messageId: 'msg:' + messageId,
    content: 'Go', at: '2026-10-27T04:10:00Z', ...facts });
  const inGroup = (tool: McpToolCall, input = groupInput()): TranscriptTurn => {
    const record = turn(tool); const first = record.items[0];
    if (first.kind !== 'message') throw new Error('fixture');
    first.text = input;
    return record;
  };

  it('names a send to the delivering group by its conversation, whatever number the agent typed', () => {
    const tool = send({ chat_id: '216012', text: 'Round 1: still running' });
    expect(agentSendOf(tool, inGroup(tool))).toEqual({ text: 'Round 1: still running',
      to: { kind: 'chat', conversationId: chat, threadRootId: null, whisper: false } });
  });

  it('a send into the thread this session is bound to says it went to that thread', () => {
    const tool = send({ chat_id: '216012', text: 'In the thread' });
    expect(agentSendOf(tool, inGroup(tool, groupInput({ thread: 'msg:root-1' })))?.to)
      .toEqual({ kind: 'chat', conversationId: chat, threadRootId: 'msg:root-1', whisper: false });
    // A whisper only goes on the main line (the server refuses it in a thread), so it is never "in the thread".
    const whisper = send({ chat_id: '216012', text: 'psst', whisper: true });
    expect(agentSendOf(whisper, inGroup(whisper, groupInput({ thread: 'msg:root-1' })))?.to)
      .toMatchObject({ threadRootId: null, whisper: true });
  });

  it('a send back into the private chat it was answering names the other person, not the chat', () => {
    const dmInput = renderDeliveryEnvelope({ route: 'chat', from: '验收员 (咕咕号 112615)', fromId: 'user:owner',
      chat: '216099', chatKind: 'dm', sourceLink: `gugu-chat://${chat}/${messageId}`, messageId: 'msg:' + messageId,
      content: '你好', at: '2026-10-27T04:10:00Z' });
    const tool = send({ chat_id: '216099', text: '收到' });
    // MBP 验收 10-28:宿主给这个私聊起的名字从主人那边看就是 agent 自己,「发到 Claude 1」读着像发给了自己。
    expect(agentSendOf(tool, inGroup(tool, dmInput))?.to).toMatchObject({ conversationId: chat, peer: '验收员' });
    expect(agentSendOf(tool, inGroup(tool))?.to).not.toHaveProperty('peer');
  });

  it('preserves another chat address for the host to name, without borrowing the delivery destination', () => {
    expect(agentSendOf(send({ chat_id: '999' }), turn())?.to).toMatchObject({ conversationId: null, chatId: '999', threadRootId: null });
    const other = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    expect(agentSendOf(send({ chat_id: other.toUpperCase() }))?.to).toMatchObject({ conversationId: other });
  });

  it('keeps a public-number destination when background work resumes without an incoming message', () => {
    const tool = { ...send({ chat_id: '216012', text: 'Background result' }), status: 'done' as const,
      outputText: `sent (id=msg:${messageId})` };
    const record: TranscriptTurn = { id: 'background', seq: 2, initiator: 'agent', items: [tool], outcome: { kind: 'done' } };
    expect(agentSendOf(tool, record)).toEqual({ text: 'Background result',
      to: { kind: 'chat', conversationId: null, chatId: '216012', threadRootId: null, whisper: false } });
  });

  it('session_message counts its recipients', () => {
    const relay = { ...send(), tool: 'session_message', rawInput: JSON.stringify({ to: ['session:a', 'session:b'], text: 'done' }) };
    expect(agentSendOf(relay)).toEqual({ text: 'done', to: { kind: 'session', count: 2 } });
  });

  it.each(['message_send_file', 'mcp__gugu__message_send_file'])('names a captionless %s destination without turning the attachment into text', toolName => {
    const file = { ...send(), tool: toolName, rawInput: JSON.stringify({ chat_id: '216012', file_path: '/fixture/proof.txt' }) };
    expect(messageSendTargetOf(file, inGroup(file, groupInput({ thread: 'msg:root-1' }))))
      .toEqual({ kind: 'chat', conversationId: chat, threadRootId: 'msg:root-1', whisper: false });
    expect(agentSendOf(file)).toBeNull();
  });

  it('preserves a file destination instead of borrowing the last input, and rejects missing or untrusted addresses', () => {
    const file = { ...send(), tool: 'message_send_file', rawInput: JSON.stringify({ chat_id: '999', file_name: 'proof.txt' }) };
    expect(messageSendTargetOf(file, inGroup(file))).toEqual({ kind: 'chat', conversationId: null, chatId: '999', threadRootId: null, whisper: false });
    for (const item of [{ ...file, status: 'error' as const }, { ...file, parentToolCallId: 'child' }, { ...file, server: 'unrelated' },
      { ...file, tool: 'unrelated_send_file' }, { ...file, rawInput: '{truncated' }, { ...file, rawInput: '{"file_name":"proof.txt"}' }]) {
      expect(messageSendTargetOf(item, inGroup(item))).toBeNull();
    }
  });

  it('stays a tool row when it failed, is a subagent\'s, is not 咕咕\'s, or its text did not survive transport', () => {
    const base = send();
    for (const tool of [{ ...base, status: 'error' as const }, { ...base, parentToolCallId: 'child' }, { ...base, server: 'unrelated' },
      { ...base, tool: 'message_send_as_owner' }, { ...base, rawInput: '{"chat_id":"dm","text":"cut' }, send({ text: '  ' })]) {
      expect(agentSendOf(tool, turn(tool))).toBeNull();
    }
  });
});


describe('filterTurnsForChat: the turns of one chat with the agent', () => {
  const delivered = (id: string, chat: string): TranscriptTurn => ({ id, seq: 1, initiator: 'user', items: [
    { kind: 'message', id: `${id}:in`, seq: 0, role: 'user', text: renderDeliveryEnvelope({ route: 'chat', from: 'Owner',
      fromId: 'user:owner', chat, messageId: `msg:${id}`, content: 'Hi', at: '2026-10-27T04:10:00Z' }) },
  ] });
  const typed = (id: string): TranscriptTurn => ({ id, seq: 1, initiator: 'user', items: [
    { kind: 'message', id: `${id}:in`, seq: 0, role: 'user', text: 'typed on the task page' },
  ] });
  const sentTo = (id: string, chat: string, status: 'done' | 'error' = 'done'): TranscriptTurn => ({ ...typed(id), items: [
    { kind: 'message', id: `${id}:in`, seq: 0, role: 'user', text: 'scheduled: report back' },
    { ...send({ chat_id: chat }), id: `${id}:send`, status, outputText: `sent (id=msg:${messageId})` },
  ] });

  it('keeps what was delivered from this chat and what the agent sent to it, nothing else', () => {
    const turns = [delivered('a', 'dm'), delivered('b', 'group'), typed('c'), sentTo('d', 'dm'), sentTo('e', 'group'), sentTo('f', 'dm', 'error')];
    expect(filterTurnsForChat(turns, 'dm').map((t) => t.id)).toEqual(['a', 'd']);
  });

  it('keeps a batch that carries this chat among others', () => {
    const batch = delivered('g', 'group');
    const input = batch.items[0]; if (input.kind !== 'message') throw new Error('fixture');
    input.text = mergeDeliveryEnvelopes([input.text, renderDeliveryEnvelope({ route: 'chat', from: 'Owner', fromId: 'user:owner',
      chat: 'dm', messageId: 'msg:h', content: 'Also', at: '2026-10-27T04:11:00Z' })]);
    expect(filterTurnsForChat([batch], 'dm').map((t) => t.id)).toEqual(['g']);
    expect(filterTurnsForChat([batch], 'other')).toEqual([]);
  });
});
