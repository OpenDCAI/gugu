/** @jsxImportSource solid-js */
import { expect, it, vi } from 'vitest';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { createChatState } from '@session-chat/state/chat-state';
import { generateMockTranscript } from '@session-chat/mock-transcript';
import { UNIT_REGISTRY } from '@session-chat/components/engine/unit-registry';
import { RETAINED_SURFACE_HIDDEN_STYLE } from '@/lib/retainedSurface';
import { until } from '../../../../tests/support/awaitCondition';

const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
for (const hidden of [false, true]) for (const streaming of [false, true]) {
  it(`retained row measurement hidden=${hidden} streaming=${streaming}`, async () => {
    const ctx = createChatContext({ locale: () => 'en-US' });
    const state = createChatState(ctx);
    state.transcript.history.seed(generateMockTranscript(8, 45));
    const outer = document.body.appendChild(document.createElement('div'));
    outer.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
    const host = outer.appendChild(document.createElement('div'));
    host.style.cssText = 'width:100%;height:100%;';
    const view = createChatView({ context: ctx, state, parent: host, shown: !hidden });
    const write = (i: number) => state.transcript.activeTurn.set({
      id: 'active', seq: 99, initiator: 'agent',
      items: [{ kind: 'message', id: 'stream', seq: 0, role: 'assistant', text: `Visible update ${i}: ` + 'stream '.repeat(i + 1) }],
    }, 'generating');
    write(0);
    await document.fonts.ready;
    await frame(); await frame();
    if (hidden) Object.assign(host.style, RETAINED_SURFACE_HIDDEN_STYLE);
    await frame(); await frame();
    const spies = [...new Set(Object.values(UNIT_REGISTRY))].map(def => vi.spyOn(def, 'measure'));
    const start = performance.now();
    try {
      for (let i = 1; i <= 32; i++) {
        if (streaming) write(i);
        await new Promise(resolve => setTimeout(resolve, 125));
      }
      await frame();
      const calls = spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
      expect(state.transcript.activeTurn.get()?.items[0]).toMatchObject({ text: expect.stringContaining(`Visible update ${streaming ? 32 : 0}:`) });
      console.info(JSON.stringify({ hidden, streaming, updates: streaming ? 32 : 0, wallMs: performance.now() - start, measureCalls: calls, visible: host.checkVisibility(), descendantVisible: host.firstElementChild?.checkVisibility(), contentVisibility: getComputedStyle(host).contentVisibility }));
      expect(host.firstElementChild?.checkVisibility()).toBe(!hidden);
      if (hidden) expect(calls).toBe(0);
      if (!hidden && streaming) expect(calls).toBeGreaterThan(0);
      if (hidden) {
        const scroll = host.querySelector('[data-chat-scroll]');
        for (const spy of spies) spy.mockClear();
        host.style.cssText = 'width:100%;height:100%;';
        view.setShown(true);
        view.scrollToBottom();
        await until('resumed row has the latest positive height', () => {
          const row = host.querySelector<HTMLElement>('[data-item-id="stream"]');
          return !!row && row.getBoundingClientRect().height > 0;
        });
        expect(host.querySelector('[data-chat-scroll]')).toBe(scroll);
        expect(host.textContent).toContain(`Visible update ${streaming ? 32 : 0}:`);
        expect(spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0)).toBeGreaterThan(0);
      }
    } finally {
      vi.restoreAllMocks(); view.dispose(); state.dispose(); ctx.dispose(); outer.remove();
    }
  }, 20000);
}

it('retains the scroll anchor and latest model when a mounted view hides and resumes', async () => {
  const ctx = createChatContext({ locale: () => 'en-US' });
  const state = createChatState(ctx);
  state.transcript.history.seed(generateMockTranscript(40, 31));
  const host = document.body.appendChild(document.createElement('div'));
  host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
  const view = createChatView({ context: ctx, state, parent: host });
  try {
    await document.fonts.ready; await frame(); await frame();
    const scroll = host.querySelector<HTMLElement>('[data-chat-scroll]')!;
    view.scrollToTop(); scroll.scrollTop = 137; scroll.dispatchEvent(new Event('scroll'));
    await frame(); await frame();
    const top = scroll.scrollTop; expect(top).toBeGreaterThan(0);
    view.setShown(false); Object.assign(host.style, RETAINED_SURFACE_HIDDEN_STYLE);
    const spies = [...new Set(Object.values(UNIT_REGISTRY))].map(def => vi.spyOn(def, 'measure'));
    for (let i = 0; i < 8; i++) {
      state.transcript.activeTurn.set({ id: 'hidden-turn', seq: 999, initiator: 'agent',
        items: [{ kind: 'message', id: 'hidden-message', seq: 0, role: 'assistant', text: 'Latest hidden text ' + i }],
      }, 'generating');
      await frame();
    }
    expect(spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0)).toBe(0);
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
    view.setShown(true); await frame(); await frame();
    expect(host.querySelector('[data-chat-scroll]')).toBe(scroll);
    expect(Math.abs(scroll.scrollTop - top)).toBeLessThan(1);
    expect(state.transcript.activeTurn.get()?.items[0]).toMatchObject({ text: 'Latest hidden text 7' });
    view.scrollToBottom();
    await until('latest hidden model renders on return', () => host.textContent?.includes('Latest hidden text 7') === true);
    view.dispose(); for (const spy of spies) spy.mockClear();
    state.transcript.activeTurn.set(null); await frame();
    expect(spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0)).toBe(0);
  } finally { vi.restoreAllMocks(); view.dispose(); state.dispose(); ctx.dispose(); host.remove(); }
}, 20000);
