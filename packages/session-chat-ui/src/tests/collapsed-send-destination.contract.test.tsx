/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../model';
import { messageUnitDef } from '../components/rows/message/message.def';
import { cardFadeOverlay } from '../components/rows/message/user-message.css';
import { conversationBubbleKey } from '../components/rows/message/conversation-body';
import { makeContractCtx, renderAndMeasureUnit } from './contract';

afterEach(() => document.body.classList.remove('emdark'));

const longText = Array.from({ length: 24 }, (_, i) =>
  `Paragraph ${i + 1}: a long Agent response with enough readable words to fill the collapsed preview.`).join('\n\n');

describe.each([
  { width: 360, dark: false }, { width: 1280, dark: false },
  { width: 360, dark: true }, { width: 1280, dark: true },
])('outgoing destination at $width px (dark=$dark)', ({ width, dark }) => {
  it.each(['collapsed', 'expanded', 'short'] as const)('keeps the %s destination outside the fade with exact row geometry', async mode => {
    const item: ChatMessage = { kind: 'message', id: 'sent-message', seq: 0, role: 'assistant', at: 1000,
      text: mode === 'short' ? 'The requested check is complete.' : longText,
      conversationPart: 'body', conversationTail: true, sentTo: { kind: 'session', count: 1 } };
    const ctx = makeContractCtx({ width, isCollapsed: key => mode === 'expanded' && key === conversationBubbleKey(item) });
    ctx.theme = { ...ctx.theme, layout: { preset: 'double', userGutter: 0, agentConversation: true } };
    document.body.classList.toggle('emdark', dark);
    ctx.latestConversationMessageId = 'later-reply';
    const reading = await renderAndMeasureUnit(messageUnitDef, item, ctx, host => {
      const card = host.querySelector<HTMLElement>('[data-user-card]')!;
      const destination = card.querySelector<HTMLElement>('[data-slot="sent-to"]')!;
      const text = card.querySelector<HTMLElement>('[data-conversation-text]')!;
      const fade = card.querySelector<HTMLElement>(`.${cardFadeOverlay}`);
      const expand = host.querySelector<HTMLElement>('[data-expand-user-card]');
      const time = host.querySelector<HTMLElement>('time')!;
      const cardBox = card.getBoundingClientRect(), labelBox = destination.getBoundingClientRect();
      const textBox = text.getBoundingClientRect(), fadeBox = fade?.getBoundingClientRect();
      const labelText = document.createRange(); labelText.selectNodeContents(destination);
      const glyphBox = labelText.getBoundingClientRect();
      return {
        destinationHeight: labelBox.height,
        glyphOverflow: Math.max(0, glyphBox.top - labelBox.bottom, glyphBox.bottom - labelBox.bottom, labelBox.top - glyphBox.top),
        labelBelowCard: Math.max(0, labelBox.bottom - cardBox.bottom),
        fadeCount: fade ? 1 : 0,
        fadeOverlap: fadeBox ? Math.max(0, Math.min(fadeBox.bottom, labelBox.bottom) - Math.max(fadeBox.top, labelBox.top)) : 0,
        fadePastText: fadeBox ? Math.max(0, fadeBox.bottom - textBox.bottom) : 0,
        expandCount: expand ? 1 : 0,
        expandGap: expand ? expand.getBoundingClientRect().top - cardBox.bottom : 0,
        timeGap: time.getBoundingClientRect().top - (expand?.getBoundingClientRect().bottom ?? cardBox.bottom),
      };
    });
    expect(reading.dom, 'the measured row must equal its rendered height').toBe(reading.computed);
    expect(reading.inspected.destinationHeight).toBe(18);
    expect(reading.inspected.glyphOverflow).toBe(0);
    expect(reading.inspected.labelBelowCard).toBe(0);
    expect(reading.inspected.fadeCount).toBe(mode === 'collapsed' ? 1 : 0);
    expect(reading.inspected.fadeOverlap, 'the destination must not be painted under the preview fade').toBe(0);
    expect(reading.inspected.fadePastText, 'the fade belongs only to the clipped message text').toBe(0);
    expect(reading.inspected.expandCount).toBe(mode === 'collapsed' ? 1 : 0);
    expect(reading.inspected.expandGap).toBeGreaterThanOrEqual(0);
    expect(reading.inspected.timeGap).toBeGreaterThanOrEqual(0);
  });
});
