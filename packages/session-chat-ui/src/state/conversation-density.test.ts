import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@session-chat/model';
import type { RenderUnit } from '@session-chat/core/units';
import { conversationSpeaker, decorateConversationDensity, isAdjacentConversationReply, lastConversationMessage } from './conversation-density';
const message = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ kind: 'message', id, role: 'assistant', text: id, ...extra });
const unit = (data: ChatMessage): RenderUnit => ({ id: data.id, itemId: data.id, groupId: data.id, kind: 'message', groupRole: 'solo', gapBefore: 0, data });

describe('conversation density identities', () => {
  it('matches exact native or IM identity, never equal text', () => {
    const previous = message('runtime', { sourceItemId: 'persisted', role: 'user', text: 'same words' });
    expect(isAdjacentConversationReply(message('next', { conversationReply: { itemId: 'runtime', text: 'other words' } }), previous)).toBe(true);
    expect(isAdjacentConversationReply(message('next', { conversationReply: { itemId: 'gugu-session://11111111-1111-4111-8111-111111111111?message=persisted', text: '' } }), previous)).toBe(true);
    expect(isAdjacentConversationReply(message('next', { conversationReply: { itemId: 'different', text: 'same words' } }), previous)).toBe(false);
    const incoming = message('envelope', { role: 'user', text: '<gugu_delivery route="chat" msg="msg:original" from_id="user:peer"><![CDATA[same words]]></gugu_delivery>' });
    expect(isAdjacentConversationReply(message('sent', { conversationReply: { itemId: 'original', text: '' } }), incoming)).toBe(true);
    expect(isAdjacentConversationReply(message('sent', { conversationReply: { itemId: 'unknown', text: 'same words' } }), incoming)).toBe(false);
  });
  it('compares the exact segment of a batched delivery', () => {
    const previous = message('batch', { role: 'user', text: '', guguDelivery: { body: '', segments: [
      { body: 'first', facts: { messageId: 'msg:first', fromId: 'user:one' } },
      { body: 'last', facts: { messageId: 'msg:last', fromId: 'user:two' } },
    ] } as ChatMessage['guguDelivery'] });
    expect(isAdjacentConversationReply(message('reply', { conversationReply: { itemId: 'batch', messageId: 'first', text: '' } }), previous)).toBe(false);
    expect(isAdjacentConversationReply(message('reply', { conversationReply: { itemId: 'batch', messageId: 'last', text: '' } }), previous)).toBe(true);
  });
  it('preserves the preceding actual message across head/body rows and tier seams', () => {
    const input = message('input', { role: 'user' });
    const head = message('head', { conversationPart: 'head', conversationReply: { itemId: 'input', text: 'input' } });
    const body = message('body', { conversationPart: 'body', conversationHead: 'head' });
    const units = decorateConversationDensity([unit(head), unit(body)], input);
    expect((units[0]!.data as ChatMessage).conversationReplyAdjacent).toBe(true);
    expect((units[0]!.data as ChatMessage).conversationPreviousSpeaker).toBe('$owner');
    expect(lastConversationMessage(units)?.id).toBe('body');
    const next = decorateConversationDensity([unit(message('next', { conversationPart: 'head' }))], lastConversationMessage(units));
    expect((next[0]!.data as ChatMessage).conversationPreviousSpeaker).toBe('$agent');
  });
  it('never combines unknown actors merely because they share a name', () => {
    const unknown = message('unknown', { role: 'user', text: '<gugu_delivery route="chat" from="Same"><![CDATA[hello]]></gugu_delivery>' });
    expect(conversationSpeaker(unknown)).toBeUndefined();
    const known = { ...unknown, text: '<gugu_delivery route="chat" from="Same" from_id="user:peer"><![CDATA[hello]]></gugu_delivery>' };
    expect(conversationSpeaker(known)).toBe('user:peer');
  });
});
