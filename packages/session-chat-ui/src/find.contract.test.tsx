/** @jsxImportSource solid-js */
import { describe, expect, it } from 'vitest';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView, type ChatView } from '@session-chat/chat-view';
import type { ChatMessage, TranscriptTurn } from '@session-chat/model';
import { createChatState } from '@session-chat/state/chat-state';
import { turnProcessId } from '@session-chat/state/flatten';
import { until, untilStable } from '../../../tests/support/awaitCondition';

const NEEDLE = 'needle-4417';

const msg = (id: string, role: ChatMessage['role'], text: string): ChatMessage => ({ kind: 'message', id, seq: 0, role, text });
const exec = (id: string, command: string, outputText: string) => ({
  kind: 'execute-tool-call' as const,
  id,
  seq: 0,
  toolCallId: id,
  title: command,
  command,
  outputText,
  status: 'done' as const,
  parentToolCallId: null,
});
const turn = (id: string, items: unknown[]): TranscriptTurn => ({
  id,
  seq: 0,
  initiator: 'user',
  items: items as TranscriptTurn['items'],
  outcome: { kind: 'done' },
});

/** 40 output lines, the match on line 30: outside the expanded output window. */
const OUTPUT = Array.from({ length: 40 }, (_, i) => (i === 29 ? `FAIL ${NEEDLE.toUpperCase()}` : `ok line ${i + 1}`)).join('\n');
/** Two commands in a row fold into one tool run, and the run sits behind the turn's process header. */
const FOLDED = turn('t0', [
  msg('u0', 'user', 'Please run the suite'),
  exec('e1', 'make test', OUTPUT),
  exec('e2', 'ls', 'a\nb'),
  msg('a0', 'assistant', 'The suite ran.'),
]);
/** Enough turns to push the first one far outside the virtualized viewport. */
const FILLER = Array.from({ length: 60 }, (_, i) =>
  turn(`t${i + 1}`, [msg(`u${i + 1}`, 'user', `Question ${i + 1}`), msg(`a${i + 1}`, 'assistant', `Answer ${i + 1}.`)])
);

type Highlights = { get(name: string): { size: number; values(): IterableIterator<Range> } | undefined };
const highlighted = (): Range | null => {
  const h = (globalThis as unknown as { CSS: { highlights: Highlights } }).CSS.highlights.get('gugu-chat-find');
  return h && h.size > 0 ? (h.values().next().value ?? null) : null;
};
const highlightedRow = () =>
  highlighted()?.startContainer.parentElement?.closest<HTMLElement>('[data-item-id]')?.dataset.itemId;

async function mount(turns: TranscriptTurn[]) {
  // The double-column layout folds each turn's process behind a header.
  const ctx = createChatContext({ layout: { preset: 'double', userGutter: 72 } });
  const state = createChatState(ctx);
  state.transcript.history.seed(turns);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
  document.body.appendChild(host);
  const view: ChatView = createChatView({ context: ctx, state, parent: host, stickToBottom: true });
  const scroller = () => host.querySelector<HTMLElement>('[data-chat-scroll]') as HTMLElement;
  await until('rows mount', () => host.querySelector('[data-chat-canvas] [data-item-id]') != null);
  await untilStable('transcript settles', () => [scroller().scrollTop, scroller().scrollHeight]);
  const row = (id: string) => host.querySelector<HTMLElement>(`[data-chat-canvas] [data-item-id="${id}"]`);
  const dispose = () => {
    view.dispose();
    host.remove();
  };
  return { state, view, scroller, row, dispose };
}

function expectInside(inner: DOMRect, outer: DOMRect, what: string) {
  expect(inner.top, `${what}: top`).toBeGreaterThanOrEqual(outer.top);
  expect(inner.bottom, `${what}: bottom`).toBeLessThanOrEqual(outer.bottom);
}

describe('ChatView find', () => {
  it('opens the folds a match sits behind and scrolls it in from far outside the viewport', async () => {
    const m = await mount([FOLDED, ...FILLER]);
    try {
      // Before: the turn is not mounted and nothing is highlighted.
      expect(m.row('e1')).toBeNull();
      expect(highlighted()).toBeNull();

      expect(m.view.find('NEEDLE-4417')).toEqual({ currentIndex: 1, total: 1 });
      await until('the match is highlighted', () => highlighted() != null);
      await untilStable('the jump settles', () => [m.scroller().scrollTop, highlighted()?.getBoundingClientRect().top]);

      const range = highlighted() as Range;
      const e1 = m.row('e1');
      expect(range.toString().toLowerCase()).toBe(NEEDLE);
      expect(m.state.viewState.isCollapsed(turnProcessId('t0'))).toBe(true);
      expect(e1?.querySelector('[data-collapse-id="e1"]')?.getAttribute('aria-expanded')).toBe('true');
      expect(e1?.contains(range.startContainer)).toBe(true);

      const hit = range.getBoundingClientRect();
      expect(hit.height).toBeGreaterThan(0);
      expectInside(hit, m.scroller().getBoundingClientRect(), 'inside the transcript viewport');
      // The expanded command output renders in its own scrollable window.
      const scrolls = (el: HTMLElement) =>
        el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(el).overflowY);
      let output: HTMLElement | null = range.startContainer.parentElement;
      while (output && output !== e1 && !scrolls(output)) output = output.parentElement;
      expect(output && output !== e1 ? output.scrollTop : 0, 'the output window scrolled').toBeGreaterThan(0);
      expectInside(hit, (output as HTMLElement).getBoundingClientRect(), 'inside the output window');
    } finally {
      m.dispose();
    }
  });

  it('starts at the viewport and steps through matches in transcript order, wrapping both ways', async () => {
    const first = turn('ta', [msg('ua', 'user', `Remember ${NEEDLE}`), msg('aa', 'assistant', 'Noted.')]);
    const last = turn('tz', [msg('uz', 'user', 'Last question'), msg('az', 'assistant', `Closing: ${NEEDLE} again.`)]);
    const m = await mount([first, ...FILLER, last]);
    try {
      // Parked at the bottom: the first match at or below the viewport is the last one.
      expect(m.view.find(NEEDLE)).toEqual({ currentIndex: 2, total: 2 });
      await until('bottom match', highlightedRow, (id) => id === 'az');
      expect(m.view.findStep('next')).toEqual({ currentIndex: 1, total: 2 });
      await until('wraps to the first match', highlightedRow, (id) => id === 'ua');
      expect(m.view.findStep('prev')).toEqual({ currentIndex: 2, total: 2 });
      await until('wraps back to the last match', highlightedRow, (id) => id === 'az');
      m.view.clearFind();
      expect(highlighted()).toBeNull();
    } finally {
      m.dispose();
    }
  });
});
