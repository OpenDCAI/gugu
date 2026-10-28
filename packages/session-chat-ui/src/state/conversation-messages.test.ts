import { describe, expect, it } from 'vitest';
import { conversationMessages } from './conversation-messages';
import type { ChatMessage, TranscriptTurn } from '@session-chat/model';

describe('conversation reply references', () => {
  it('resolves a reply to the actual earlier sender across turns without mutating stored messages', () => {
    const turns: TranscriptTurn[] = [
      { id: 't1', seq: 0, initiator: 'user', items: [
        { kind: 'message', id: 'incoming', seq: 0, role: 'user', text: '<gugu_delivery route="chat" msg="msg:original" from="天天" from_id="user:other"><![CDATA[你好]]></gugu_delivery>' },
        { kind: 'message', id: 'answer:sent:sent-id', seq: 1, role: 'assistant', text: '你好，天天' },
      ] },
      { id: 't2', seq: 1, initiator: 'user', items: [
        { kind: 'message', id: 'next', seq: 2, role: 'user', text: '<gugu_delivery route="chat" from="天天" from_id="user:other"><reply_to msg="msg:sent-id" from_id="user:subject"><![CDATA[你好，天天]]></reply_to><![CDATA[收到]]></gugu_delivery>' },
      ] },
    ];
    const projected = conversationMessages(turns);
    expect((projected[0].items[1] as ChatMessage).conversationReply).toEqual({ itemId: 'incoming', text: '你好' });
    expect((projected[1].items[0] as ChatMessage).conversationReply).toEqual({ itemId: 'answer:sent:sent-id', text: '你好，天天' });
    expect((turns[0].items[1] as ChatMessage).conversationReply).toBeUndefined();
  });
});
