/** @jsxImportSource solid-js */
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { createChatState } from '@session-chat/state/chat-state';
import type { TranscriptTurn } from '@session-chat/model';
import { describe, expect, it } from 'vitest';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

describe('native reply after a file input', () => {
  it.each([390, 1280])('scrolls the input clear of its reply header at width %i, including remount', async width => {
    const context = createChatContext({ locale: () => 'en-US', layout: { agentConversation: true, preset: 'double', userGutter: 0 } });
    const state = createChatState(context);
    const turn: TranscriptTurn = {
      id: 'native-file-turn', seq: 0, initiator: 'user', outcome: { kind: 'done' },
      items: [
        { kind: 'message', id: 'file-input', seq: 0, role: 'user',
          text: '@[checklist.txt](/tmp/checklist.txt)\n\n手机原生发文件：请只回复「收到文件」，不要调用任何工具。' },
        { kind: 'message', id: 'file-answer', seq: 1, role: 'assistant', text: '收到文件' },
      ],
    };
    state.transcript.history.seed([turn, ...Array.from({ length: 8 }, (_, i): TranscriptTurn => ({
      id: `later-${i}`, seq: i + 1, initiator: 'user', outcome: { kind: 'done' }, items: [
        { kind: 'message', id: `question-${i}`, seq: 0, role: 'user', text: `Later question ${i}` },
        { kind: 'message', id: `answer-${i}`, seq: 1, role: 'assistant', text: `Later answer ${i}` },
      ],
    }))]);
    const host = document.body.appendChild(document.createElement('div'));
    host.style.cssText = `position:fixed;top:${width === 390 ? 118 : 45}px;left:0;width:${width}px;height:650px`;
    const mount = () => createChatView({ context, state, parent: host, pinUserMessages: true, stickToBottom: false });
    let view = mount();
    try {
      for (let pass = 0; pass < 2; pass++) {
        await until('the file reply is mounted', () => !!host.querySelector('[data-agent-conversation-message="native-file-turn:process:head"]'));
        expect(host.querySelector('[data-agent-conversation-message="file-input"] [data-kind="file"]')).not.toBeNull();
        view.setScrollMode({ kind: 'anchor', itemId: 'native-file-turn:process:head', edge: 'top', offset: -8 });
        const input = () => host.querySelector<HTMLElement>('[data-agent-conversation-message="file-input"]')!;
        const head = () => host.querySelector<HTMLElement>('[data-agent-conversation-message="native-file-turn:process:head"]')!;
        await untilStable('the anchored file turn settles', () => [input()?.getBoundingClientRect().bottom, head()?.getBoundingClientRect().top]);
        const lane = input().closest<HTMLElement>('[data-index]')!;
        expect(head().getBoundingClientRect().top - lane.getBoundingClientRect().top,
          'the virtualizer reserved the full input height').toBeGreaterThanOrEqual(input().getBoundingClientRect().height - 1);
        expect(input().getBoundingClientRect().bottom,
          'the sticky input must stop before its native reply header').toBeLessThanOrEqual(head().getBoundingClientRect().top + 1);
        if (pass === 0) { view.dispose(); view = mount(); }
      }
    } finally {
      view.dispose(); state.dispose(); context.dispose(); host.remove();
    }
  });
});
