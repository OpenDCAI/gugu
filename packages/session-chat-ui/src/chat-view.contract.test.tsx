/** @jsxImportSource solid-js */
/**
 * Browser contract tests for createChatView / ChatView.setModel.
 *
 * These run in Chromium via @vitest/browser-playwright so they have real DOM
 * layout and Solid's reactive scheduler. They guard against regressions in the
 * Monaco-style model-swap introduced in the ChatView setModel refactor.
 */

import { DEFAULT_THEME } from '@session-chat/core/theme';
import { describe, expect, it } from 'vitest';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { generateMockTranscript } from '@session-chat/mock-transcript';
import type { ChatMessage, TranscriptTurn } from '@session-chat/model';
import { createChatState } from '@session-chat/state/chat-state';
import { until } from '../../../tests/support/awaitCondition';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Resolve after two rAF ticks so Solid has committed a reactive update. */
const nextPaint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createChatView', () => {
  it('mounts without error', async () => {
    const ctx = createChatContext({ theme: DEFAULT_THEME });
    const state = createChatState(ctx);
    state.transcript.history.seed(generateMockTranscript(10, 1));

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
    document.body.appendChild(host);

    let view: ReturnType<typeof createChatView> | null = null;
    expect(() => {
      view = createChatView({ context: ctx, state, parent: host });
    }).not.toThrow();

    await nextPaint();
    const root = host.querySelector('[data-chat-root]') as HTMLElement | null;
    expect(root).not.toBeNull();
    // @@@font-single-source (Refs #6104) — 包默认 sans 与宿主同栈(#7333 起是系统字体),❌ 不是 Inter / Sora。
    expect(root!.style.getPropertyValue('--chat-font-sans')).toBe(
      "-apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, Microsoft YaHei, Helvetica Neue, sans-serif",
    );
    view!.dispose();
    ctx.dispose();
    state.dispose();
    document.body.removeChild(host);
  });

  it('scrolls to top and bottom through the view handle', async () => {
    const ctx = createChatContext({ theme: DEFAULT_THEME });
    const state = createChatState(ctx);
    state.transcript.history.seed(generateMockTranscript(80, 10));

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:300px;';
    document.body.appendChild(host);

    const view = createChatView({ context: ctx, state, parent: host });
    await nextPaint();

    const scrollEl = host.querySelector('[data-chat-scroll]') as HTMLElement | null;
    expect(scrollEl).not.toBeNull();

    view.scrollToBottom();
    await nextPaint();
    expect(scrollEl!.scrollTop).toBeGreaterThan(0);

    view.scrollToTop();
    await nextPaint();
    expect(scrollEl!.scrollTop).toBe(0);

    view.dispose();
    ctx.dispose();
    state.dispose();
    document.body.removeChild(host);
  });

  it('aligns pinned user messages with the measured transcript column', async () => {
    const ctx = createChatContext({ theme: DEFAULT_THEME });
    const state = createChatState(ctx);
    state.transcript.history.seed(generateMockTranscript(80, 11));

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:320px;';
    document.body.appendChild(host);

    const view = createChatView({ context: ctx, state, parent: host, pinUserMessages: true });
    await nextPaint();

    view.scrollToBottom();
    // The stuck row is the user card drawn at the scroller's top edge.
    const pinnedCardEl = () => {
      const top = host.querySelector<HTMLElement>('[data-chat-scroll]')!.getBoundingClientRect().top;
      return [...host.querySelectorAll<HTMLElement>('[data-user-card]')].find((card) => {
        const d = card.getBoundingClientRect().top - top;
        return d >= 0 && d < 24;
      });
    };
    await until('pinned user card appears after scrolling to the bottom', () => pinnedCardEl() != null);
    const pinnedCard = pinnedCardEl();

    const probe = host.querySelector('[data-chat-width-probe]') as HTMLElement | null;
    expect(probe).not.toBeNull();

    const pinRect = pinnedCard!.getBoundingClientRect();
    const probeRect = probe!.getBoundingClientRect();
    expect(Math.abs(pinRect.left - probeRect.left)).toBeLessThan(1);
    expect(Math.abs(pinRect.width - probeRect.width)).toBeLessThan(1);

    view.dispose();
    ctx.dispose();
    state.dispose();
    document.body.removeChild(host);
  });

  it('keeps transcript rows disjoint while the pinned header is active', async () => {
    const ctx = createChatContext({ theme: DEFAULT_THEME });
    const state = createChatState(ctx);
    state.transcript.history.seed(generateMockTranscript(24, 17));

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:320px;';
    document.body.appendChild(host);

    const view = createChatView({ context: ctx, state, parent: host, pinUserMessages: true });
    await nextPaint();
    view.scrollToBottom();
    await nextPaint();

    // A row's own box: a pin lane spans its whole turn, so take the row inside it at its natural place.
    const rows = Array.from(host.querySelectorAll<HTMLElement>('[data-index]'))
      .map((el) => {
        const top = el.getBoundingClientRect().top;
        return { top, bottom: top + (el.firstElementChild as HTMLElement).offsetHeight };
      })
      .sort((a, b) => a.top - b.top);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.top).toBeGreaterThanOrEqual(rows[i - 1]!.bottom - 1);
    }

    view.dispose();
    ctx.dispose();
    state.dispose();
    document.body.removeChild(host);
  });

  it('keeps host typography overrides outside measurement-sensitive fragments', async () => {
    const ctx = createChatContext({ theme: DEFAULT_THEME });
    const state = createChatState(ctx);
    const message: ChatMessage = {
      kind: 'message',
      id: 'inline-code-message',
      seq: 0,
      role: 'assistant',
      text: `${'i'.repeat(40)} before \`workspace_list\` after`,
    };
    const turn: TranscriptTurn = {
      id: 'inline-code-turn',
      seq: 0,
      initiator: 'agent',
      items: [message] as TranscriptTurn['items'],
    };
    state.transcript.history.seed([turn]);

    const hostStyle = document.createElement('style');
    hostStyle.textContent = `
      .gugu-skin :where(:not([data-chat-root]):not([data-chat-root] *)) {
        font-family: 'Courier New', monospace !important;
      }
    `;
    document.head.appendChild(hostStyle);

    const host = document.createElement('div');
    host.className = 'gugu-skin';
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:300px;';
    document.body.appendChild(host);

    const view = createChatView({ context: ctx, state, parent: host });
    await document.fonts.ready;
    await nextPaint();

    const code = Array.from(host.querySelectorAll('code')).find(
      (element) => element.textContent === 'workspace_list'
    );
    expect(code).toBeDefined();
    expect(getComputedStyle(code!.parentElement!).fontFamily).toContain('-apple-system');
    expect(getComputedStyle(code!).fontFamily).toContain('JetBrains Mono Variable');

    view.dispose();
    ctx.dispose();
    state.dispose();
    document.body.removeChild(host);
    document.head.removeChild(hostStyle);
  });
});

describe('ChatView.setModel', () => {
  it('swaps models without throwing', async () => {
    const ctx = createChatContext({ theme: DEFAULT_THEME });
    const stateA = createChatState(ctx, { uri: 'conv-a' });
    const stateB = createChatState(ctx, { uri: 'conv-b' });
    stateA.transcript.history.seed(generateMockTranscript(12, 2));
    stateB.transcript.history.seed(generateMockTranscript(12, 3));

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
    document.body.appendChild(host);

    const view = createChatView({ context: ctx, state: stateA, parent: host });
    await nextPaint();

    expect(() => view.setModel(stateB)).not.toThrow();
    await nextPaint();

    expect(() => view.setModel(stateA)).not.toThrow();
    await nextPaint();

    view.dispose();
    ctx.dispose();
    stateA.dispose();
    stateB.dispose();
    document.body.removeChild(host);
  });

  it('is a no-op when called with the current model', async () => {
    const ctx = createChatContext({ theme: DEFAULT_THEME });
    const stateA = createChatState(ctx, { uri: 'conv-a' });
    stateA.transcript.history.seed(generateMockTranscript(8, 4));

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
    document.body.appendChild(host);

    const view = createChatView({ context: ctx, state: stateA, parent: host });
    await nextPaint();

    // Calling setModel with the same state should not throw or crash.
    expect(() => view.setModel(stateA)).not.toThrow();
    await nextPaint();

    view.dispose();
    ctx.dispose();
    stateA.dispose();
    document.body.removeChild(host);
  });

  it('continues rendering streaming updates on the new model after swap', async () => {
    const ctx = createChatContext({ theme: DEFAULT_THEME });
    const stateA = createChatState(ctx, { uri: 'conv-a' });
    const stateB = createChatState(ctx, { uri: 'conv-b' });
    stateA.transcript.history.seed(generateMockTranscript(6, 5));
    stateB.transcript.history.seed(generateMockTranscript(6, 6));

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
    document.body.appendChild(host);

    const view = createChatView({ context: ctx, state: stateA, parent: host });
    await nextPaint();

    view.setModel(stateB);
    await nextPaint();

    // Stream into stateB after the swap — should not crash.
    expect(() => {
      stateB.transcript.activeTurn.set(
        {
          id: 'active-turn-b',
          seq: 99,
          initiator: 'agent',
          items: [
            {
              kind: 'message',
              id: 'msg-1',
              seq: 0,
              role: 'assistant',
              text: 'Hello from model B',
            },
          ],
        },
        'generating'
      );
    }).not.toThrow();
    await nextPaint();

    expect(() => {
      stateB.transcript.activeTurn.commit('done');
    }).not.toThrow();
    await nextPaint();

    view.dispose();
    ctx.dispose();
    stateA.dispose();
    stateB.dispose();
    document.body.removeChild(host);
  });

  it('survives rapid model thrashing without error', async () => {
    const ctx = createChatContext({ theme: DEFAULT_THEME });
    const states = Array.from({ length: 3 }, (_, i) => {
      const s = createChatState(ctx, { uri: `conv-${i}` });
      s.transcript.history.seed(generateMockTranscript(10, i + 7));
      return s;
    });

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
    document.body.appendChild(host);

    const view = createChatView({ context: ctx, state: states[0], parent: host });
    await nextPaint();

    // Thrash through 30 switches.
    const errors: string[] = [];
    for (let i = 0; i < 30; i++) {
      try {
        view.setModel(states[i % states.length]);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    await nextPaint();

    expect(errors).toHaveLength(0);

    view.dispose();
    ctx.dispose();
    for (const s of states) s.dispose();
    document.body.removeChild(host);
  });
});


it('stops a pinned instruction before an independently sent reply at the unread anchor', async () => {
  const ctx = createChatContext({ layout: { agentConversation: true, preset: 'double' } });
  const state = createChatState(ctx);
  const sent = Array.from({ length: 10 }, (_, i): ChatMessage => ({
    kind: 'message', id: `call${i}:sent:message${i}`, seq: i + 1, role: 'assistant', text: `H${i + 1}`,
  }));
  state.transcript.history.seed([{
    id: 'new-private-chat', seq: 0, initiator: 'user',
    items: [{ kind: 'message', id: 'instruction', seq: 0, role: 'user', text: '请连续发送十条独立消息,从 H1 到 H10。' }, ...sent],
    outcome: { kind: 'done', reason: 'end_turn' },
  }]);
  const host = document.body.appendChild(document.createElement('div'));
  host.style.cssText = 'position:fixed;top:45px;left:0;width:800px;height:600px;';
  const view = createChatView({ context: ctx, state, parent: host, pinUserMessages: true });
  try {
    await nextPaint();
    view.setScrollMode({ kind: 'anchor', itemId: sent[0].id, edge: 'top', offset: -8 });
    await nextPaint();
    const reply = host.querySelector<HTMLElement>('[data-agent-conversation-message="call0:sent:message0"] [data-user-card]')!;
    await until('the sent reply is measured at the unread anchor', () => reply.getBoundingClientRect().height > 0);
    const rect = reply.getBoundingClientRect();
    expect(rect.top).toBeGreaterThanOrEqual(53);
    const topmost = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    expect(reply.contains(topmost), 'the prompt must not paint over or falsely read the first reply').toBe(true);
  } finally { view.dispose(); state.dispose(); ctx.dispose(); host.remove(); }
});
