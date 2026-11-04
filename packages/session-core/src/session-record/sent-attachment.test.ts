import { describe, expect, it } from 'vitest';
import { sentAttachmentOf } from './sent-attachment';
import type { McpToolCall } from '../acp/models/turns/tool-calls';
const id = '6417511d-8f36-4cbc-8cbb-81ce9f97df73';
const call: McpToolCall = { kind: 'mcp-tool-call', id: 'file', toolCallId: 'file', seq: 1, title: 'Send file', tool: 'message_send_file',
  server: 'plugin_gugu-product_gugu', status: 'done', rawInput: JSON.stringify({ chat_id: 'dm', file_path: '/private/actual.txt' }),
  outputText: JSON.stringify({ status: 'sent', message_id: id, file_name: 'proof.txt', file: `gugu-file://${id}?v=3` }) };
describe('confirmed sent attachments', () => {
  it('uses the receipt identity, filename and pinned file revision', () => {
    expect(sentAttachmentOf(call)).toEqual({ messageId: id, name: 'proof.txt', kind: 'file', href: `gugu-message-file://${id}` });
  });
  it('reads native MCP content and normalizes the message address without exposing a local path', () => {
    const output = { content: [{ type: 'text', text: JSON.stringify({ ok: true, message_id: `msg:${id}`, file_name: 'phone.txt' }) }] };
    expect(sentAttachmentOf({ ...call, rawOutput: JSON.stringify(output), outputText: undefined })).toEqual({ messageId: id, name: 'phone.txt', kind: 'file', href: `gugu-message-file://${id}` });
  });
  it('requires a successful root Gugu file-send receipt', () => {
    for (const changed of [{ status: 'running' }, { status: 'error' }, { parentToolCallId: 'nested' }, { server: 'unrelated' }, { tool: 'message_send' }, { outputText: 'failed' }]) {
      expect(sentAttachmentOf({ ...call, ...changed } as McpToolCall)).toBeNull();
    }
  });
});

it.each([['image/png', 'proof.bin', 'image'], [undefined, 'PHOTO.JPEG', 'image'], ['application/octet-stream', 'proof.png', 'file'], [undefined, 'report.pdf', 'file']])('uses MIME %s and filename %s to classify %s', (mime_type, file_name, kind) => {
  const chatId = '127ec4f0-30b1-4583-b469-706756153bdd';
  const result = sentAttachmentOf({ ...call, outputText: JSON.stringify({ message_id: id, mime_type, file_name, source_link: `gugu-chat://${chatId}/${id}` }) });
  expect(result).toMatchObject({ kind, href: `gugu-message-file://${id}?chat=${chatId}` });
});
it('does not turn an MCP error into a file when its flattened text still resembles a receipt', () => {
  expect(sentAttachmentOf({ ...call, rawOutput: JSON.stringify({ isError: true, content: [{ type: 'text', text: call.outputText }] }) })).toBeNull();
});
