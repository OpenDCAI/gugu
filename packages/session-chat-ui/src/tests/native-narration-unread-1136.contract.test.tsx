import { afterEach, describe, expect, it } from 'vitest';
import { createChatContext } from '@session-chat/chat-context';
import { createChatState } from '@session-chat/state/chat-state';
import { createChatView } from '@session-chat/chat-view';
import type { ChatView } from '@session-chat/chat-view';
import type { TranscriptTurn } from '@session-chat/model';
import { until } from '../../../../tests/support/awaitCondition';

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function mount(text = 'Checking the original request.') {
  const context = createChatContext();
  context.setLayout({ preset: 'double', userGutter: 0, agentConversation: true });
  const state = createChatState(context);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;width:760px;height:600px';
  document.body.appendChild(host);
  const turn: TranscriptTurn = { id: 't', seq: 1, initiator: 'user', outcome: { kind: 'done' }, items: [
    { kind: 'message', id: 'input', seq: 1, role: 'user', text: 'Please investigate.' },
    { kind: 'message', id: 'intermediate', seq: 2, role: 'assistant', text },
    { kind: 'mcp-tool-call', id: 'send', seq: 3, toolCallId: 'send', server: 'gugu', tool: 'message_send',
      title: 'message_send', status: 'done', rawInput: JSON.stringify({ chat_id: 'elsewhere', text: 'Investigation sent.' }),
      rawOutput: 'sent (id=msg:11111111-1111-4111-8111-111111111111)' },
  ] };
  state.transcript.history.seed([turn]);
  const view = createChatView({ context, state, parent: host });
  cleanup = () => { view.dispose(); state.dispose(); context.dispose(); host.remove(); };
  return { state, host, view };
}

describe('native unread intermediate replies (#1136)', () => {
  it('reports a readable narration with its original message identity', async () => {
    const { state, host } = mount();
    state.viewState.setCollapsed('t:process', true);
    await until('the process narration mounts', () => !!host.querySelector('[data-conversation-narration="intermediate"]'));
    expect(host.querySelector('[data-conversation-narration="intermediate"]')?.getAttribute('data-agent-conversation-message')).toBe('intermediate');
  });

  it('reveals the exact unread item through its closed process before positioning it', async () => {
    const { host, view } = mount();
    await until('the sent reply mounts', () => !!host.querySelector('[data-agent-conversation-message]'));
    expect(host.querySelector('[data-conversation-narration="intermediate"]')).toBeNull();
    expect((view as ChatView & { revealItem(id: string): boolean }).revealItem('intermediate')).toBe(true);
    await until('the original unread narration is exposed', () => !!host.querySelector('[data-agent-conversation-message="intermediate"]'));
    expect((view as ChatView & { revealItem(id: string): boolean }).revealItem('unloaded-item')).toBe(false);
  });

  it('keeps truncated narration ineligible until its full text is revealed', async () => {
    const { state, host } = mount('A complete intermediate statement. '.repeat(40));
    state.viewState.setCollapsed('t:process', true);
    await until('long narration mounts', () => !!host.querySelector('[data-conversation-narration="intermediate"]'));
    expect(host.querySelector('[data-agent-conversation-message="intermediate"]')).toBeNull();
    host.querySelector<HTMLButtonElement>('[data-conversation-narration="intermediate"] button')!.click();
    await until('the complete narration is eligible', () => !!host.querySelector('[data-agent-conversation-message="intermediate"]'));
  });
});
