/** @jsxImportSource solid-js */
/**
 * row-slot-after-commit.contract — a row must still fit the slot the
 * virtualizer reserved for it after its turn commits.
 *
 * ## What broke
 *
 * A row's height is *predicted* (`UnitDef.measure`), written into the
 * virtualizer, and every row below is positioned from that prefix sum. Nothing
 * reads the DOM back — prose lines are absolutely positioned from engine
 * geometry — so a reservation that disagrees with what the row paints is
 * permanent, not a frame of jitter.
 *
 * Streaming tracked correctly: a message growing to 262px of content held a
 * 294px slot at every chunk. Then the turn committed, the slot dropped to 112px
 * (`estimate()` 104 + the 8px seam), and the DOM kept painting 262px — so the
 * rows that landed next were drawn 150px too high, inside the message's box.
 *
 * Two things had to line up: turn commit rebuilds the unit list and
 * `Virtualizer.setCount` re-seeds the re-appearing index from `estimate()`; and
 * `measure()` returns the same height for the same text whether the message
 * streams or is committed, so the tween *target* never changes and the registry
 * used to read "target unchanged" as "the virtualizer already agrees".
 *
 * The registry's own half of that contract is pinned deterministically in
 * `tween-registry.test.ts`. This file is the product-level half: real Chromium,
 * real transcript, painted geometry.
 *
 * ## Why the assertions are shaped like this
 *
 * `measure() === offsetHeight` compares two height formulas and stays green
 * while content overflows or is clipped (#3429 ①), so this file reads painted
 * geometry instead.
 *
 * The slot is read as `nextRowTop - thisRowTop`, which is exactly the size the
 * virtualizer holds for the row. Whole-canvas readings were tried first and are
 * wrong: canvas height is `totalHeight + pads + activeTurnReserve()`, and both
 * the reserve and the idle prefetch's backward pass move it for reasons that
 * have nothing to do with the commit under test.
 *
 * The control test is load-bearing. `estimate()` counts `ceil(len / 60)` body
 * lines and knows nothing about fenced code blocks, list items or CJK advance
 * widths. Content whose estimate happens to equal its measure would let every
 * assertion below pass while measuring nothing — which is how a manual pass on
 * this bug came back "looks fine".
 */

import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { createChatCaches } from '@session-chat/core/caches';
import { DEFAULT_THEME } from '@session-chat/core/theme';
import { generateMockTranscript } from '@session-chat/mock-transcript';
import type { MeasureCtx } from '@session-chat/core/define';
import { messageUnitDef } from '@session-chat/components/rows/message/message.def';
import type { ChatMessage, TranscriptTurn } from '@session-chat/model';
import { createChatState } from '@session-chat/state/chat-state';
import { afterEach, describe, expect, it } from 'vitest';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

/** A fenced code block plus a list is where estimate() and measure() diverge most. */
const CODE_BLOCK_MESSAGE = [
  '验证通过！',
  '',
  '- **写入**: ✓ 创建文件成功',
  '- **编辑**: ✓ 修改内容成功',
  '- **读取**: ✓ 读取验证成功',
  '',
  '文件 `/Users/apple/Library/Application Support/Electron/task-home/edit-test.txt` 的最终内容：',
  '```',
  'Edit test passed! ✓',
  'Created at: 2026-08-17',
  '```',
  '',
  '你有需要编辑的代码或文件吗？',
].join('\n');

/** Text unique to the message above, used to find its row without leaning on an index. */
const CODE_ROW_MARK = '验证通过';

/** The rows that landed after the commit in the reported transcript. */
const FOLLOW_UP_A =
  '**Notice:** Stop says: ⏸ Stop 自检触发：本会话改过的仓有未提交改动（/Users/apple/Library/Application Support/Electron/task-home）';
const FOLLOW_UP_A_MARK = 'Stop 自检触发';
const FOLLOW_UP_B = '测试文件保留了，需要我删除或清理吗？还是你有其他需要我帮忙的任务？';

/** Chunk cuts that straddle the fence, so it opens in one chunk and closes in a later one. */
const CHUNKS = [12, 40, 70, 96, 120, 150, 180, 200, CODE_BLOCK_MESSAGE.length];

/**
 * Tolerance for "the row fits its slot".
 *
 * Not a seam budget: `unitReservedHeight = unit.gapBefore + contentH` and
 * `gapBefore` is painted as the row's own `padding-top`, so a correct slot
 * equals the painted box and adjacent boxes touch. Anything beyond sub-pixel
 * rounding is a real reservation error.
 */
const FIT_TOLERANCE_PX = 1;

type RowBox = { index: number; top: number; bottom: number; height: number; text: string };

function rowBoxes(host: HTMLElement): RowBox[] {
  const canvas = host.querySelector('[data-chat-canvas]');
  if (!canvas) throw new Error('no [data-chat-canvas] — cannot read row geometry');
  return Array.from(canvas.querySelectorAll<HTMLElement>('[data-index]'))
    .map((el) => {
      const r = el.getBoundingClientRect();
      return {
        index: Number(el.dataset.index),
        top: r.top,
        bottom: r.bottom,
        height: r.height,
        text: el.innerText,
      };
    })
    .filter((b) => Number.isFinite(b.index) && b.height > 0)
    .sort((a, b) => a.index - b.index);
}

/**
 * Wait until row geometry stops changing.
 *
 * A fixed frame count would be a race: settling depends on scheduler re-arms,
 * async highlight fill-in and idle prefetch slices, all of which stretch under
 * loaded CI hosts (fonts are preloaded by contract-setup before any test). So:
 * wait for the row signature to hold across consecutive animation frames (#6346). No frame cap — the old
 * 240-frame cap returned unsettled geometry silently; a layout that never
 * converges is now red through the test's own timeout, naming this step.
 */
async function settleGeometry(host: HTMLElement): Promise<RowBox[]> {
  await untilStable('row geometry settles', () =>
    rowBoxes(host)
      .map((b) => `${b.index}:${b.top.toFixed(1)}:${b.height.toFixed(1)}`)
      .join('|')
  );
  return rowBoxes(host);
}

/**
 * The transcript's own item type. Deliberately derived from `TranscriptTurn`
 * rather than reusing the render-model `ChatMessage`: they are different shapes
 * (the transcript item carries `seq`), and the earlier `as TranscriptTurn` cast
 * on this fixture was hiding exactly that — a fixture the product never
 * produces, in a file whose whole argument rests on the fixture being real.
 */
type TranscriptItem = TranscriptTurn['items'][number];

function turn(seq: number, items: TranscriptItem[], settled = true): TranscriptTurn {
  const base = { id: `slot-turn-${seq}`, seq, initiator: 'agent' as const, items };
  return settled ? { ...base, outcome: { kind: 'done' as const } } : base;
}

/** A transcript message item, as the reducer would emit it. */
function msg(id: string, text: string, seq = 0): TranscriptItem {
  return { kind: 'message', id, seq, role: 'assistant', text };
}

/** The render-model shape the unit defs measure, for the control test only. */
function renderMsg(id: string, text: string): ChatMessage {
  return { kind: 'message', id, role: 'assistant', text };
}

/** The row whose rendered text carries `mark`, or a failure naming what was there instead. */
function rowWith(boxes: RowBox[], mark: string): RowBox {
  const hit = boxes.find((b) => b.text.includes(mark));
  if (!hit) {
    throw new Error(
      `no rendered row contains ${JSON.stringify(mark)} — the setup did not put it on screen, ` +
        'so any geometry assertion about it would measure nothing. Rendered indices: ' +
        boxes.map((b) => b.index).join(',')
    );
  }
  return hit;
}

const teardown: Array<() => void> = [];

type Mounted = {
  host: HTMLElement;
  state: ReturnType<typeof createChatState>;
  view: ReturnType<typeof createChatView>;
};

async function mountAtBottom(): Promise<Mounted> {
  const ctx = createChatContext({ locale: () => 'en-US', theme: DEFAULT_THEME });
  const state = createChatState(ctx);
  const host = document.createElement('div');
  host.dataset.rowSlotHost = '';
  host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:400px;';
  document.body.appendChild(host);
  const view = createChatView({ context: ctx, state, parent: host });

  // Registered before any await: a throw while seeding or settling below would
  // otherwise leak the rAF loop, observers and listeners into later tests.
  teardown.push(() => {
    view.dispose();
    ctx.dispose();
    state.dispose();
    host.remove();
  });

  state.transcript.history.seed(generateMockTranscript(120, 7));
  // Stability is only meaningful once the seeded rows are projected: an empty
  // canvas is also "unchanged across frames".
  await until('seeded rows mount', () => rowBoxes(host).length > 0);
  await settleGeometry(host);
  view.scrollToBottom();
  await settleGeometry(host);
  return { host, state, view };
}

afterEach(() => {
  while (teardown.length > 0) teardown.pop()?.();
  document.querySelectorAll('[data-row-slot-host]').forEach((el) => el.remove());
});

describe('row slot survives turn commit', () => {
  it('control: estimate and measure diverge at the width rows actually use', async () => {
    const m = await mountAtBottom();
    const canvas = m.host.querySelector('[data-chat-canvas]') as HTMLElement | null;
    expect(canvas, 'no canvas — cannot learn the width rows are laid out at').toBeTruthy();
    const width = canvas!.getBoundingClientRect().width;
    expect(width, 'canvas reported no width').toBeGreaterThan(0);

    const mctx: MeasureCtx = {
      theme: DEFAULT_THEME,
      width,
      isCollapsed: () => false,
      expanded: () => false,
      caches: createChatCaches(),
      measureEpoch: 0,
      expandedId: null,
    };
    const vars = messageUnitDef.vars ?? {};
    const item = renderMsg('control', CODE_BLOCK_MESSAGE);
    // defs are typed at the registry boundary
    const estimated = (messageUnitDef as any).estimate(item, mctx, vars) as number;
    // same boundary
    const measured = (messageUnitDef as any).measure(item, mctx, vars) as number;

    expect(
      Math.abs(measured - estimated),
      `at the real row width ${width.toFixed(1)}px, estimate (${estimated}px) and measure ` +
        `(${measured}px) agree, so the geometry assertions in this file would pass without ` +
        'measuring anything'
    ).toBeGreaterThan(40);
  });

  it('keeps the committed row inside its reserved slot, with the next row below it', async () => {
    const m = await mountAtBottom();

    // Stream the message in chunks through activeTurn.
    let grew = false;
    let previousHeight = 0;
    for (const cut of CHUNKS) {
      m.state.transcript.activeTurn.set(
        turn(9101, [msg('slot-code', CODE_BLOCK_MESSAGE.slice(0, cut))], false)
      );
      const boxes = await settleGeometry(m.host);
      const row = boxes.find((b) => b.text.includes(CODE_ROW_MARK));
      if (row && row.height > previousHeight) grew = true;
      if (row) previousHeight = row.height;
    }
    // Without this a dead activeTurn setter would leave nothing on screen and
    // every assertion below would be vacuously true.
    expect(grew, 'the streamed row never grew — the stream driver is dead').toBe(true);

    // Commit the turn, then land the rows that followed it in the report.
    m.state.transcript.activeTurn.set(null);
    m.state.transcript.history.append([turn(9101, [msg('slot-code', CODE_BLOCK_MESSAGE)])]);
    await settleGeometry(m.host);
    m.state.transcript.history.append([
      turn(9102, [msg('slot-follow-a', FOLLOW_UP_A)]),
      turn(9103, [msg('slot-follow-b', FOLLOW_UP_B)]),
    ]);
    m.view.scrollToBottom();
    const boxes = await settleGeometry(m.host);

    // Both rows must genuinely be on screen. A bare `boxes.length > 1` would be
    // satisfied by the seeded mock rows alone and would prove nothing.
    const codeRow = rowWith(boxes, CODE_ROW_MARK);
    const nextRow = rowWith(boxes, FOLLOW_UP_A_MARK);
    expect(
      nextRow.index,
      'the follow-up row is not the one immediately after the committed row'
    ).toBe(codeRow.index + 1);

    // `nextRowTop - thisRowTop` IS the size the virtualizer holds for this row.
    const slot = nextRow.top - codeRow.top;
    expect(
      slot,
      `the committed row paints ${codeRow.height.toFixed(1)}px into a ${slot.toFixed(1)}px slot, ` +
        `so the next row sits ${(codeRow.height - slot).toFixed(1)}px too high`
    ).toBeGreaterThanOrEqual(codeRow.height - FIT_TOLERANCE_PX);

    // And the reservation must not be padded out either: a slot far larger than
    // the row is the blank-gap half of the same defect.
    expect(
      slot,
      `the committed row reserves ${slot.toFixed(1)}px but only paints ` +
        `${codeRow.height.toFixed(1)}px, leaving blank the layout does not explain`
    ).toBeLessThanOrEqual(codeRow.height + FIT_TOLERANCE_PX);
  });
});
