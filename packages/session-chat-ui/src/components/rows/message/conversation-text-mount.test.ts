// @vitest-environment jsdom
import { createComponent } from 'solid-js';
import { render } from 'solid-js/web';
import { expect, it, vi } from 'vitest';
import { CommandsContext } from '../../contexts/CommandsContext';
import { UserMessageCard } from './UserMessageCard';
import type { ChatMessage } from '../../../model';

it('gives the host the conversation body root and releases its observer on unmount', () => {
  const cleanup = vi.fn();
  const mount = vi.fn((_target: { root: HTMLElement; message: () => ChatMessage }) => cleanup);
  const commands = { conversationAgentName: () => 'Agent', onMessageTextMount: mount };
  const data: ChatMessage = { kind: 'message', id: 'answer-1', role: 'assistant', text: 'Alpha\n\nBeta' };
  const host = document.createElement('div'); document.body.append(host);
  const dispose = render(() => createComponent(CommandsContext.Provider, {
    value: () => commands,
    get children() { return createComponent(UserMessageCard, {
      data, conversation: true, ctx: { viewState: { isCollapsed: () => false } },
      vars: { cardBorder: 0, collapsedMaxH: 200, expandedMaxH: 1000, userCardPadX: 16, userCardPadY: 12, attachThumb: 80, attachGap: 6, footerH: 16 },
    }); },
  }), host);
  try {
    expect(mount).toHaveBeenCalledOnce();
    const target = mount.mock.calls[0][0];
    expect(target.message()).toBe(data);
    expect(target.root).toBe(host.querySelector('[data-conversation-text="answer-1"]'));
    expect(target.root.querySelector('[data-user-message-actions]')).toBeNull();
  } finally { dispose(); host.remove(); }
  expect(cleanup).toHaveBeenCalledOnce();
});
