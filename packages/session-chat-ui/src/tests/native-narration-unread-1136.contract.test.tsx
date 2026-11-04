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
  const context = createChatContext({ locale: () => 'en-US' });
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

  it.each([false, true])('does not move a new model process viewport with old identity navigation (queued=%s)', async queued => {
    const context = createChatContext({ locale: () => 'en-US' });
    context.setLayout({ preset: 'double', userGutter: 0, agentConversation: true });
    const a = createChatState(context), b = createChatState(context);
    const turn = (count: number): TranscriptTurn => ({ id: 't', seq: 1, initiator: 'user', outcome: { kind: 'done' }, items: [
      { kind: 'message', id: 'input', seq: 0, role: 'user', text: 'Please investigate.' },
      ...Array.from({ length: count }, (_, i) => ({ kind: 'message' as const, id: i === 0 ? 'intermediate' : `m${i}`, seq: i + 1, role: 'assistant' as const, text: `Intermediate ${i}` })),
      { kind: 'mcp-tool-call', id: 'send', seq: count + 1, toolCallId: 'send', server: 'gugu', tool: 'message_send', title: 'message_send', status: 'done',
        rawInput: JSON.stringify({ chat_id: 'elsewhere', text: 'Sent.' }), rawOutput: 'sent (id=msg:11111111-1111-4111-8111-111111111111)' },
    ] });
    a.transcript.history.seed([turn(1)]); b.transcript.history.seed([turn(30)]);
    b.viewState.setCollapsed('t:process', true);
    b.parseCaches.processScrollPositions.set('t:process:done', { top: 200, atEnd: false });
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:760px;height:600px';
    document.body.append(host);
    const view = createChatView({ context, state: a, parent: host });
    cleanup = () => { view.dispose(); a.dispose(); b.dispose(); context.dispose(); host.remove(); };
    const frame = () => new Promise<void>(done => requestAnimationFrame(() => done()));
    await until('model A paints', () => !!host.querySelector('[data-agent-conversation-message]'));
    if (queued) expect(view.revealItem('intermediate')).toBe(true);
    await frame();
    view.setModel(b);
    await Promise.resolve();
    const viewport = host.querySelector<HTMLElement>('[data-slot="conversation-process-steps"]')!;
    expect(viewport).not.toBeNull();
    viewport.scrollTop = 200;
    expect(viewport.scrollTop).toBe(200);
    await frame();
    expect(viewport.scrollTop, 'old navigation must not move the new model').toBe(200);
  });
});
