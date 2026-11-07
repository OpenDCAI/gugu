import { describe, expect, it } from 'vitest';
import type { McpToolCall } from '../acp/models/turns/tool-calls';
import type { TranscriptTurn } from '../acp/models/turns/turn';
import { sendAddressesOf } from './send-addresses';

const receipt = 'sent (id=msg:6417511d-8f36-4cbc-8cbb-81ce9f97df73)';
const send = (args: Record<string, unknown> = {}): McpToolCall => ({
  kind: 'mcp-tool-call', id: 'send', toolCallId: 'send', seq: 1, title: 'Send',
  server: 'plugin_gugu-product_gugu', tool: 'message_send', status: 'running',
  rawInput: JSON.stringify({ chat_id: 'group', text: 'A message', ...args }),
});
function record(item: McpToolCall, type = 'agent', chatKind = 'group'): TranscriptTurn {
  return { id: 'turn', seq: 1, initiator: 'user', items: [
    { kind: 'message', id: 'input', seq: 0, role: 'user', text:
      `<gugu_delivery route="chat" chat="group" chat_kind="${chatKind}" from="Sender" from_id="user:sender" from_type="${type}" msg="msg:source"><![CDATA[Hello]]></gugu_delivery>` }, item,
  ] };
}
describe('send addressing facts', () => {
  it('keeps every original recipient, including mixed human/agent addresses', () => {
    const item = send({ to_user_ids: ['user:agent', 'user:human'] });
    expect(sendAddressesOf(item, record(item))).toMatchObject({ recipients: ['user:agent', 'user:human'], confirmed: false });
  });
  it('accepts only the same serialized-array form accepted by the actual tool boundary', () => {
    expect(sendAddressesOf(send({ to_user_ids: '["user:agent"]' }))?.recipients).toEqual(['user:agent']);
    expect(sendAddressesOf(send({ to_user_ids: 'user:agent' }))?.recipients).toBeNull();
    expect(sendAddressesOf(send({ to_user_ids: '[broken' }))?.recipients).toBeNull();
  });
  it('retains addressing for an unsuccessful session receipt without counting it as delivered', () => {
    const item = { ...send(), tool: 'session_message', status: 'done' as const, rawInput: JSON.stringify({ to: ['session:peer'], text: 'hello' }),
      outputText: JSON.stringify({ recipients: [{ status: 'failed', message_id: 'msg:6417511d-8f36-4cbc-8cbb-81ce9f97df73' }] }) };
    expect(sendAddressesOf(item)).toMatchObject({ recipients: ['session:peer'], confirmed: false });
  });
  it('counts only actual successful receipts as sent', () => {
    expect(sendAddressesOf(send({ to_user_ids: ['user:peer'] }))?.confirmed).toBe(false);
    expect(sendAddressesOf({ ...send(), status: 'done', outputText: 'I sent it' })?.confirmed).toBe(false);
    expect(sendAddressesOf({ ...send(), status: 'done', outputText: receipt })?.confirmed).toBe(true);
  });
  it('uses a reply target only when the source message and destination match', () => {
    const item = send({ reply_to_message_id: 'msg:source' });
    expect(sendAddressesOf(item, record(item, 'human'))).toMatchObject({ recipients: ['user:sender'], replyTo: { fromType: 'human' } });
    expect(sendAddressesOf(send({ chat_id: 'elsewhere', reply_to_message_id: 'msg:source' }), record(item, 'human')))
      .toMatchObject({ recipients: null, replyTo: null, chatKind: null });
  });
  it('does not read a later input as the recipient of an earlier send', () => {
    const item = send({ reply_to_message_id: 'msg:source' }), turn = record(item, 'human');
    turn.items.push({ kind: 'message', id: 'later', seq: 2, role: 'user', text: 'Later typed instruction' });
    expect(sendAddressesOf(item, turn)?.replyTo?.fromType).toBe('human');
  });
  it('distinguishes an established group broadcast from unknown or malformed addressing', () => {
    const item = send();
    expect(sendAddressesOf(item, record(item))?.recipients).toEqual([]);
    expect(sendAddressesOf(item)?.recipients).toBeNull();
    expect(sendAddressesOf(send({ to_user_ids: ['user:agent', 42] }), record(item))?.recipients).toBeNull();
    expect(sendAddressesOf(send({ to_user_ids: [] }), record(item))?.recipients).toEqual([]);
  });
  it('keeps direct human recipients without treating the route as an agent identity', () => {
    const item = send();
    expect(sendAddressesOf(item, record(item, 'human', 'dm'))?.recipients).toEqual(['user:sender']);
    expect(sendAddressesOf(send({ chat_id: 'user:owner' }))?.recipients).toEqual(['user:owner']);
  });
  it('leaves failed, nested and unrelated tools outside activity projection', () => {
    for (const item of [{ ...send(), status: 'error' as const }, { ...send(), parentToolCallId: 'child' },
      { ...send(), server: 'other' }, { ...send(), rawInput: '{truncated' }]) expect(sendAddressesOf(item)).toBeNull();
  });
});
