/** @jsxImportSource solid-js */
import { afterEach, expect, it } from 'vitest';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { createChatState } from '@session-chat/state/chat-state';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

const dispose: (() => void)[] = [];
afterEach(() => dispose.splice(0).forEach(fn => fn()));

// A streaming reply is several blocks: each settled chunk, a code block between runs, the growing tail. The caret is one, at the end of the last.
it('shows exactly one streaming caret, at the end of the text still being written (#1023)', async () => {
  const context = createChatContext();
  context.setLayout({ preset: 'double', userGutter: 72, agentConversation: true });
  const state = createChatState(context);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;width:800px;height:800px';
  document.body.append(host);
  const view = createChatView({ context, state, parent: host });
  dispose.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });
  state.transcript.activeTurn.set({ id: 'live', seq: 0, initiator: 'user', startedAt: Date.now(), items: [
    { kind: 'message', id: 'ask', seq: 0, role: 'user', text: 'Explain it.' },
    { kind: 'message', id: 'reply', seq: 1, role: 'assistant', text: 'First paragraph.\n\nSecond paragraph.\n\n```js\nrun()\n```\n\nFourth paragraph.\n\nFifth paragraph is still' },
  ] });
  await until('the streaming reply renders', () => host.textContent?.includes('Fifth paragraph is still') ?? false);
  await untilStable('transcript geometry settles', () => host.querySelector('[data-chat-canvas]')?.getBoundingClientRect().height);
  const carets = [...host.querySelectorAll('*')].filter(el => getComputedStyle(el, '::after').content.includes('▍'));
  expect(carets.map(el => el.textContent)).toEqual(['Fifth paragraph is still']);
});
