// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@gugu/session-chat-ui';
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { selectedMessageText, sessionMessageQuoteSource } from './session-message-quote';

const message = (id: string, text = 'same words'): ChatMessage => ({ kind: 'message', id, text, seq: 0, role: 'assistant' });

describe('task quote sources and draft', () => {
  it('keeps different native items distinct even when their words match', () => {
    expect(sessionMessageQuoteSource(message('first'), 'session')).toEqual({ kind: 'session', sessionId: 'session', itemId: 'first' });
    expect(sessionMessageQuoteSource(message('second'), 'session')).toEqual({ kind: 'session', sessionId: 'session', itemId: 'second' });
  });
  it('keeps the real IM message source when the timeline row is only a projection', () => {
    const text = '<gugu_delivery route="chat" msg="msg:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" source_link="gugu-chat://aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"><![CDATA[words]]></gugu_delivery>';
    const item = { ...message('projected'), guguDelivery: readDeliveryEnvelope(text)! };
    expect(sessionMessageQuoteSource(item, 'native')).toEqual({ kind: 'chat', chatId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', messageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
  });
  it('does not persist an optimistic row identity that will be replaced when admitted', () => {
    expect(sessionMessageQuoteSource(message('optimistic:user:1'), 'session')).toBeNull();
  });
  it('reads a selection only from the same message and refuses selections crossing messages', () => {
    document.body.innerHTML = '<div id="a">same words</div><div id="b">same words</div>';
    const a = document.getElementById('a')!, b = document.getElementById('b')!;
    const range = document.createRange(), selection = document.getSelection()!;
    range.setStart(a.firstChild!, 0); range.setEnd(a.firstChild!, 4);
    selection.removeAllRanges(); selection.addRange(range);
    expect(selectedMessageText(a, selection)).toBe('same');
    expect(selectedMessageText(b, selection)).toBeUndefined();
    range.setEnd(b.firstChild!, 4); selection.removeAllRanges(); selection.addRange(range);
    expect(selectedMessageText(a, selection)).toBeNull();
    selection.removeAllRanges();
  });
});
