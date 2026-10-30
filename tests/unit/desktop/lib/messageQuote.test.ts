import { describe, expect, it } from 'vitest';
import { messageQuoteLink, messageQuoteText, parseMessageQuoteLink, readMessageQuote } from '@gugu/core/shared/ui/messageQuote';

describe('persisted message quote identity', () => {
  const source = { kind: 'session' as const, sessionId: 'Session-A', itemId: 'turn:2/item(1)?%=中' };
  it('round-trips opaque session/item identities and the exact selection through stored prompt text', () => {
    const excerpt = 'same words\n\n> nested [text]';
    const text = messageQuoteText(source, excerpt, 'Agent [A]\\B') + 'follow up';
    const saved = JSON.parse(JSON.stringify({ text })).text;
    expect(readMessageQuote(saved)).toEqual({ source, link: messageQuoteLink(source), sender: 'Agent [A]\\B', excerpt, body: 'follow up' });
  });
  it('retains a real IM source without inventing a timeline message ID', () => {
    const chat = { kind: 'chat' as const, chatId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', messageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
    expect(readMessageQuote(messageQuoteText(chat, 'selected', '人') + 'reply')?.source).toEqual(chat);
  });
  it('does not turn matching text, a hand-written blockquote, or a malformed source into a reply', () => {
    for (const text of ['> same words\n\nreply', '> [人](https://example.test/)\n> same words\n\nreply', '> [人](gugu-session://s?message=%ZZ)\n> words\n\nreply']) {
      expect(readMessageQuote(text)).toBeNull();
    }
    expect(parseMessageQuoteLink('gugu-session://s?message=item&session=other')).toBeNull();
  });
});
