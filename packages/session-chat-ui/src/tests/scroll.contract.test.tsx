/** @jsxImportSource solid-js */
/**
 * Browser contract tests for transcript scroll behaviour.
 *
 * These exist because #3334 P3 rewrites row geometry one row at a time: every
 * redraw changes measured heights, and the failure mode of a height change is
 * not a wrong-looking row, it is a transcript that stops following the stream
 * or yanks a reader who scrolled up back to the bottom.
 *
 * Driver note: a synthetic `mouse.wheel` does NOT move this container — a
 * previous lane read scrollTop=382 both before and after dispatching one and
 * nearly reported a product failure. Every test here therefore drives the real
 * scroller and asserts the scroll actually happened BEFORE asserting anything
 * about the product, so a dead driver can never masquerade as a passing (or
 * failing) product reading.
 */

import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { STICK_THRESHOLD_PX } from '@session-chat/core/stick-to-bottom';
import { DEFAULT_THEME } from '@session-chat/core/theme';
import { generateMockTranscript } from '@session-chat/mock-transcript';
import type { TranscriptTurn } from '@session-chat/model';
import { createChatState, pinTopMode } from '@session-chat/state/chat-state';
import { afterEach, describe, expect, it } from 'vitest';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

/** One full generateMockTranscript cycle — includes a plan and a resource-link row. */
const CYCLE = 16;

/**
 * generateMockTranscript restarts its id counter every call, so appending a
 * second batch verbatim collides with the seeded ids. The engine warns that
 * duplicate ids corrupt the heightmap and the scroll anchor — i.e. exactly the
 * machinery under test — so appended batches are re-keyed into their own
 * namespace instead of being fed in raw.
 */
function rekey(turns: readonly TranscriptTurn[], batch: number): TranscriptTurn[] {
  return turns.map((turn, index) => ({
    ...turn,
    id: `append${batch}-turn-${index}`,
    seq: 10_000 * batch + index,
    items: turn.items.map((item) => ({ ...item, id: `append${batch}-${item.id}` }))
  })) as TranscriptTurn[];
}

/**
 * 视图落定(#6346):等「几何不再动」这个事实,不数固定帧数。一次操作之后转录要经过**帧数不定**的收敛 ——
 * 行量高、composer 槽与视口尺寸经 ResizeObserver 晚一步到达(见下面 tail intent 那组的说明)。
 * 从前固定 12 帧:负载下不够,「滚上去 900px」之前读到的底部还在长(#6346 的读数)。字体不是这里的变量 ——
 * contract-setup 在所有用例之前就把字体加载完了。
 */
async function settled(scrollEl: HTMLElement): Promise<void> {
  await untilStable('transcript scroll geometry settles', () => [
    scrollEl.scrollHeight,
    scrollEl.clientHeight,
    scrollEl.scrollTop
  ]);
}

const distanceToBottom = (el: HTMLElement): number =>
  el.scrollHeight - el.clientHeight - el.scrollTop;

/**
 * 读者此刻看着的那一行:跨过视口上沿的那一行,以及它的上沿离视口上沿多远(#6346)。
 * 这是用户看得见的事实 —— 产品的行锚也锚同一行(readPhase 取视口上沿所在的那个 unit)。
 * ❌ 用绝对 scrollTop 判「读者被拉走了没有」:视口**之上**的行晚一步量出真实高度时,行锚投影会把
 * scrollTop 同步挪开以保持读者这一行不动 —— scrollTop 变了,读者看到的一点没变(负载下实测 2/18 的误红就是它)。
 */
function readerRow(scrollEl: HTMLElement): { itemId: string; offset: number } | null {
  const viewTop = scrollEl.getBoundingClientRect().top;
  for (const row of scrollEl.querySelectorAll<HTMLElement>('[data-item-id]')) {
    const box = row.getBoundingClientRect();
    if (box.top <= viewTop && box.bottom > viewTop) return { itemId: row.dataset.itemId!, offset: box.top - viewTop };
  }
  return null;
}

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

function rowOffset(scrollEl: HTMLElement, itemId: string): number | null {
  const row = scrollEl.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(itemId)}"]`);
  return row ? row.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top : null;
}

type Mounted = {
  host: HTMLElement;
  scrollEl: HTMLElement;
  ctx: ReturnType<typeof createChatContext>;
  state: ReturnType<typeof createChatState>;
  view: ReturnType<typeof createChatView>;
  appendCycle: () => void;
  /** What the session page does when the chat panel unmounts and comes back: a new view on the same conversation. */
  remount: () => Promise<HTMLElement>;
  dispose: () => void;
};

const mounted: Mounted[] = [];

async function mountTranscript(
  itemCount: number,
  opts: {
    composer?: 'slot' | 'none'; height?: number; turns?: TranscriptTurn[];
    pinUserMessages?: boolean; unreadId?: string; top?: number; agentConversation?: boolean;
  } = {}
): Promise<Mounted> {
  const ctx = createChatContext(opts.agentConversation ? { layout: { preset: 'double', userGutter: 0, agentConversation: true } } : { theme: DEFAULT_THEME });
  const state = createChatState(ctx);
  state.transcript.history.seed(opts.turns ?? generateMockTranscript(itemCount, 7));

  const host = document.createElement('div');
  host.dataset.scrollContractHost = '';
  host.style.cssText = `position:fixed;top:${opts.top ?? 0}px;left:0;width:800px;height:${opts.height ?? 400}px;`;
  document.body.appendChild(host);

  const mountView = async () => {
    const view = createChatView({
      context: ctx, state, parent: host, composer: opts.composer, pinUserMessages: opts.pinUserMessages,
      onViewMounted: ready => {
        if (!opts.unreadId) return;
        ready.setScrollMode({ kind: 'anchor', itemId: opts.unreadId, edge: 'top', offset: -8 });
        ready.composerSlot!.style.height = '140px';
      },
    });
    await until('transcript scroll container mounts', () => host.querySelector('[data-chat-scroll]') != null);
    const scrollEl = host.querySelector('[data-chat-scroll]') as HTMLElement;
    await settled(scrollEl);
    return { view, scrollEl };
  };
  const first = await mountView();

  let appended = 0;
  const instance: Mounted = {
    host,
    scrollEl: first.scrollEl,
    ctx,
    state,
    view: first.view,
    appendCycle: () => {
      appended += 1;
      state.transcript.history.append(
        rekey(generateMockTranscript(CYCLE, 100 + appended), appended)
      );
    },
    remount: async () => {
      instance.view.dispose();
      const next = await mountView();
      instance.view = next.view;
      instance.scrollEl = next.scrollEl;
      return next.scrollEl;
    },
    dispose: () => {
      instance.view.dispose();
      ctx.dispose();
      state.dispose();
      host.remove();
    }
  };
  mounted.push(instance);
  return instance;
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.dispose();
  document.querySelectorAll('[data-scroll-contract-host]').forEach((el) => el.remove());
});

describe('transcript scroll behaviour across the P3 row redraw', () => {
  it('places an unread sent bubble below the viewport top, with its receipt and floating composer', async () => {
    const receipt = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const turns: TranscriptTurn[] = Array.from({ length: 30 }, (_, index) => ({
      id: `turn-${index}`, seq: index, initiator: 'agent', outcome: { kind: 'done' }, items: [{
        kind: 'mcp-tool-call', id: `call-${index}`, toolCallId: `call-${index}`, seq: 0,
        title: 'Send', server: 'plugin_gugu-product_gugu', tool: 'message_send', status: 'done',
        rawInput: JSON.stringify({ chat_id: '216189', text: `Unread ${index}` }),
        outputText: `sent (id=msg:${receipt(index)})`,
      }],
    }));
    const id = `call-12:sent:${receipt(12)}`;
    const { view, host, scrollEl } = await mountTranscript(0, { composer: 'slot', height: 600, turns, pinUserMessages: true, unreadId: id, top: 45, agentConversation: true });
    const body = () => host.querySelector<HTMLElement>(`[data-agent-conversation-message="${id}"] [data-user-card]`);
    await until('unread body is mounted', () => body() !== null);
    await settled(scrollEl);
    const bounds = body()!.getBoundingClientRect();
    expect(scrollEl.getBoundingClientRect().top).toBe(45);
    expect(bounds.top).toBeGreaterThanOrEqual(scrollEl.getBoundingClientRect().top);
    expect(bounds.bottom).toBeLessThanOrEqual(view.composerSlot!.getBoundingClientRect().top);
  });

  it('is scrollable at all — liveness control for the driver', async () => {
    const { scrollEl, view } = await mountTranscript(120);

    view.scrollToBottom();
    await settled(scrollEl);
    const atBottom = scrollEl.scrollTop;
    expect(atBottom, 'seeded transcript produced no scrollable overflow').toBeGreaterThan(0);

    scrollEl.scrollTop = 0;
    await settled(scrollEl);
    expect(scrollEl.scrollTop, 'writing scrollTop did not move the container').toBe(0);
  });

  it('keeps following new turns while stuck to the bottom', async () => {
    const { scrollEl, view, appendCycle } = await mountTranscript(120);

    view.scrollToBottom();
    await settled(scrollEl);
    expect(distanceToBottom(scrollEl)).toBeLessThanOrEqual(STICK_THRESHOLD_PX);

    const heightBefore = scrollEl.scrollHeight;
    appendCycle();
    await settled(scrollEl);

    // Pre-assertion: the append has to reach layout, otherwise "still at the
    // bottom" is true for the uninteresting reason that nothing was added.
    expect(
      scrollEl.scrollHeight,
      'appended turns did not change the scroll height, so this asserts nothing'
    ).toBeGreaterThan(heightBefore);

    expect(
      distanceToBottom(scrollEl),
      `stuck transcript fell ${distanceToBottom(scrollEl)}px behind the bottom after new turns`
    ).toBeLessThanOrEqual(STICK_THRESHOLD_PX);
  });

  it('does not yank a reader who scrolled up back to the bottom', async () => {
    const { scrollEl, view, appendCycle } = await mountTranscript(120);

    view.scrollToBottom();
    await settled(scrollEl);
    const bottomTop = scrollEl.scrollTop;

    scrollEl.scrollTop = Math.max(0, bottomTop - 900);
    // Pre-assertion 1: the driver moved the container — read synchronously, before any frame can react.
    expect(
      scrollEl.scrollTop,
      `scroll driver did not move the container (stayed at ${bottomTop}px)`
    ).toBeLessThan(bottomTop - 100);

    // 读者滚上去之后看着哪一行、那一行离视口上沿多远 —— 之后判的就是这个事实。
    await until('the row under the scrolled-up viewport is rendered', () => readerRow(scrollEl) !== null);
    const seen = readerRow(scrollEl)!;
    // 读者那一行在**任意一帧**都不动(±1px)。视口之上、渲染窗口之外的行可能晚一步量出真实高度;
    // 产品在同一帧里等量补偿 scrollTop(#6401),所以读者看不到任何位移 —— 不再等「几何 5 帧不变」再看终态。
    let worst = { frame: -1, deviation: 0 };
    for (let frame = 0; frame < 30; frame++) {
      await nextFrame();
      const offset = rowOffset(scrollEl, seen.itemId);
      const deviation = offset === null ? Infinity : Math.abs(offset - seen.offset);
      if (deviation > worst.deviation) worst = { frame, deviation };
    }
    expect(
      worst.deviation,
      `the reader's row ${seen.itemId} moved ${worst.deviation}px on frame ${worst.frame} after scrolling up`
    ).toBeLessThanOrEqual(1);
    await settled(scrollEl);

    // Pre-assertion 2: the reader stays where they scrolled to. Rows above may still be measured
    // late and move the absolute scrollTop; the row the reader is looking at must not move.
    expect(
      rowOffset(scrollEl, seen.itemId),
      `the reader's row ${seen.itemId} moved after scrolling up (was ${seen.offset}px from the viewport top)`
    ).toBeCloseTo(seen.offset, 0);
    // …and we actually left the stick zone, so the final assertion is about the product and not
    // about being trivially inside it already.
    expect(
      distanceToBottom(scrollEl),
      'scrolling up did not leave the stick-to-bottom zone (the reader was pulled back to the bottom)'
    ).toBeGreaterThan(STICK_THRESHOLD_PX);

    appendCycle();
    await settled(scrollEl);

    expect(
      distanceToBottom(scrollEl),
      'new turns pulled a scrolled-up reader back into the stick zone'
    ).toBeGreaterThan(STICK_THRESHOLD_PX);
  });

  // #6401:视口之上的行长高,读者看着的那一行**任意一帧**都不动(±1px)—— 包括手指还在拖(落定窗口开着)的时候。
  it('keeps the reader\'s row still on every frame while a row above grows mid-drag', async () => {
    const { scrollEl, view, state } = await mountTranscript(120);
    const reader = 'msg-99';
    const grower = 'think-97'; // 两行之上、收着的 thinking 行:读者停在 msg-99 时它在视口之上的预渲染区里
    view.scrollToBottom();
    await settled(scrollEl);
    view.scrollToItem(reader);
    await settled(scrollEl);
    const start = rowOffset(scrollEl, reader);
    const growerRow = scrollEl.querySelector<HTMLElement>(`[data-item-id="${grower}"]`);
    expect(start, `${reader} is not rendered at the viewport top`).not.toBeNull();
    expect(growerRow, `${grower} is not rendered above the viewport — this asserts nothing`).not.toBeNull();
    expect(growerRow!.getBoundingClientRect().bottom, `${grower} is not above the viewport`).toBeLessThanOrEqual(
      scrollEl.getBoundingClientRect().top + 1
    );
    expect(state.viewState.isCollapsed(grower), `${grower} is already expanded`).toBe(false);
    const heightBefore = scrollEl.scrollHeight;

    // 展开上方那一行,同时每帧往上拖 1px(手指还在拖 ⇒ 产品的落定窗口一直开着)。
    // 读者那一行的预期位置 = 起点 + 用户自己拖动的距离;任何一帧偏出 ±1px 都是产品挪了读者。
    // ±1px 只容一次取整:浏览器把 scrollTop 存到像素栅格上,小数的补偿量每次最多差半格;这点残差不许逐帧累加
    // (累加就是泄漏 —— 曾经 6 帧累计出 2px,CI 红过),所以不放宽。
    state.viewState.setCollapsed(grower, true);
    let dragged = 0;
    let worst = { frame: -1, deviation: 0 };
    for (let frame = 0; frame < 60; frame++) {
      await nextFrame();
      const offset = rowOffset(scrollEl, reader);
      const deviation = offset === null ? Infinity : Math.abs(offset - (start! + dragged));
      if (deviation > worst.deviation) worst = { frame, deviation };
      if (frame < 30) {
        scrollEl.scrollTop -= 1;
        dragged += 1;
      }
    }

    expect(scrollEl.scrollHeight, `${grower} above the viewport never grew — the trigger did not fire`).toBeGreaterThan(
      heightBefore
    );
    expect(
      worst.deviation,
      `the reader's row ${reader} moved ${worst.deviation}px on frame ${worst.frame} while ${grower} above it grew`
    ).toBeLessThanOrEqual(1);
  });

  // #6401:平滑滚动的目标是文档坐标 —— 途中上方的行长高,落点要随之平移,落定后那一行在每一帧都在位。
  it('lands a smooth scroll on its row even when a row above grows mid-flight', async () => {
    const { scrollEl, view, state } = await mountTranscript(120);
    view.scrollToBottom();
    await settled(scrollEl);
    const target = 'msg-99';
    const grower = 'think-97';
    const heightBefore = scrollEl.scrollHeight;

    view.scrollToItem(target, { behavior: 'smooth' });
    await nextFrame();
    state.viewState.setCollapsed(grower, true);

    // 「落定」= 动过之后连续 3 帧 scrollTop 不变(动画开始前、以及动画途中都会有单帧不动)。
    let last = scrollEl.scrollTop;
    let moved = false;
    let still = 0;
    let landedFrame = -1;
    let heightAtLanding = heightBefore;
    let worst = { frame: -1, deviation: 0 };
    for (let frame = 0; frame < 120; frame++) {
      await nextFrame();
      const top = scrollEl.scrollTop;
      if (top !== last) {
        moved = true;
        still = 0;
      } else if (moved) {
        still += 1;
      }
      last = top;
      if (landedFrame < 0 && still >= 3) {
        landedFrame = frame;
        heightAtLanding = scrollEl.scrollHeight;
      }
      if (landedFrame >= 0) {
        const offset = rowOffset(scrollEl, target);
        const deviation = offset === null ? Infinity : Math.abs(offset);
        if (deviation > worst.deviation) worst = { frame, deviation };
      }
    }

    expect(moved, 'the smooth scroll never moved the container — this asserts nothing').toBe(true);
    expect(landedFrame, 'the smooth scroll never came to rest within 120 frames').toBeGreaterThanOrEqual(0);
    expect(
      heightAtLanding,
      `the row ${grower} above the target had not grown by the time the scroll landed — the trigger did not fire in flight`
    ).toBeGreaterThan(heightBefore);
    expect(
      worst.deviation,
      `after landing, ${target} was ${worst.deviation}px off the viewport top on frame ${worst.frame}`
    ).toBeLessThanOrEqual(1);
  });
});

/**
 * The transcript's end position is not decided by row heights alone: the canvas
 * also carries padBottom (the composer slot's measured height) and the bottom of
 * the scrollport is the viewport height. Both arrive from ResizeObserver, i.e.
 * AFTER the frame that projected the tail — the composer is portalled in once
 * history finishes loading, and the pane settles its own size around the same
 * time. Whatever those observers add to `maxScrollTop` after the last projection
 * is exactly how far short of the end the reader is left.
 *
 * These assert the intent, not the mechanism: while the intent is `tail`, the
 * viewport ends at the end of the transcript — no matter which layout input
 * moved the end last. STICK_THRESHOLD_PX is deliberately NOT the tolerance here:
 * a 40px shortfall is invisible to it, and 40px of leftover scroll is precisely
 * the reported defect.
 */
describe('tail intent survives layout inputs that land after the projection', () => {
  it('holds the end when the composer slot is filled after the transcript settled', async () => {
    const { scrollEl, view } = await mountTranscript(120, { composer: 'slot' });

    view.scrollToBottom();
    await settled(scrollEl);
    expect(distanceToBottom(scrollEl), 'transcript did not start at the end').toBeLessThanOrEqual(
      1
    );

    const slot = view.composerSlot;
    if (!slot) throw new Error('composer:slot mounted without a composer slot element');
    const heightBefore = scrollEl.scrollHeight;

    // What the host does once history loads: portal a composer into the slot.
    const composer = document.createElement('div');
    composer.style.cssText = 'height:120px;';
    slot.appendChild(composer);
    await settled(scrollEl);

    // Pre-assertion: the composer has to reach layout and move the end, otherwise
    // "still at the end" is true for the uninteresting reason that nothing changed.
    expect(
      scrollEl.scrollHeight,
      'composer slot did not grow the canvas, so this asserts nothing'
    ).toBeGreaterThan(heightBefore);

    expect(
      distanceToBottom(scrollEl),
      `composer appearing left the transcript ${distanceToBottom(scrollEl)}px short of the end`
    ).toBeLessThanOrEqual(1);
  });

  it('holds the end when the viewport shrinks under a settled transcript', async () => {
    const { host, scrollEl, view } = await mountTranscript(120, { composer: 'slot' });

    view.scrollToBottom();
    await settled(scrollEl);
    expect(distanceToBottom(scrollEl), 'transcript did not start at the end').toBeLessThanOrEqual(
      1
    );

    const clientBefore = scrollEl.clientHeight;
    host.style.height = '320px';
    await settled(scrollEl);

    // Pre-assertion: the viewport actually shrank, so maxScrollTop really moved.
    expect(
      scrollEl.clientHeight,
      'host resize did not shrink the scrollport, so this asserts nothing'
    ).toBeLessThan(clientBefore);

    expect(
      distanceToBottom(scrollEl),
      `viewport shrink left the transcript ${distanceToBottom(scrollEl)}px short of the end`
    ).toBeLessThanOrEqual(1);
  });
});

/**
 * #6578「acp 进去之后离上次切走的位置跳上去一点;在底部的话再进去也该在底部」。
 *
 * 读者的意图(tail / 行锚)只该被用户的手势改写。这几格造的都是视图挂上一条会话后的第一次投影:
 * 投影用的几何若与 DOM 不一致 —— 视口高度还是信号初值 600、行高还是上一条会话的 —— 写出的 scrollTop 越界,
 * 浏览器把它夹回,readPhase 把这一下当成用户滚动,意图就被改写并存进 ChatState,之后每次回来都恢复错的那个。
 * 上面那几组的宿主都是 400px 高(矮于 600),所以视口那一格从来没被量到。
 */
function shortTurns(prefix: string, count: number): TranscriptTurn[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-turn-${index}`,
    seq: index,
    initiator: index % 2 === 0 ? 'user' : 'agent',
    items: [
      {
        kind: 'message',
        id: `${prefix}-msg-${index}`,
        seq: 0,
        role: index % 2 === 0 ? 'user' : 'assistant',
        text: index % 2 === 0 ? `question ${index}` : `answer ${index}`,
      },
    ],
    outcome: { kind: 'done' },
  })) as TranscriptTurn[];
}

function tallTurns(prefix: string, count: number): TranscriptTurn[] {
  const body = (index: number) =>
    Array.from({ length: 50 }, (_, line) => `${line + 1}. line ${line + 1} of answer ${index}, long enough to be a row.`).join('\n\n');
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-turn-${index}`,
    seq: index,
    initiator: index % 2 === 0 ? 'user' : 'agent',
    items: [
      {
        kind: 'message',
        id: `${prefix}-msg-${index}`,
        seq: 0,
        role: index % 2 === 0 ? 'user' : 'assistant',
        text: index % 2 === 0 ? `question ${index}` : body(index),
      },
    ],
    outcome: { kind: 'done' },
  })) as TranscriptTurn[];
}

describe('the first projection onto a (re)attached conversation uses the geometry the DOM will have (#6578)', () => {
  it('opens at the end of a transcript whose viewport is taller than 600px', async () => {
    const { scrollEl, appendCycle } = await mountTranscript(120, { composer: 'slot', height: 900 });

    expect(scrollEl.clientHeight, 'the scrollport is not taller than 600px, so this asserts nothing').toBeGreaterThan(600);
    expect(
      scrollEl.scrollHeight - scrollEl.clientHeight,
      'seeded transcript does not overflow the tall viewport, so this asserts nothing'
    ).toBeGreaterThan(STICK_THRESHOLD_PX);
    expect(
      distanceToBottom(scrollEl),
      `a fresh view opened ${distanceToBottom(scrollEl)}px above the end`
    ).toBeLessThanOrEqual(1);

    const heightBefore = scrollEl.scrollHeight;
    appendCycle();
    await settled(scrollEl);
    expect(scrollEl.scrollHeight, 'appended turns did not reach layout, so this asserts nothing').toBeGreaterThan(heightBefore);
    expect(
      distanceToBottom(scrollEl),
      `after opening, new turns were not followed (${distanceToBottom(scrollEl)}px above the end)`
    ).toBeLessThanOrEqual(1);
  });

  // 主人那一格:从编程模式会话 / 会话历史回到 ACP 会话 —— 聊天面板卸载过,回来时在同一个 ChatState 上新建视图。
  it('comes back to the end when the view is re-created on the same conversation in a tall viewport', async () => {
    const m = await mountTranscript(120, { composer: 'slot', height: 900 });
    m.view.scrollToBottom();
    await settled(m.scrollEl);
    expect(distanceToBottom(m.scrollEl), 'the reader did not leave from the end').toBeLessThanOrEqual(1);

    const scrollEl = await m.remount();
    expect(scrollEl.clientHeight, 'the scrollport is not taller than 600px, so this asserts nothing').toBeGreaterThan(600);
    expect(
      distanceToBottom(scrollEl),
      `left at the end, came back ${distanceToBottom(scrollEl)}px above it`
    ).toBeLessThanOrEqual(1);

    const heightBefore = scrollEl.scrollHeight;
    m.appendCycle();
    await settled(scrollEl);
    expect(scrollEl.scrollHeight, 'appended turns did not reach layout, so this asserts nothing').toBeGreaterThan(heightBefore);
    expect(
      distanceToBottom(scrollEl),
      `after coming back, new turns were not followed (${distanceToBottom(scrollEl)}px above the end)`
    ).toBeLessThanOrEqual(1);
  });

  // ACP↔ACP 直接切:同一个视图 setModel 换会话。换进来的一条若沿用上一条同序号行的高度,canvas 会塌到视口以内。
  // 宿主 600px:视口一格(上面两条)在这里是中性的,只量换会话这一格。
  it('keeps the reader\'s row across a swap to a conversation of much shorter rows', async () => {
    const m = await mountTranscript(0, { height: 600, turns: tallTurns('tall', 12) });
    const other = createChatState(m.ctx);
    other.transcript.history.seed(shortTurns('short', 80));
    try {
      m.view.scrollToBottom();
      await settled(m.scrollEl);
      const bottomTop = m.scrollEl.scrollTop;
      m.scrollEl.scrollTop = Math.max(0, bottomTop - 900);
      expect(m.scrollEl.scrollTop, `scroll driver did not move the container (stayed at ${bottomTop}px)`).toBeLessThan(bottomTop - 100);
      await until('the row under the scrolled-up viewport is rendered', () => readerRow(m.scrollEl) !== null);
      await settled(m.scrollEl);
      const seen = readerRow(m.scrollEl)!;
      expect(distanceToBottom(m.scrollEl), 'the reader did not leave the stick zone').toBeGreaterThan(STICK_THRESHOLD_PX);

      m.view.setModel(other);
      await settled(m.scrollEl);
      expect(
        m.scrollEl.querySelector('[data-item-id^="short-"]'),
        'the short conversation never rendered, so the swap asserts nothing'
      ).not.toBeNull();

      m.view.setModel(m.state);
      await until('the tall conversation is rendered again', () => rowOffset(m.scrollEl, seen.itemId) !== null);
      await settled(m.scrollEl);
      const back = rowOffset(m.scrollEl, seen.itemId);
      expect(back, `the reader's row ${seen.itemId} is not rendered after coming back`).not.toBeNull();
      expect(back, `the reader's row ${seen.itemId} came back ${back}px from the top (left at ${seen.offset}px)`).toBeCloseTo(
        seen.offset,
        0
      );
      expect(
        distanceToBottom(m.scrollEl),
        'the reader who left mid-transcript was brought back to the end'
      ).toBeGreaterThan(STICK_THRESHOLD_PX);
    } finally {
      other.dispose();
    }
  });

  // 平滑滚动还在路上就换会话:那段动画属于上一条会话,换进来的一条照样落在它自己的意图上(锚在顶部)。
  // `stray`:中止之后浏览器仍可能落下动画在途的那一步(CI 负载下实测 11px)。它在哪一帧落下由浏览器与机器负载决定,
  // 所以两端都钉住:'sync' 紧跟换会话,'settled' 在换进来的一条已经落在自己意图上之后 —— 哪一帧落下都不是读者手势。
  // `then`:换会话之后接着要做的事(读者自己的滚动),在换进来的会话释放之前跑。
  async function swapMidSmoothScroll(
    stray: { px: number; lands: 'sync' | 'settled' } | null,
    then?: (m: Mounted) => Promise<void>
  ): Promise<void> {
    const m = await mountTranscript(120, { height: 600 });
    const other = createChatState(m.ctx);
    other.transcript.history.seed(shortTurns('short', 40));
    other.scroll.set(pinTopMode('short-msg-0'));
    try {
      m.scrollEl.scrollTop = 0;
      await settled(m.scrollEl);
      const target = m.scrollEl.scrollHeight - m.scrollEl.clientHeight;
      m.view.scrollToBottom({ behavior: 'smooth' });
      for (let frame = 0; frame < 30 && m.scrollEl.scrollTop === 0; frame++) await nextFrame();
      expect(
        m.scrollEl.scrollTop > 0 && m.scrollEl.scrollTop < target - 50,
        `the smooth scroll is not in flight (scrollTop ${m.scrollEl.scrollTop} of ${target}), so this asserts nothing`
      ).toBe(true);

      m.view.setModel(other);
      if (stray?.lands === 'sync') m.scrollEl.scrollTop += stray.px;
      await settled(m.scrollEl);
      if (stray?.lands === 'settled') {
        expect(
          rowOffset(m.scrollEl, 'short-msg-0'),
          'the incoming conversation was not on its intent before the late step, so the late step asserts nothing'
        ).toBeCloseTo(0, 0);
        m.scrollEl.scrollTop += stray.px;
        await settled(m.scrollEl);
      }
      expect(
        m.scrollEl.querySelector('[data-item-id^="short-"]'),
        'the incoming conversation never rendered, so the swap asserts nothing'
      ).not.toBeNull();
      // null 会被 toBeCloseTo 当成 0 放行 —— 先判「那一行在不在」。
      const first = rowOffset(m.scrollEl, 'short-msg-0');
      expect(first, 'the incoming conversation\'s first row is not rendered: it was not placed on its own intent').not.toBeNull();
      expect(first, `the incoming conversation's first row is ${first}px from the top, not on its intent`).toBeCloseTo(0, 0);
      await then?.(m);
    } finally {
      other.dispose();
    }
  }

  it('places the incoming conversation even while a smooth scroll on the outgoing one is in flight', async () => {
    await swapMidSmoothScroll(null);
  });

  it('does not read a step the aborted smooth scroll lands right after the swap as the reader\'s gesture', async () => {
    await swapMidSmoothScroll({ px: 11, lands: 'sync' });
  });

  it('does not read a step the aborted smooth scroll lands after the incoming conversation settled as the reader\'s gesture', async () => {
    await swapMidSmoothScroll({ px: 11, lands: 'settled' });
  });

  // 上两条的阳控:读者自己的滚动(先有输入,再有位移)在换会话之后照样是读者手势,不被重投影抹掉。
  it('still takes the reader\'s own scroll after such a swap as the reader\'s gesture', async () => {
    await swapMidSmoothScroll({ px: 11, lands: 'settled' }, async (m) => {
      const before = m.scrollEl.scrollTop;
      m.scrollEl.dispatchEvent(new WheelEvent('wheel', { deltaY: 200, bubbles: true }));
      m.scrollEl.scrollTop = before + 200;
      expect(m.scrollEl.scrollTop, `scroll driver did not move the container (stayed at ${before}px)`).toBeGreaterThan(before + 100);
      await settled(m.scrollEl);
      expect(m.scrollEl.scrollTop, 'the reader\'s own scroll was undone by a re-projection').toBeCloseTo(before + 200, 0);
    });
  });
});
