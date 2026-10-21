/** @jsxImportSource solid-js */
/**
 * Chromium contract: a transcript drawn inside another page (`embedded`) carries no page gutter and no page
 * padding. The phone draws its thinking rows and delivery cards with this same transcript (one row each); as a
 * page it put 16px on each side and 32px above and below every such row, which read as an extra indent and a
 * blank band around each thinking row (2026-10-02 phone, owner asked for it gone).
 *
 * The same row is mounted twice, embedded and as a page, so the page numbers are the positive control: they
 * prove the instrument sees the gutter and padding when they are there.
 */
import { describe, expect, it } from 'vitest';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import type { ChatThinking, TranscriptTurn } from '@session-chat/model';
import { createChatState } from '@session-chat/state/chat-state';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

const thought: ChatThinking = {
  kind: 'thinking',
  id: 'th-embed',
  seq: 0,
  status: 'done',
  text: 'Both commands ran. Now build the table.',
  startedAt: 1_000,
  durationMs: 2_000,
};
const turn = { id: 'embed-1', seq: 0, initiator: 'agent', items: [thought] } as unknown as TranscriptTurn;

async function mount(embedded: boolean) {
  const ctx = createChatContext();
  const state = createChatState(ctx, { uri: `embed:${embedded}` });
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:0;left:0;width:340px;';
  document.body.appendChild(host);
  const view = createChatView({ context: ctx, state, parent: host, stickToBottom: false, pinUserMessages: false, embedded });
  state.transcript.history.seed([turn]);
  await until('the thinking row mounts', () => host.querySelector('[data-row-kind="thinking"]') !== null);
  const canvas = host.querySelector<HTMLElement>('[data-chat-canvas]')!;
  await untilStable('the canvas settles', () => canvas.getBoundingClientRect().height);
  const row = host.querySelector<HTMLElement>('[data-row-kind="thinking"]');
  const scroll = host.querySelector<HTMLElement>('[data-chat-scroll]')!;
  const reading = {
    blank: Math.round(canvas.getBoundingClientRect().height - row!.getBoundingClientRect().height),
    gutter: getComputedStyle(scroll).paddingLeft,
    rowLeft: Math.round(row!.getBoundingClientRect().left - host.getBoundingClientRect().left),
  };
  view.dispose();
  host.remove();
  return reading;
}

describe('embedded transcript', () => {
  it('draws its rows with no page gutter and no page padding; the same row as a page has both', async () => {
    const page = await mount(false);
    const embedded = await mount(true);
    // Positive control: as a page, 32 above + 32 below and a 16px gutter.
    expect(page.blank, 'page padding not seen — the instrument proves nothing').toBe(64);
    expect(page.gutter).toBe('16px');
    expect(embedded.blank, 'blank band around an embedded row').toBe(0);
    expect(embedded.gutter).toBe('0px');
    expect(embedded.rowLeft, 'embedded row sits further in than the page row minus its gutter').toBe(page.rowLeft - 16);
  });
});
