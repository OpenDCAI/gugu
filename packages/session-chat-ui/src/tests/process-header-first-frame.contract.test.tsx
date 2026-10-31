/** @jsxImportSource solid-js */
import { afterEach, expect, it } from 'vitest';
import { createChatContext } from '@session-chat/chat-context';
import { createChatState } from '@session-chat/state/chat-state';
import { createChatView } from '@session-chat/chat-view';
import type { TranscriptTurn } from '@session-chat/model';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

const teardown: (() => void)[] = [];
afterEach(() => teardown.splice(0).forEach(dispose => dispose()));

const longInput = '还有一个 bug，我不知道之前有没有跟你说过：\n\n发消息刚开始处理，还没有 tool call 的时候，这里会被边缘模糊给覆盖掉。\n\n后面正式开始运行的时候好像没覆盖了，这是一个过程中的小毛病。';

it.each([
  { text: 'Check the weather in LA.', padTop: 32 },
  { text: longInput, padTop: 32 },
  { text: longInput, padTop: 32.8 },
])('keeps the no-tool first header clear of the pinned question ($padTop, $text)', async ({ text, padTop }) => {
  const context = createChatContext();
  context.setLayout({ preset: 'double', userGutter: 0, agentConversation: true });
  const state = createChatState(context);
  const host = document.createElement('div');
  // The long question puts the header in the middle, away from any viewport edge fade (#1129).
  host.style.cssText = 'position:fixed;top:100px;left:0;width:600px;height:800px';
  document.body.append(host);
  const view = createChatView({ context, state, parent: host, pinUserMessages: true, padTop, padBottom: 140,
    commands: { conversationAgentName: () => 'Fixture agent' } });
  teardown.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });
  const startedAt = Date.now() - 4000;
  state.transcript.history.seed([{ id: 'previous', seq: 0, initiator: 'user', startedAt: startedAt - 20000,
    endedAt: startedAt - 10000, outcome: { kind: 'done' }, items: [
      { kind: 'message', id: 'previous-input', seq: 0, role: 'user', text: 'Earlier question.' },
      { kind: 'message', id: 'previous-reply', seq: 1, role: 'assistant', text: 'Earlier answer.' },
    ] }]);
  const input = { kind: 'message' as const, id: 'input', seq: 0, role: 'user' as const, text };
  const turn = (items: TranscriptTurn['items']): TranscriptTurn => ({ id: 'live', seq: 1, initiator: 'user', startedAt, items });
  state.transcript.activeTurn.set(turn([input]));
  const header = () => host.querySelector<HTMLElement>('[data-slot="turn-process"][data-turn-id="live"]')!;
  const lane = () => host.querySelector<HTMLElement>('[data-user-card="input"]')!.closest<HTMLElement>('[data-index]')!;
  await until('the no-tool header renders', () => !!header());
  await untilStable('the no-tool layout settles', () => header().getBoundingClientRect().top);

  const clearOfPin = () => {
    const head = header().getBoundingClientRect();
    // contain:paint clips the pinned backdrop/fade at this lane's end. A nonzero
    // overlap is a real painted obstruction, even with pointer-events:none.
    const containment = getComputedStyle(lane()).contain.split(' ');
    expect(containment.some(value => ['paint', 'content', 'strict'].includes(value))).toBe(true);
    expect(getComputedStyle(lane().firstElementChild!).position).toBe('sticky');
    expect(lane().getBoundingClientRect().bottom, 'the pin paint ends before the process header').toBeLessThanOrEqual(head.top + 0.5);
    expect(header().offsetHeight).toBe(28);
    for (let el: HTMLElement | null = header(); el && host.contains(el); el = el.parentElement) {
      expect(getComputedStyle(el).opacity).toBe('1');
      expect(getComputedStyle(el).maskImage).toBe('none');
    }
  };
  expect(header().getBoundingClientRect().top - host.getBoundingClientRect().top).toBeGreaterThan(70);
  expect(host.querySelector('[data-slot="conversation-process-steps"]')).toBeNull();
  expect(header().querySelector<HTMLButtonElement>('[data-conversation-process]')!.disabled).toBe(true);
  clearOfPin();
  const before = host.querySelector<HTMLElement>('[data-user-card="input"]')!.getBoundingClientRect().top;
  state.transcript.activeTurn.set(turn([input, { kind: 'execute-tool-call', id: 'tool', seq: 1,
    toolCallId: 'tool', toolName: 'Bash', command: 'echo fixture', title: 'echo fixture', status: 'running' }]));
  await untilStable('the first-tool layout settles', () => header().getBoundingClientRect().top);
  expect(header().querySelector<HTMLButtonElement>('[data-conversation-process]')!.disabled).toBe(false);
  expect(host.querySelector('[data-slot="conversation-process-steps"]')).not.toBeNull();
  clearOfPin();
  expect(host.querySelector<HTMLElement>('[data-user-card="input"]')!.getBoundingClientRect().top).toBeCloseTo(before, 0);
});
