import { describe, expect, it } from 'vitest';
import { conversationMessages } from './conversation-messages';
import type { ChatMessage, TranscriptTurn } from '../model';

describe('explicit conversation excerpts', () => {
  it.each(['user', 'assistant'] as const)('keeps the %s source identity while older history is unloaded and then loaded', role => {
    const reply = { kind: 'message', id: 'reply', seq: 1, role, text: 'Answer only', sentReplyTo: 'source',
      conversationReply: { itemId: 'source', text: 'Beta', from: 'Ada', excerpt: true } } satisfies ChatMessage;
    const turns: TranscriptTurn[] = [{ id: 'reply-turn', seq: 901, initiator: 'agent', items: [reply] }];
    const unloaded = conversationMessages(turns);
    expect((unloaded[0].items[0] as ChatMessage).conversationReply).toEqual({ ...reply.conversationReply, unloaded: true });
    const loaded = conversationMessages([{ id: 'source-turn', seq: 900, initiator: 'user', items: [
      { kind: 'message', id: 'acp-source', seq: 0, role: 'user', text: '<gugu_delivery route="chat" msg="msg:source" from="Ada" from_id="user:ada"><![CDATA[Alpha\n\nBeta\n\nGamma]]></gugu_delivery>' },
    ] }, ...unloaded]);
    expect((loaded[1].items[0] as ChatMessage).conversationReply).toEqual({ ...reply.conversationReply, itemId: 'acp-source', unloaded: false });
  });
  it.each(['user', 'assistant'] as const)('keeps the explicit %s excerpt when the full source is also in history', role => {
    const reply = { kind: 'message', id: 'reply', seq: 1, role, text: 'Answer only', sentReplyTo: 'source',
      conversationReply: { itemId: 'source', text: 'Beta', from: 'Ada', excerpt: true } } satisfies ChatMessage;
    const turns: TranscriptTurn[] = [
      { id: 't1', seq: 900, initiator: 'user', items: [{ kind: 'message', id: 'source', seq: 0, role: 'user', text: 'Alpha\n\nBeta\n\nGamma' }] },
      { id: 't2', seq: 901, initiator: 'agent', items: [reply] },
    ];
    const projected = conversationMessages(turns);
    const shown = projected[1].items[0] as ChatMessage;
    expect(shown.conversationReply).toEqual(reply.conversationReply);
    expect(shown.text).toBe('Answer only');
    expect(conversationMessages(projected)[1].items[0]).toEqual(shown);
    expect(turns[1].items[0]).toBe(reply);
  });
});
