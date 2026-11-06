import { useEffect, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { afterEach, expect, it, vi } from 'vitest';
import { page } from '@vitest/browser/context';
import { createChatContext, createChatState, createChatView, buildChatTheme, DEFAULT_CONFIG } from '@gugu/session-chat-ui';
import type { AcpChatStore } from '../../features/sessions/acp/acp-chat-store';
import { useSessionMessageQuotes } from '../../features/sessions/acp/use-session-message-quotes';
import { finishRendererContentMenu, RENDERER_CONTENT_MENU_OPEN } from '@/lib/contentContextMenu';
import type { RendererContentContextMenu } from '@/lib/contentContextMenu';
import { platform } from '@/platform';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';

vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
vi.mock('@/platform', () => ({ platform: { writeClipboardText: vi.fn() } }));
let harness: ReturnType<typeof createReactHarness>;
afterEach(() => { harness?.cleanup(); document.getSelection()?.removeAllRanges(); vi.restoreAllMocks(); });

it.each(['backward', 'forward', 'single'] as const)('copies exactly the painted text for an Android %s selection', async direction => {
  vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('android');
  const store = { sessionId: 'task-a', setDraftText: vi.fn() } as unknown as AcpChatStore;
  function Harness() {
    const parent = useRef<HTMLDivElement>(null);
    const quotes = useSessionMessageQuotes(store, useRef(null));
    useEffect(() => {
      const context = createChatContext({ locale: () => 'en-US', theme: buildChatTheme(DEFAULT_CONFIG, { preset: 'double', userGutter: 48, agentConversation: true }) });
      const state = createChatState(context);
      state.transcript.history.seed([{ id: 'turn', seq: 1, initiator: 'user', items: [
        { kind: 'message', id: 'question', role: 'user', seq: 0, text: 'Previous user message words' },
        { kind: 'message', id: 'answer', role: 'assistant', seq: 1, text: '# Reply\n\nThe harbor stirred at dawn.\n\nBeyond the highlighted prefix. UNSELECTED-END' },
      ] }]);
      const view = createChatView({ context, state, parent: parent.current!, commands: { onMessageTextMount: quotes.onMessageTextMount } });
      return () => view.dispose();
    }, [quotes.onMessageTextMount]);
    return <div ref={parent} style={{ width: 390, height: 700 }} />;
  }
  harness = createReactHarness(); await harness.render(<Harness />);
  await until('both real message bodies mounted', () => !!harness.container.querySelector('[data-conversation-text="question"]') && !!harness.container.querySelector('[data-conversation-text="answer"]'));
  const before = harness.container.querySelector<HTMLElement>('[data-conversation-text="question"]')!;
  const answer = harness.container.querySelector<HTMLElement>('[data-conversation-text="answer"]')!;
  // The full assistive name remains available without putting a second copy in
  // the DOM range. WebView 117 serializes user-select:none text; current Chromium
  // skips it in Selection.toString(), which hid the original native regression.
  const walker = document.createTreeWalker(answer, NodeFilter.SHOW_TEXT);
  let node: Node | null; let paragraph: Text | undefined;
  while ((node = walker.nextNode())) if (node.textContent?.startsWith('The harbor')) { paragraph = node as Text; break; }
  expect(paragraph).toBeDefined();
  const selection = document.getSelection()!;
  selection.setBaseAndExtent(paragraph!, 4, paragraph!, 10);
  const capture = vi.fn(); window.addEventListener(RENDERER_CONTENT_MENU_OPEN, capture);
  try {
    answer.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(capture).toHaveBeenCalledOnce();
    const menu = (capture.mock.calls[0][0] as CustomEvent<RendererContentContextMenu>).detail;
    const previous = document.createTreeWalker(before, NodeFilter.SHOW_TEXT).nextNode()!;
    if (direction === 'single') selection.setBaseAndExtent(paragraph!, 0, paragraph!, 18);
    else if (direction === 'backward') selection.setBaseAndExtent(paragraph!, 18, previous, 0);
    else selection.setBaseAndExtent(previous, 0, paragraph!, 18);
    expect(selection.getRangeAt(0).toString()).not.toContain('UNSELECTED-END');
    expect(selection.toString()).not.toContain('UNSELECTED-END');
    await expect.element(page.getByRole('note', { name: /UNSELECTED-END/ })).toBeInTheDocument();
    finishRendererContentMenu(menu.requestId, 'copy'); await Promise.resolve();
    const copied = vi.mocked(platform.writeClipboardText).mock.calls.at(-1)![0];
    expect(copied).toBe(direction === 'single' ? 'The harbor stirred' : 'Previous user message words\n\n\nAgent\n\nReply\nThe harbor stirred');
  } finally { window.removeEventListener(RENDERER_CONTENT_MENU_OPEN, capture); }
});
