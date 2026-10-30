import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@session-chat/model';
import type { RenderUnit } from '@session-chat/core/units';
import { conversationSpeaker, decorateConversationDensity, messageReplyReference, lastConversationMessage } from './conversation-density';
const message = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ kind: 'message', id, role: 'assistant', text: id, ...extra });
const unit = (data: ChatMessage): RenderUnit => ({ id: data.id, itemId: data.id, groupId: data.id, kind: 'message', groupRole: 'solo', gapBefore: 0, data });

describe('conversation density identities', () => {
  it('requires message transport and an explicit anchor, regardless of target author or position', () => {
    const quote = { itemId: 'source', text: 'original', fromId: 'user:owner' };
    expect(messageReplyReference(message('direct', { conversationReply: quote }))).toBeNull();
    expect(messageReplyReference(message('tool', { sentReplyTo: 'source', conversationReply: quote }))).toBe(quote);
    expect(messageReplyReference(message('tool', { sentReplyTo: 'older', conversationReply: { ...quote, fromId: 'user:peer' } }))).not.toBeNull();
    expect(messageReplyReference(message('tool', { sentReplyTo: 'source' }))).toBeNull();
    const native = { ...quote, itemId: 'gugu-session://11111111-1111-4111-8111-111111111111?message=source' };
    expect(messageReplyReference(message('quoted-input', { role: 'user', conversationReply: native }))).toBe(native);
    expect(messageReplyReference(message('direct', { conversationReply: native }))).toBeNull();
    const delivery = message('envelope', { role: 'user', text: '<gugu_delivery route="chat" msg="msg:original" from_id="user:owner"><![CDATA[body]]></gugu_delivery>', conversationReply: quote });
    expect(messageReplyReference(delivery)).toBe(quote);
    expect(messageReplyReference({ ...delivery, conversationPart: 'body' })).toBeNull();
  });
  it('preserves the preceding actual message across head/body rows and tier seams', () => {
    const input = message('input', { role: 'user' });
    const head = message('head', { conversationPart: 'head', conversationReply: { itemId: 'input', text: 'input' } });
    const body = message('body', { conversationPart: 'body', conversationHead: 'head' });
    const units = decorateConversationDensity([unit(head), unit(body)], input);
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
