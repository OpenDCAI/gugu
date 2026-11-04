import { describe, expect, it } from 'vitest';
import { sendReceipt } from './send-receipt';

const receipt = { route: 'session-direct', recipients: [{ status: 'queued', message_id: 'msg:6417511d-8f36-4cbc-8cbb-81ce9f97df73' }] };
const content = [{ type: 'text', text: JSON.stringify(receipt) }];

describe('MCP send receipts', () => {
  it.each([
    ['native content array', content], ['encoded native content array', JSON.stringify(content)],
    ['content envelope', { content }], ['encoded content envelope', JSON.stringify({ content })],
    ['direct receipt', receipt], ['encoded direct receipt', JSON.stringify(receipt)],
  ])('unwraps %s', (_name, raw) => {
    expect(sendReceipt(raw)).toEqual(receipt);
  });

  it.each([
    { isError: true, content }, { ok: false, content }, { status: 'error', content }, { status: 'failed', content },
  ])('does not turn an error envelope into success: %j', raw => {
    expect(sendReceipt(raw)).toBeNull();
    expect(sendReceipt(JSON.stringify(raw))).toBeNull();
    expect(sendReceipt([{ type: 'text', text: JSON.stringify(raw) }])).toBeNull();
  });

  it('only unwraps text blocks, skipping malformed content without inventing a receipt', () => {
    expect(sendReceipt([null, { type: 'image', text: JSON.stringify(receipt) }, { type: 'text', text: '{truncated' }])).toBeNull();
    expect(sendReceipt([{ type: 'text', text: 'Progress only' }, ...content])).toEqual(receipt);
  });
});
