import { useEffect, useRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createChatContext, createChatState, createChatView, buildChatTheme, DEFAULT_CONFIG } from '@gugu/session-chat-ui';
import type { AcpChatStore } from '../../features/sessions/acp/acp-chat-store';
import { useSessionMessageQuotes } from '../../features/sessions/acp/use-session-message-quotes';
import { finishRendererContentMenu, RENDERER_CONTENT_MENU_OPEN } from '@/lib/contentContextMenu';
import type { ContentContextMenu } from '@shared/content-context-menu';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';

vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
vi.mock('@/platform', () => ({ platform: { writeClipboardText: vi.fn() } }));

let harness: ReturnType<typeof createReactHarness>;
afterEach(() => { vi.useRealTimers(); harness?.cleanup(); document.getSelection()?.removeAllRanges(); });

async function mountMessage() {
  const store = { sessionId: 'task-a', setDraftText: vi.fn() } as unknown as AcpChatStore;
  function Harness() {
    const parent = useRef<HTMLDivElement>(null);
    const quotes = useSessionMessageQuotes(store, useRef(null));
    useEffect(() => {
      const context = createChatContext({ theme: buildChatTheme(DEFAULT_CONFIG, { preset: 'double', userGutter: 48, agentConversation: true }) });
      const state = createChatState(context);
      state.transcript.history.seed([{ id: 'turn', seq: 1, initiator: 'user', items: [{ kind: 'message', id: 'source', role: 'user', seq: 0, text: 'Original message words' }] }]);
      const view = createChatView({ context, state, parent: parent.current!, commands: { onMessageTextMount: quotes.onMessageTextMount } });
      return () => view.dispose();
    }, [quotes.onMessageTextMount]);
    return <div ref={parent} style={{ width: 390, height: 500 }} />;
  }
  harness = createReactHarness();
  await harness.render(<Harness />);
  await until('real conversation bubble is mounted', () => !!harness.container.querySelector('[data-user-card="source"]'));
  const bubble = harness.container.querySelector<HTMLElement>('[data-user-card="source"]')!;
  const text = bubble.querySelector<HTMLElement>('[data-conversation-text]')!;
  return { store, bubble, text };
}

function touch(target: HTMLElement, type: string, x = 20, y = 20) {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', clientX: x, clientY: y }));
}

it('offers copying without a whole-message quote entry from phone bubble padding', async () => {
  const { store, bubble } = await mountMessage();
  const requests: ContentContextMenu[] = [];
  const capture = (event: Event) => requests.push((event as CustomEvent<ContentContextMenu>).detail);
  window.addEventListener(RENDERER_CONTENT_MENU_OPEN, capture);
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    touch(bubble, 'pointerdown');
    await vi.advanceTimersByTimeAsync(501);
    expect(requests).toHaveLength(1);
    expect(requests[0].items.some(item => 'id' in item && item.id === 'quote')).toBe(false);
    finishRendererContentMenu(requests[0].requestId, 'copy');
    await Promise.resolve();
    expect(store.setDraftText).not.toHaveBeenCalled();
  } finally { window.removeEventListener(RENDERER_CONTENT_MENU_OPEN, capture); }
});

it('leaves native text selection alone and cancels a padding hold when scrolling or unmounting', async () => {
  const { bubble, text } = await mountMessage();
  const capture = vi.fn();
  window.addEventListener(RENDERER_CONTENT_MENU_OPEN, capture);
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    touch(text, 'pointerdown');
    await vi.advanceTimersByTimeAsync(501);
    expect(capture).not.toHaveBeenCalled();
    touch(text, 'pointerup');
    touch(bubble, 'pointerdown');
    touch(bubble, 'pointermove', 40, 20);
    await vi.advanceTimersByTimeAsync(501);
    expect(capture).not.toHaveBeenCalled();
    touch(bubble, 'pointerdown');
    harness.cleanup();
    await vi.advanceTimersByTimeAsync(501);
    expect(capture).not.toHaveBeenCalled();
  } finally { window.removeEventListener(RENDERER_CONTENT_MENU_OPEN, capture); }
});

it.each(['before', 'after'] as const)('handles an Android context menu arriving %s the hold timer only once', async timing => {
  const { bubble } = await mountMessage();
  const capture = vi.fn();
  window.addEventListener(RENDERER_CONTENT_MENU_OPEN, capture);
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    touch(bubble, 'pointerdown');
    if (timing === 'after') await vi.advanceTimersByTimeAsync(501);
    bubble.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
    await vi.advanceTimersByTimeAsync(501);
    expect(capture).toHaveBeenCalledOnce();
    const request = (capture.mock.calls[0][0] as CustomEvent<ContentContextMenu>).detail;
    expect(request.items.some(item => 'id' in item && item.id === 'quote')).toBe(false);
    finishRendererContentMenu(request.requestId);
  } finally { window.removeEventListener(RENDERER_CONTENT_MENU_OPEN, capture); }
});

it('offers only copying for selected text instead of turning it into a whole-message quote', async () => {
  const { text } = await mountMessage();
  const capture = vi.fn();
  window.addEventListener(RENDERER_CONTENT_MENU_OPEN, capture);
  try {
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = document.getSelection()!;
    selection.removeAllRanges(); selection.addRange(range);
    text.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(capture).toHaveBeenCalledOnce();
    const request = (capture.mock.calls[0][0] as CustomEvent<ContentContextMenu>).detail;
    expect(request.items.filter(item => 'id' in item).map(item => item.id)).toEqual(['copy']);
    expect(selection.toString()).toContain('Original message words');
    finishRendererContentMenu(request.requestId);
  } finally { window.removeEventListener(RENDERER_CONTENT_MENU_OPEN, capture); }
});
