import { describe, expect, it } from 'vitest';
import { conversationMessages, resolveConversationMessageReference } from './conversation-messages';
import type { ChatMessage, TranscriptTurn } from '@session-chat/model';

describe('conversation reply references', () => {
  it('quotes an attached file by label while preserving the original input and exact anchor', () => {
    const text = '看下文件\n@[tri19-file.txt](/Users/host/task-attachments/c/tri19-file.txt)';
    const turns: TranscriptTurn[] = [{ id: 't', seq: 0, initiator: 'user', items: [
      { kind: 'message', id: 'input', seq: 0, role: 'user', text },
      { kind: 'message', id: 'answer', seq: 1, role: 'assistant', text: '收到', sentReplyTo: 'input' },
    ] as ChatMessage[] as TranscriptTurn['items'] }];
    const result = conversationMessages(turns)[0]!.items as ChatMessage[];
    expect(result[1]!.conversationReply).toMatchObject({ itemId: 'input', text: '看下文件\ntri19-file.txt' });
    expect(result[0]!.text).toBe(text);
    expect(turns[0]!.items[0]).toMatchObject({ id: 'input', text });
  });
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
      { kind: 'message', id: 'group-in', seq: 4, role: 'user', text: '<gugu_delivery route="chat" chat="206258" chat_kind="group" source_link="gugu-chat://b3fc1556-22fa-4bdf-aeb7-0ffdc51b4d8f/e9715174-2a62-47d9-bac1-9e3bad108bc9" msg="msg:in-group" from="小王" from_id="user:wang"><![CDATA[群里问一句]]></gugu_delivery>' },
      { kind: 'message', id: 'call:sent:c', seq: 5, role: 'assistant', text: '答你', sentReplyTo: 'in-group', sentChat: '206258' },
      { kind: 'message', id: 'call:sent:d', seq: 6, role: 'assistant', text: '接着上一条', sentReplyTo: 'c', sentChat: '206258' },
      { kind: 'message', id: 'call:sent:e', seq: 7, role: 'assistant', text: '私聊里说', sentChat: '999' },
      { kind: 'message', id: 'call:sent:f', seq: 8, role: 'assistant', text: '接私聊那条', sentReplyTo: 'e', sentChat: '999' },
    ] as ChatMessage[] as TranscriptTurn['items'] }];
    const [items] = conversationMessages(turns).map(turn => turn.items as ChatMessage[]);
    expect(items[1].conversationReply).toEqual({ itemId: 'incoming', text: '帮我看一下', from: '天天', fromId: 'user:other' });
    // Preserve its exact anchor so a click can load older history; never quote another input.
    expect(items[2].conversationReply).toEqual({ itemId: 'unknown', text: '', unloaded: true });
    expect(items[3].conversationReply).toBeUndefined();
    // 群里那条:带上它所在的群(人读群名),发送者是那条自己的发送者。
    expect(items[5].conversationReply).toEqual({ itemId: 'group-in', text: '群里问一句', from: '小王', fromId: 'user:wang', chatId: 'b3fc1556-22fa-4bdf-aeb7-0ffdc51b4d8f' });
    // agent 自己在群里发的那条被引用:按它发去的 chat_id 认出是这个群(真机验收 10-28 少了群名)。
    expect(items[6].conversationReply).toEqual({ itemId: 'call:sent:c', text: '答你', self: true, chatId: 'b3fc1556-22fa-4bdf-aeb7-0ffdc51b4d8f' });
    // 发去的地方认不出是群 ⇒ 不写群名,❌ 猜。
    expect(items[8].conversationReply).toEqual({ itemId: 'call:sent:e', text: '私聊里说', self: true });
  });
  it('resolves delivery and sent identities without matching repeated text', () => {
    const turns: TranscriptTurn[] = [{ id: 't', seq: 0, initiator: 'user', items: [
      { kind: 'message', id: 'local-first', seq: 0, role: 'user', text: 'same words' },
      { kind: 'message', id: 'local-delivery', seq: 1, role: 'user', text: '<gugu_delivery route="chat" msg="msg:remote" from="W" from_id="user:w"><![CDATA[same words]]></gugu_delivery>' },
      { kind: 'message', id: 'tool:sent:sent-id', seq: 2, role: 'assistant', text: 'same words' },
    ] }];
    expect(resolveConversationMessageReference(turns, 'msg:remote')).toBe('local-delivery');
    expect(resolveConversationMessageReference(turns, 'sent-id')).toBe('tool:sent:sent-id');
    expect(resolveConversationMessageReference(turns, 'local-first')).toBe('local-first');
    expect(resolveConversationMessageReference(turns, 'same words')).toBeNull();
  });
});
