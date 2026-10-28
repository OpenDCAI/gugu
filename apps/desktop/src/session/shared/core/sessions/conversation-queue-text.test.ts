import { expect, it } from 'vitest';
import { renderDeliveryEnvelope, readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { conversationQueueText, editedConversationQueueText } from './conversation-queue-text';

it('edits human DM words without dropping the source, sender, reply or return route', () => {
  const original = renderDeliveryEnvelope({ route: 'chat', from: 'Owner', fromType: 'human', fromId: 'user:owner', chat: 'dm-1', chatKind: 'ai', messageId: 'msg:request', at: '2026-10-28', sourceLink: 'gugu-chat://dm-1/request', replyTo: { messageId: 'msg:older', fromId: 'user:agent', from: 'Agent', preview: 'result' }, content: 'before' });
  expect(conversationQueueText(original)).toBe('before');
  const next = editedConversationQueueText(original, 'after\nwith a newline');
  expect(readDeliveryEnvelope(next)?.segments[0]?.facts).toEqual(readDeliveryEnvelope(original)?.segments[0]?.facts);
  expect(conversationQueueText(next)).toBe('after\nwith a newline');
  expect(editedConversationQueueText('plain project prompt', 'changed')).toBe('changed');
});
