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
    // owner 10-28:没传 reply_to_message_id 的输出 ❌ 猜成在回上一条。
    expect((projected[0].items[1] as ChatMessage).conversationReply).toBeUndefined();
    expect((projected[1].items[0] as ChatMessage).conversationReply).toEqual({ itemId: 'answer:sent:sent-id', text: '你好，天天', self: true });
    expect((turns[0].items[1] as ChatMessage).conversationReply).toBeUndefined();
  });
  it('quotes a message_send only by the reply_to_message_id it passed, naming who said it', () => {
    const turns: TranscriptTurn[] = [{ id: 't1', seq: 0, initiator: 'user', items: [
      { kind: 'message', id: 'incoming', seq: 0, role: 'user', text: '<gugu_delivery route="chat" msg="msg:original" from="天天" from_id="user:other"><![CDATA[帮我看一下]]></gugu_delivery>' },
      { kind: 'message', id: 'call:sent:a', seq: 1, role: 'assistant', text: '看好了', sentReplyTo: 'original' },
      { kind: 'message', id: 'call:sent:b', seq: 2, role: 'assistant', text: '再补一句', sentReplyTo: 'unknown' },
      { kind: 'message', id: 'answer', seq: 3, role: 'assistant', text: '总结' },
      { kind: 'message', id: 'group-in', seq: 4, role: 'user', text: '<gugu_delivery route="chat" chat="206258" chat_kind="group" source_link="gugu-chat://group-uuid/m1" msg="msg:in-group" from="小王" from_id="user:wang"><![CDATA[群里问一句]]></gugu_delivery>' },
      { kind: 'message', id: 'call:sent:c', seq: 5, role: 'assistant', text: '答你', sentReplyTo: 'in-group', sentChat: '206258' },
      { kind: 'message', id: 'call:sent:d', seq: 6, role: 'assistant', text: '接着上一条', sentReplyTo: 'c', sentChat: '206258' },
      { kind: 'message', id: 'call:sent:e', seq: 7, role: 'assistant', text: '私聊里说', sentChat: '999' },
      { kind: 'message', id: 'call:sent:f', seq: 8, role: 'assistant', text: '接私聊那条', sentReplyTo: 'e', sentChat: '999' },
    ] as ChatMessage[] as TranscriptTurn['items'] }];
    const [items] = conversationMessages(turns).map(turn => turn.items as ChatMessage[]);
    expect(items[1].conversationReply).toEqual({ itemId: 'incoming', text: '帮我看一下', from: '天天', fromId: 'user:other' });
    // 引用的那条不在这段记录里 ⇒ 不画,❌ 换成别的。
    expect(items[2].conversationReply).toBeUndefined();
    expect(items[3].conversationReply).toBeUndefined();
    // 群里那条:带上它所在的群(人读群名),发送者是那条自己的发送者。
    expect(items[5].conversationReply).toEqual({ itemId: 'group-in', text: '群里问一句', from: '小王', fromId: 'user:wang', chatId: 'group-uuid' });
    // agent 自己在群里发的那条被引用:按它发去的 chat_id 认出是这个群(真机验收 10-28 少了群名)。
    expect(items[6].conversationReply).toEqual({ itemId: 'call:sent:c', text: '答你', self: true, chatId: 'group-uuid' });
    // 发去的地方认不出是群 ⇒ 不写群名,❌ 猜。
    expect(items[8].conversationReply).toEqual({ itemId: 'call:sent:e', text: '私聊里说', self: true });
  });
});
