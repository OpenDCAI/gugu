/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it } from 'vitest';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { createChatState } from '@session-chat/state/chat-state';
import type { TranscriptItem, TranscriptTurn } from '@session-chat/model';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

const disposers: (() => void)[] = [];
afterEach(() => disposers.splice(0).forEach(dispose => dispose()));
const hook: TranscriptItem = { kind: 'session-notice', id: 'stop', seq: 4, code: 'provider-notice', title: 'Stop says: Check complete.', detail: 'Stop says: Check complete.', at: 4000 };
const bash = (command: string, seq = 2): Extract<TranscriptItem, { kind: 'execute-tool-call' }> => ({ kind: 'execute-tool-call', id: 'work', seq, toolCallId: 'work', toolName: 'Bash', command, title: command, status: 'done' });
function mount(items: TranscriptItem[], timestamped = true) {
  const context = createChatContext({ locale: () => 'en-US' });
  context.setLayout({ preset: 'double', userGutter: 72, agentConversation: true });
  const state = createChatState(context);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;width:900px;height:5000px';
  document.body.append(host);
  const view = createChatView({ context, state, parent: host, commands: { conversationAgentName: () => 'Fixture agent' } });
  disposers.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });
  const turn: TranscriptTurn = { id: 'review', seq: 0, initiator: 'user', ...(timestamped ? { startedAt: 1000, endedAt: 9000 } : {}),
    outcome: { kind: 'done' }, items: [{ kind: 'message', id: 'input', seq: 0, role: 'user', text: 'Run fixture.' }, ...items] };
  state.transcript.history.seed([turn]);
  return { host, state, settle: () => untilStable('review geometry settles', () => host.querySelector('[data-chat-canvas]')?.getBoundingClientRect().height) };
}
const reply = (text = 'Final reply.'): Extract<TranscriptItem, { kind: 'message' }> => ({ kind: 'message', id: 'answer', seq: 3, role: 'assistant', text, at: 3000 });

describe('process review boundaries', () => {
  it('keeps the full action name ahead of a long command at narrow widths', async () => {
    const v = mount([bash('echo long-command-'.repeat(80)), reply()]);
    v.state.viewState.setCollapsed('review:process', true);
    await until('the summary appears', () => v.host.querySelector('[data-slot="tool-run"]') !== null);
    v.host.querySelector<HTMLButtonElement>('[data-slot="tool-run"] [data-collapse-id]')!.click();
    await until('the command appears', () => v.host.querySelector('[data-conversation-step="work"]') !== null);
    for (const width of [420, 900]) {
      v.host.style.width = `${width}px`;
      await v.settle();
      const action = v.host.querySelector<HTMLElement>('[data-conversation-step="work"] > button > span:nth-of-type(2)')!;
      expect(action.textContent).toBe('Ran 1 shell command');
      expect(action.scrollWidth).toBeLessThanOrEqual(action.clientWidth + 1);
    }
  });

  it('does not create a trailing segment for a Stop with no continuation', async () => {
    const v = mount([reply('Important reply. '.repeat(100)), hook]);
    await until('the reply appears', () => v.host.querySelector('[data-user-card="answer"]') !== null);
    expect(v.host.querySelectorAll('[data-conversation-part="head"]')).toHaveLength(1);
    expect(v.host.querySelector('[data-conversation-terminal-reason]')).toBeNull();
    v.state.viewState.setCollapsed('review:process', true);
    await until('the hook is counted in the same segment', () => /triggered 1 hook/i.test(v.host.textContent ?? ''));
  });

  it('omits elapsed time for a replay Stop segment without authentic timestamps', async () => {
    const v = mount([{ ...reply('Before Stop.'), seq: 1, at: undefined }, { ...hook, seq: 2, at: undefined },
      { ...bash('echo continued', 3), at: undefined }, { ...reply(), id: 'after', seq: 4, at: undefined }], false);
    await until('both replay replies appear', () => v.host.querySelectorAll('[data-conversation-part="head"]').length === 2);
    const heads = [...v.host.querySelectorAll<HTMLElement>('[data-conversation-process]')];
    expect(heads).toHaveLength(2);
    for (const head of heads) expect(head.textContent).not.toMatch(/\d+s/);
    expect(heads[1].textContent).toContain('1 step');
  });

  it.each([false, true])('preserves a long sent reply before Stop, with continuation=%s', async continuation => {
    const text = 'A sent reply that must remain readable. '.repeat(70);
    const send: TranscriptItem = { kind: 'mcp-tool-call', id: 'send', seq: 1, toolCallId: 'send', title: 'message_send', toolName: 'mcp__gugu__message_send', server: 'gugu', tool: 'message_send', status: 'done',
      rawInput: JSON.stringify({ chat_id: 'other', text }), outputText: 'sent (id=msg:00000000-0000-4000-8000-000000000991)', at: 2000, completedAt: 3000 };
    const v = mount([send, { kind: 'message', id: 'silence', seq: 3, role: 'assistant', text: '[NO_REPLY]' }, hook,
      ...(continuation ? [bash('echo continued', 5), { ...reply(), seq: 6 }] : [])]);
    await until('the sent bubble appears', () => v.host.querySelector('[data-user-card*="send:sent:"]') !== null);
    const bubble = v.host.querySelector<HTMLElement>('[data-user-card*="send:sent:"]')!;
    expect(bubble.offsetHeight).toBeGreaterThan(252);
    expect(v.host.querySelectorAll('[data-conversation-part="head"]')).toHaveLength(continuation ? 2 : 1);
  });

  it('does not disclose or duplicate short narration or a fully visible command', async () => {
    const v = mount([{ kind: 'message', id: 'short', seq: 1, role: 'assistant', text: 'Short visible fact.' }, bash('echo short'), reply()]);
    v.state.viewState.setCollapsed('review:process', true);
    await until('the short narration appears', () => v.host.querySelector('[data-conversation-narration="short"]') !== null);
    const button = v.host.querySelector<HTMLButtonElement>('[data-conversation-narration="short"] button')!;
    expect(button.disabled).toBe(true);
    expect(getComputedStyle(button).cursor).not.toBe('pointer');
    button.click();
    expect(v.host.querySelectorAll('[data-conversation-narration="short"]')).toHaveLength(1);
    v.state.viewState.setCollapsed('review:process', true);
    v.host.querySelector<HTMLButtonElement>('[data-slot="tool-run"] [data-collapse-id]')!.click();
    await until('the short command appears', () => v.host.querySelector('[data-conversation-step="work"]') !== null);
    const command = v.host.querySelector<HTMLButtonElement>('[data-conversation-step="work"] > button')!;
    expect(command.disabled).toBe(true);
    expect(getComputedStyle(command).cursor).not.toBe('pointer');
  });
});
