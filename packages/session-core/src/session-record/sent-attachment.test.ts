import { describe, expect, it } from 'vitest';
import { sentAttachmentOf } from './sent-attachment';
import type { McpToolCall } from '../acp/models/turns/tool-calls';
const id = '6417511d-8f36-4cbc-8cbb-81ce9f97df73';
const call: McpToolCall = { kind: 'mcp-tool-call', id: 'file', toolCallId: 'file', seq: 1, title: 'Send file', tool: 'message_send_file',
  server: 'plugin_gugu-product_gugu', status: 'done', rawInput: JSON.stringify({ chat_id: 'dm', file_path: '/private/actual.txt' }),
  outputText: JSON.stringify({ status: 'sent', message_id: id, file_name: 'proof.txt', file: `gugu-file://${id}?v=3` }) };
describe('confirmed sent attachments', () => {
  it('uses the receipt identity, filename and pinned file revision', () => {
    expect(sentAttachmentOf(call)).toEqual({ messageId: id, name: 'proof.txt', href: `gugu-file://${id}?v=3` });
  });
  it('reads native MCP content and normalizes the message address without exposing a local path', () => {
    const output = { content: [{ type: 'text', text: JSON.stringify({ ok: true, message_id: `msg:${id}`, file_name: 'phone.txt' }) }] };
    expect(sentAttachmentOf({ ...call, rawOutput: JSON.stringify(output), outputText: undefined })).toEqual({ messageId: id, name: 'phone.txt', href: `gugu-message-file://${id}` });
  });
  it('keeps authorized IM metadata when an older receipt does not include the full file pointer', () => {
    const file = { messageId: id, name: 'retained.txt', href: `gugu-file://${id}?v=4`, caption: 'Caption' };
    expect(sentAttachmentOf(call, { [id]: file })).toBe(file);
  });
  it('requires a successful root Gugu file-send receipt', () => {
    for (const changed of [{ status: 'running' }, { status: 'error' }, { parentToolCallId: 'nested' }, { server: 'unrelated' }, { tool: 'message_send' }, { outputText: 'failed' }]) {
      expect(sentAttachmentOf({ ...call, ...changed } as McpToolCall)).toBeNull();
    }
  });
});
