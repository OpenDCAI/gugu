/** @jsxImportSource solid-js */
/**
 * Chromium contract: the two once-a-second clocks in a live turn — the turn time-header
 * (`turn-process.def.tsx`) and the thinking header (`thinking.def.tsx`) — own at most one
 * interval each, however many times the live turn re-renders, and none once the view is gone.
 *
 * Why this is a contract and not a style note: both clocks were started from a `createEffect`
 * that re-runs on every streaming update of the live turn, and the interval id went into a
 * variable outside the effect. Each re-run overwrote it, so only the last interval could ever be
 * cleared. The rest kept ticking at 1 Hz forever, and their closures (Solid setter → owner →
 * ChatRoot props → mount element) pinned every disposed transcript and its DOM. mac1, 2026-09-25:
 * ten archived tasks left 38 such intervals alive in the renderer and ~160 detached nodes each.
 *
 * Instrument: `window.setInterval` / `window.clearInterval` wrapped for the duration of the test,
 * counting ids that were set and not yet cleared. Positive control: the count is exactly 2 while
 * the turn is live (one clock per header) — so a wrapper that saw nothing cannot pass the
 * "0 after dispose" reading by default.
 *
 * The clocks must also keep ticking while updates arrive faster than once a second: restarting the
 * interval on every update (one way to "fix" the leak) never lets it reach its first tick, and the
 * thinking header's seconds would freeze. Read off the rendered label across 2.4 s of 300 ms chunks.
 * That time is the thing under test, so it runs on a fake clock (intervals + Date) the test advances
 * itself: on a real clock a busy machine delays the 1 Hz ticks past the read and the label reads one
 * second short, while a machine too slow to deliver chunks within a second lets a restart-every-update
 * clock tick anyway.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import type { ChatMessage, ChatThinking, TranscriptTurn } from '@session-chat/model';
import { createChatState } from '@session-chat/state/chat-state';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

const live = new Set<number>();

beforeEach(() => {
  // Only the clocks and Date: rendering (rAF) and the `until` polling keep the real scheduler.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  live.clear();
  const fakeSetInterval: (handler: TimerHandler, timeout?: number) => number = window.setInterval.bind(window);
  const fakeClearInterval: (id?: number) => void = window.clearInterval.bind(window);
  window.setInterval = ((handler: TimerHandler, timeout?: number) => {
    const id = fakeSetInterval(handler, timeout);
    live.add(id);
    return id;
  }) as typeof window.setInterval;
  window.clearInterval = ((id?: number) => {
    if (id !== undefined) live.delete(id);
    fakeClearInterval(id);
  }) as typeof window.clearInterval;
});

afterEach(() => {
  // Restores the real setInterval / clearInterval / Date over the counting wrappers too.
  vi.useRealTimers();
});

const msg = (id: string, seq: number, role: ChatMessage['role'], text: string): ChatMessage => ({
  kind: 'message',
  id,
  seq,
  role,
  text,
});

const STARTED_AT = Date.now() - 16_000;

/** Two assistant messages before the tail so the process folds (see turn-process-fold contract). */
function liveTurn(chunks: number): TranscriptTurn {
  const thinking: ChatThinking = {
    kind: 'thinking',
    id: 'th-1',
    seq: 1,
    status: 'thinking',
    text: 'Weighing the options' + ' …'.repeat(chunks),
    startedAt: STARTED_AT + 1_000,
  };
  return {
    id: 'live-1',
    seq: 1,
    initiator: 'user',
    startedAt: STARTED_AT,
    items: [
      msg('u1', 0, 'user', 'Research the market'),
      thinking,
      msg('a-mid', 2, 'assistant', 'Checking the latest numbers first.'),
      msg('a-mid-2', 3, 'assistant', 'Now cross-checking with the filings.'),
      msg('a-tail', 4, 'assistant', `Here is what the numbers say${' so far'.repeat(chunks)}.`),
    ] as TranscriptTurn['items'],
  } as TranscriptTurn;
}

describe('live-turn header clocks', () => {
  it('owns one process clock while streaming; thinking does not start a duplicate clock', async () => {
    const ctx = createChatContext({ locale: () => 'en-US', layout: { preset: 'double', userGutter: 72 } });
    const state = createChatState(ctx);
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
    document.body.appendChild(host);
    const view = createChatView({ context: ctx, state, parent: host });
    const header = () => host.querySelector<HTMLElement>('[data-slot="turn-process"]');
    try {
      state.transcript.activeTurn.set(liveTurn(0));
      await until('live turn header mounts', () => header()?.dataset.live, (v) => v === 'true');
      await until('thinking header mounts', () => host.querySelector('[data-chat-canvas]')?.textContent ?? '',
        (text) => text.includes('Thinking'));

      const processSeconds = () =>
        Number(/Worked for (\d+)s/.exec(header()?.textContent ?? '')?.[1] ?? NaN);
      const secondsBefore = processSeconds();

      // Stream: every update re-renders the live turn (new item objects each time), 300 ms apart.
      for (let chunk = 1; chunk <= 8; chunk++) {
        state.transcript.activeTurn.set(liveTurn(chunk));
        await until(`chunk ${chunk} on screen`, () => host.querySelector('[data-chat-canvas]')?.textContent ?? '',
          (text) => text.includes(`say${' so far'.repeat(chunk)}.`));
        await vi.advanceTimersByTimeAsync(300);
      }
      // 2.4 s of updates arriving faster than 1/s: the one process clock still advances.
      await until('process header shows the advanced clock', () => processSeconds() - secondsBefore, (advanced) => advanced >= 2);
      await untilStable('streamed view settles', () => [live.size, header()?.textContent ?? '']);

      // Positive control: the process clock is alive; thinking adds no second timer.
      expect(live.size).toBe(1);
      expect(host.querySelector('[data-chat-canvas]')?.textContent).not.toMatch(/Thinking \d+s/);

      view.dispose();
      expect(live.size, 'intervals still alive after the view was disposed').toBe(0);
    } finally {
      ctx.dispose();
      state.dispose();
      document.body.removeChild(host);
    }
  });
});
