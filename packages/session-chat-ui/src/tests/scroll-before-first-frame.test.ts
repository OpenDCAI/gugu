// @vitest-environment jsdom
/**
 * A scroll requested in the task that seeds the transcript, before the frame that commits the canvas: a searched task
 * opens this way, its reveal effect flushing with the history. jsdom has no layout, so the scroller carries the one
 * browser rule this is about: scrollTop cannot pass the canvas height in the DOM at the moment it is written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatContext } from '../chat-context';
import { createChatView } from '../chat-view';
import { generateMockTranscript } from '../mock-transcript';
import { createChatState } from '../state/chat-state';

const VIEW_HEIGHT = 400;

let frames: FrameRequestCallback[] = [];
let now = 1_000;

const runFrames = (count: number): void => {
  for (let i = 0; i < count; i++) {
    now += 16;
    const due = frames;
    frames = [];
    for (const callback of due) callback(now);
  }
};

/** scrollTop as a browser stores it: clamped against the canvas height the DOM holds right now. */
function clampScrollTopToCanvas(scroller: HTMLElement): void {
  const canvas = scroller.querySelector<HTMLElement>('[data-chat-canvas]')!;
  let top = 0;
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = Math.max(0, Math.min(value, (parseFloat(canvas.style.height) || 0) - VIEW_HEIGHT));
    },
  });
}

beforeEach(() => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  vi.stubGlobal('requestIdleCallback', () => 0);
  vi.stubGlobal('cancelIdleCallback', () => undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(document, 'fonts', { configurable: true, value: { load: async () => [], ready: Promise.resolve() } });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    { font: '', measureText: (text: string) => ({ width: text.length * 7 }) } as unknown as RenderingContext
  );
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(VIEW_HEIGHT);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  (HTMLElement.prototype as { checkVisibility?: () => boolean }).checkVisibility = () => true;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('scrolling in the task that seeds the transcript', () => {
  it('keeps the requested row as the intent once the canvas has caught up', () => {
    const context = createChatContext({ locale: () => 'en-US' });
    const state = createChatState(context);
    const host = document.createElement('div');
    document.body.append(host);
    const view = createChatView({ context, state, parent: host });
    const scroller = host.querySelector<HTMLElement>('[data-chat-scroll]')!;
    clampScrollTopToCanvas(scroller);
    runFrames(3);

    const turns = generateMockTranscript(120, 7);
    const target = turns[Math.floor(turns.length / 2)]!.items[0]!.id;
    state.transcript.history.seed(turns);
    view.scrollToItem(target, { align: 'center' });

    // Past the settle window, where a misread clamp would have sent the projection to the wrong row.
    runFrames(30);

    const scroll = state.scroll.get();
    expect(scroll.kind === 'anchor' ? scroll.itemId : scroll.kind).toBe(target);
    expect(scroller.scrollTop).toBeGreaterThan(0);
    view.dispose();
    state.dispose();
    context.dispose();
  });
});
