import { describe, expect, it } from 'vitest';
import { liveReplyOf } from './live-reply';
import { replyProcess, replyProcesses } from './reply-process';
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
