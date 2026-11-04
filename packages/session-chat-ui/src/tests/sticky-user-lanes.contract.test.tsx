/** @jsxImportSource solid-js */
/**
 * @@@sticky-user-lanes (ChatRoot) — a user message sticks to the top while its turn is on screen,
 * and the browser does the sticking.
 *
 * The failure this guards against was a frame lag: the stuck copy used to be placed from the
 * scroll event in rAF, while the compositor had already scrolled. Reading geometry right after a
 * scrollTop write, before any rAF, is that same frame: the stuck row must already be in place.
 */

import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { UNIT_REGISTRY } from '@session-chat/components/engine/unit-registry';
import { DEFAULT_THEME } from '@session-chat/core/theme';
import { DEFAULT_CONFIG, buildChatTheme } from '@session-chat/core/config';
import type { ChatItem, TranscriptTurn } from '@session-chat/model';
import { createChatState } from '@session-chat/state/chat-state';
import { afterEach, describe, expect, it } from 'vitest';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

/** Where a stuck card's top sits, below the scroller's top edge. */
const PIN_LINE = UNIT_REGISTRY.message!.margin!.top!;

const teardown: Array<() => void> = [];
afterEach(() => {
  while (teardown.length) teardown.pop()?.();
});

/** A user message and enough replies that its row leaves the virtualizer's overscan while they fill the screen. */
function exchange(id: string, seq: number, replies: number): ChatItem[] {
  const items: ChatItem[] = [{ kind: 'message', id: `${id}-user`, seq, role: 'user', text: `question ${id}` }];
  for (let i = 0; i < replies; i++) {
    items.push({ kind: 'message', id: `${id}-r${i}`, seq: seq + i + 1, role: 'assistant', text: `${id} reply ${i}. Lorem ipsum dolor sit amet.` });
  }
  return items;
}

/** A turn of one or more exchanges; several = messages inserted into the turn while it ran. */
function longTurn(id: string, seq: number, replies: number, inserted: string[] = []): TranscriptTurn {
  const items = [id, ...inserted].flatMap((x, k) => exchange(x, k * (replies + 1), replies));
  return { id, seq, initiator: 'user', items: items as TranscriptTurn['items'] };
}

async function mount(
  committed: TranscriptTurn[] = [longTurn('a', 0, 150), longTurn('b', 1, 150)],
  active?: TranscriptTurn,
  theme = DEFAULT_THEME
) {
  const context = createChatContext({ locale: () => 'en-US', theme });
  const state = createChatState(context);
  state.transcript.history.seed(committed);
  if (active) state.transcript.activeTurn.set(active, 'generating');
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:320px;';
  document.body.appendChild(host);
  const view = createChatView({ context, state, parent: host, stickToBottom: false, pinUserMessages: true });
  teardown.push(() => {
    view.dispose();
    state.dispose();
    context.dispose();
    host.remove();
  });
  const scrollEl = host.querySelector<HTMLElement>('[data-chat-scroll]')!;
  const edge = () => scrollEl.getBoundingClientRect().top;
  const card = (id: string) => host.querySelector<HTMLElement>(`[data-user-card="${id}"]`);
  /** The card's top below the scroller's top edge; null = not in the DOM. */
  const cardTop = (id: string) => {
    const el = card(id);
    return el ? el.getBoundingClientRect().top - edge() : null;
  };
  const mounted = (id: string) => host.querySelector(`[data-row-kind="message"][data-item-id="${id}"]`) != null;
  const scrollTo = async (st: number) => {
    scrollEl.scrollTop = st;
    await untilStable('transcript geometry settles', () => [scrollEl.scrollHeight, scrollEl.scrollTop]);
  };
  await until('transcript mounted', () => card('a-user') != null);
  await scrollTo(0);
  return { host, scrollEl, card, cardTop, mounted, scrollTo };
}

describe('sticky user lanes', () => {
  it('paints the full-width user backdrop only while the lane is stuck', async () => {
    const t = await mount();
    const wrapper = t.card('a-user')!.closest('[data-index]')!.firstElementChild!;
    expect(getComputedStyle(wrapper).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    const backdrop = () => wrapper.querySelector<HTMLElement>('[data-chat-pin-backdrop]');
    expect(backdrop()).not.toBeNull();
    expect(getComputedStyle(backdrop()!).opacity).toBe('0');
    await t.scrollTo(900);
    await until('the stuck card is backed by the opaque lane', () => getComputedStyle(backdrop()!).opacity === '1');
    expect(t.cardTop('a-user')).toBeCloseTo(PIN_LINE, 0);
  });
  it('sticks the user row in the same frame as the scroll, deep inside a long turn', async () => {
    const t = await mount();
    for (const st of [200, 900, 1700, 2600]) {
      t.scrollEl.scrollTop = st;
      // Same frame: no rAF has run since the write.
      expect(t.scrollEl.scrollTop, 'the driver moved the scroller').toBe(st);
      expect(t.cardTop('a-user'), `stuck at scrollTop=${st}`).toBeCloseTo(PIN_LINE, 0);
    }
  });

  it('keeps the stuck row mounted after the virtualizer recycles its neighbours', async () => {
    const t = await mount();
    await t.scrollTo(2600);
    // Precondition: the turn's first replies are recycled, so the user row is far outside the range.
    expect(t.mounted('a-r0'), 'the first reply of the turn was recycled').toBe(false);
    expect(t.mounted('a-r149'), 'still inside turn a').toBe(false);
    expect(t.cardTop('a-user')).toBeCloseTo(PIN_LINE, 0);
    expect(t.host.querySelectorAll('[data-user-card="a-user"]')).toHaveLength(1);
  });

  it('is pushed off by the next user message, which then sticks inside its own turn', async () => {
    const t = await mount();
    // Walk down until b's row is on screen below the stuck a.
    let st = 2600;
    while (!(t.cardTop('b-user') !== null && t.cardTop('b-user')! < 250 && t.cardTop('b-user')! > 120)) {
      st += 100;
      expect(st, 'b-user came into view').toBeLessThan(20_000);
      await t.scrollTo(st);
    }
    // Through the handoff, frame by frame: a is stuck or pushed up by b, the two never overlap.
    for (let i = 0; i < 40; i++) {
      t.scrollEl.scrollTop = st + i * 6;
      const a = t.card('a-user');
      const b = t.card('b-user')!;
      if (a) expect(a.getBoundingClientRect().bottom, `step ${i}`).toBeLessThanOrEqual(b.getBoundingClientRect().top + 1);
    }
    await t.scrollTo(st + 1500);
    expect(t.cardTop('b-user'), 'b is the stuck one inside its own turn').toBeCloseTo(PIN_LINE, 0);
    const aTop = t.cardTop('a-user');
    expect(aTop === null || aTop < 0, 'a left with its turn').toBe(true);
  });

  it('a long delivered insertion in the same turn scrolls clear of the preceding pinned bubble', async () => {
    const first = longTurn('a', 0, 1);
    const text = '输入框遮挡 · 过程行展开 · 原消息引用回跳。请保留真实截图。\n\n'.repeat(30);
    first.items.splice(1, 0, {
      kind: 'message', id: 'inserted', seq: 1, role: 'user',
      text: `<gugu_delivery route="chat" msg="msg:inserted" from="Reviewer" from_id="user:reviewer" chat="project" chat_kind="group"><![CDATA[${text}]]></gugu_delivery>`,
    } as TranscriptTurn['items'][number]);
    const theme = buildChatTheme(DEFAULT_CONFIG, { preset: 'double', userGutter: 72, agentConversation: true });
    const t = await mount([first, longTurn('b', 1, 150)], undefined, theme);
    await until('inserted bubble is rendered', () => t.card('inserted') != null);
    const insertedTop = t.cardTop('inserted')!;
    expect(t.card('inserted')!.getBoundingClientRect().height).toBeGreaterThan(200);
    for (let step = 0; step < 45; step++) {
      t.scrollEl.scrollTop = Math.max(0, insertedTop - 100 + step * 6);
      const previous = t.card('a-user');
      const inserted = t.card('inserted');
      if (previous && inserted) expect(previous.getBoundingClientRect().bottom, `handoff step ${step}`).toBeLessThanOrEqual(inserted.getBoundingClientRect().top + 1);
    }
  });

  it('gives every user message of the running turn its own lane, not only the last one', async () => {
    // The running turn holds b and the message c inserted into it; before the fix only c was an
    // anchor, so a stayed stuck over all of b.
    const t = await mount([longTurn('a', 0, 150)], longTurn('b', 1, 150, ['c']));
    const stuckAfter = async (id: string) => {
      let st = t.scrollEl.scrollTop;
      while (!(t.cardTop(id) !== null && t.cardTop(id)! < 250 && t.cardTop(id)! > 120)) {
        st += 100;
        expect(st, `${id} came into view`).toBeLessThan(40_000);
        await t.scrollTo(st);
      }
      await t.scrollTo(st + 1500);
    };
    await stuckAfter('b-user');
    expect(t.cardTop('b-user'), 'b is stuck inside its part of the running turn').toBeCloseTo(PIN_LINE, 0);
    const aTop = t.cardTop('a-user');
    expect(aTop === null || aTop < 0, 'a left with its turn').toBe(true);
    await stuckAfter('c-user');
    expect(t.cardTop('c-user'), 'the inserted c takes over').toBeCloseTo(PIN_LINE, 0);
  });
  it('in the agent conversation, a delivered bubble ends the lane before it instead of sliding under its stuck copy', async () => {
    const delivered = longTurn('b', 1, 150);
    delivered.items[0] = { kind: 'message', id: 'b-user', seq: 0, role: 'user',
      text: '<gugu_delivery route="chat" msg="msg:b" from="小王" from_id="user:wang"><![CDATA[来自群里的一条消息]]></gugu_delivery>' } as TranscriptTurn['items'][number];
    const theme = buildChatTheme(DEFAULT_CONFIG, { preset: 'double', userGutter: 72, agentConversation: true });
    const t = await mount([longTurn('a', 0, 150), delivered], undefined, theme);
    // 投进来的那条不是钉顶单元,在对话布局里画成右侧一个气泡:按它那一行找。
    const deliveredRow = () => t.host.querySelector<HTMLElement>('[data-row-kind="message"][data-item-id="b-user"]');
    const rowTop = () => { const el = deliveredRow(); return el ? el.getBoundingClientRect().top - t.scrollEl.getBoundingClientRect().top : null; };
    let st = 0;
    while (!(rowTop() !== null && rowTop()! < 260 && rowTop()! > 80)) {
      st += 80;
      expect(st, 'b-user came into view').toBeLessThan(80_000);
      await t.scrollTo(st);
    }
    // MBP 验收 10-28:前一条打字消息的钉顶副本一直盖着投进来的那条。
    for (let i = 0; i < 40; i++) {
      t.scrollEl.scrollTop = st + i * 6;
      const a = t.card('a-user');
      const b = deliveredRow()!;
      if (a) expect(a.getBoundingClientRect().bottom, `step ${i}`).toBeLessThanOrEqual(b.getBoundingClientRect().top + 1);
    }
  });
});
