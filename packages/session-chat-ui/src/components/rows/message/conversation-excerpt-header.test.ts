// @vitest-environment jsdom
import { createComponent } from 'solid-js';
import { render } from 'solid-js/web';
import { describe, expect, it } from 'vitest';
import { ConversationMessage } from './ConversationMessage';
import type { ChatMessage } from '../../../model';

describe('conversation excerpt header', () => {
  it('keeps the one excerpt with its own delivery segment in a batch', () => {
    const host = document.createElement('div'); document.body.append(host);
    const facts = { route: 'chat', from: 'Ada', fromId: 'user:me', chat: 'dm', chatKind: 'ai', whisperTo: null, viaApp: null, schedule: null,
      post: null, thread: null, at: null, listenMode: null, mode: null, then: null, inReplyTo: null, replyTo: null, threadContext: null, messageContext: null };
    const data: ChatMessage = { kind: 'message', id: 'batch', role: 'user', text: 'Answer only\n\nNext', conversationPart: 'head',
      guguDelivery: { body: 'Answer only\n\nNext', segments: [
        { facts: { ...facts, messageId: 'msg:first' }, body: 'Answer only' }, { facts: { ...facts, messageId: 'msg:next' }, body: 'Next' },
      ] }, conversationReplies: { first: { itemId: 'source', text: 'Beta', from: 'Agent', excerpt: true } } };
    const dispose = render(() => createComponent(ConversationMessage, {
      data, ctx: { viewState: { isCollapsed: () => false } },
      vars: { cardBorder: 0, collapsedMaxH: 200, expandedMaxH: 1000, userCardPadX: 16, userCardPadY: 12, attachThumb: 80, attachGap: 6, footerH: 16 },
    }), host);
    try {
      expect(host.querySelectorAll('[data-slot="conversation-quote"]')).toHaveLength(1);
      expect(host.querySelector('[data-agent-conversation-message="batch:batch-0"] [data-slot="conversation-quote"]')?.getAttribute('title')).toBe('Beta');
      expect(host.querySelector('[data-agent-conversation-message="batch:batch-1"] [data-slot="conversation-quote"]')).toBeNull();
    } finally { dispose(); host.remove(); }
  });
  it.each(['user', 'assistant'] as const)('shows one explicit Beta excerpt for the %s', role => {
    const host = document.createElement('div'); document.body.append(host);
    const data: ChatMessage = { kind: 'message', id: role, role, text: 'Answer only', conversationPart: 'head',
      conversationReply: { itemId: 'source', text: 'Beta', from: 'Ada', excerpt: true } };
    const dispose = render(() => createComponent(ConversationMessage, {
      data, ctx: { viewState: { isCollapsed: () => false } },
      vars: { cardBorder: 0, collapsedMaxH: 200, expandedMaxH: 1000, userCardPadX: 16, userCardPadY: 12, attachThumb: 80, attachGap: 6, footerH: 16 },
    }), host);
    try {
      const quotes = host.querySelectorAll('[data-slot="conversation-quote"]');
      expect(quotes).toHaveLength(1);
      expect(quotes[0]?.getAttribute('title')).toBe('Beta');
    } finally { dispose(); host.remove(); }
  });

  it.each(['user', 'assistant'] as const)('preserves ordinary full-reply header visibility for the %s', role => {
    const host = document.createElement('div'); document.body.append(host);
    const data: ChatMessage = { kind: 'message', id: role, role, text: 'Answer only', conversationPart: 'head',
      conversationReply: { itemId: 'source', text: 'Full source', from: 'Ada' } };
    const dispose = render(() => createComponent(ConversationMessage, {
      data, ctx: { viewState: { isCollapsed: () => false } },
      vars: { cardBorder: 0, collapsedMaxH: 200, expandedMaxH: 1000, userCardPadX: 16, userCardPadY: 12, attachThumb: 80, attachGap: 6, footerH: 16 },
    }), host);
    try { expect(host.querySelectorAll('[data-slot="conversation-quote"]')).toHaveLength(role === 'assistant' ? 1 : 0); }
    finally { dispose(); host.remove(); }
  });
});
