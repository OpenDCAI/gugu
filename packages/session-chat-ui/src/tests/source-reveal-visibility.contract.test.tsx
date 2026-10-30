/** @jsxImportSource solid-js */
import { describe, expect, it } from 'vitest';
import { createChatContext } from '../chat-context';
import { createChatView } from '../chat-view';
import { buildChatTheme, DEFAULT_CONFIG } from '../core/theme';
import type { TranscriptTurn } from '../model';
import { createChatState } from '../state/chat-state';
import { pinFade, pinSticky } from '../chat-root.css';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

describe('source message visibility below the pinned question', () => {
  it.each([
    { count: 15, preamble: false }, { count: 35, preamble: false },
    { count: 15, preamble: true }, { count: 35, preamble: true },
  ])('keeps the first line readable with $count paragraphs and preamble=$preamble', async ({ count, preamble }) => {
    const context = createChatContext({ theme: buildChatTheme(DEFAULT_CONFIG, { preset: 'double', userGutter: 72 }) });
    const state = createChatState(context);
    const source = 'SOURCE913-MARKER\n\n' + Array.from({ length: count }, (_, i) => `Paragraph ${i}: the original message must remain readable.`).join('\n\n');
    const turns: TranscriptTurn[] = [...Array.from({ length: 3 }, (_, i): TranscriptTurn => ({ id: `earlier-${i}`, seq: i, initiator: 'user', items: [
      { kind: 'message', id: `earlier-q-${i}`, seq: 0, role: 'user', text: 'An earlier question.' },
      { kind: 'message', id: `earlier-a-${i}`, seq: 1, role: 'assistant', text: 'An earlier answer. '.repeat(40) },
    ] })), { id: 't0', seq: 3, initiator: 'user', items: [
      { kind: 'message', id: 'question', seq: 0, role: 'user', text: 'Keep this question pinned while reading the original answer. '.repeat(4) },
      ...preamble ? [{ kind: 'message' as const, id: 'preamble', seq: 1, role: 'assistant' as const, text: 'Earlier content in the same turn.\n\n'.repeat(12) }] : [],
      { kind: 'message', id: 'source', seq: 2, role: 'assistant', text: source },
    ] }, ...Array.from({ length: 6 }, (_, i): TranscriptTurn => ({ id: `tail-${i}`, seq: i + 4, initiator: 'user', items: [
      { kind: 'message', id: `q-${i}`, seq: 0, role: 'user', text: `Follow-up ${i}` },
      { kind: 'message', id: `a-${i}`, seq: 1, role: 'assistant', text: 'A later answer that is not the quoted source.' },
    ] }))];
    state.transcript.history.seed(turns);
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
    document.body.append(host);
    const view = createChatView({ context, state, parent: host, pinUserMessages: true, stickToBottom: false });
    try {
      await until('the real transcript mounts', () => !!host.querySelector('[data-chat-scroll]'));
      const scroll = host.querySelector<HTMLElement>('[data-chat-scroll]')!;
      await untilStable('source geometry settles', () => [scroll.scrollHeight, scroll.clientHeight, scroll.scrollTop]);
      view.scrollToItem('source', { align: 'center' });
      await until('the exact source is mounted', () => !!host.querySelector('[data-item-id="source"]'));
      await untilStable('source jump settles', () => [scroll.scrollTop, host.querySelector('[data-item-id="source"]')!.getBoundingClientRect().top]);
      const row = host.querySelector<HTMLElement>('[data-item-id="source"]')!;
      const question = host.querySelector<HTMLElement>('[data-item-id="question"]')!;
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      let marker: Node | null = null;
      while (walker.nextNode()) if (walker.currentNode.textContent?.startsWith('SOURCE913-MARKER')) { marker = walker.currentNode; break; }
      expect(marker).not.toBeNull();
      const range = document.createRange(); range.setStart(marker!, 0); range.setEnd(marker!, 'SOURCE913-MARKER'.length);
      const firstLine = range.getBoundingClientRect();
      const fadeSelector = pinFade.split(/\s+/).map(name => `.${name}`).join('');
      const fade = question.closest(`.${pinSticky}`)!.querySelector<HTMLElement>(`:scope > ${fadeSelector}`)!;
      expect(fade).not.toBeNull();
      // The fade paints only while the question is stuck. Cover both its
      // painted and transparent states using the real scroll-state style.
      const fadeStyle = getComputedStyle(fade);
      const readableTop = question.getBoundingClientRect().bottom
        + (Number(fadeStyle.opacity) > 0 ? parseFloat(fadeStyle.height) : 0);
      expect(scroll.scrollTop).toBeGreaterThan(0);
      expect(firstLine.top).toBeGreaterThanOrEqual(readableTop - 1);
      expect(firstLine.bottom).toBeLessThanOrEqual(scroll.getBoundingClientRect().bottom);
      expect(Number(fadeStyle.opacity)).toBe(preamble ? 1 : 0);
    } finally { view.dispose(); host.remove(); }
  });
});
