/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it } from 'vitest';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { createChatState } from '@session-chat/state/chat-state';
import type { TranscriptItem, TranscriptTurn } from '@session-chat/model';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

const disposers: (() => void)[] = [];
afterEach(() => disposers.splice(0).forEach(dispose => dispose()));
const bash = (id: string, seq: number): TranscriptItem => ({ kind: 'execute-tool-call', id, seq,
  toolCallId: id, title: `echo ${id}`, command: `echo ${id}`, status: 'done' });
function mount(items: TranscriptItem[], reply: string | null = 'Fixture done.') {
  const context = createChatContext({ locale: () => 'en-US' });
  context.setLayout({ preset: 'double', userGutter: 72, agentConversation: true });
  const state = createChatState(context);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;width:900px;height:5000px';
  document.body.append(host);
  const view = createChatView({ context, state, parent: host, commands: { conversationAgentName: () => 'Fixture agent' } });
  disposers.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });
  const turn: TranscriptTurn = { id: 'hooks', seq: 0, initiator: 'user', startedAt: 1000, endedAt: 9000,
    outcome: { kind: 'done' }, items: [
      { kind: 'message', id: 'input', seq: 0, role: 'user', text: 'Run the fixture.' },
      ...items,
      ...(reply === null ? [] : [{ kind: 'message' as const, id: 'reply', seq: 99, role: 'assistant' as const, text: reply }]),
    ] };
  state.transcript.history.seed([turn]);
  state.viewState.setCollapsed('hooks:process', true);
  return { host, state, settle: () => untilStable('process rows settle', () => host.querySelector('[data-chat-canvas]')?.getBoundingClientRect().height) };
}

describe('conversation hooks remain semantic process steps', () => {
  it.each(['background-command-done-tool-call', 'subagent-done-tool-call'] as const)('keeps %s independent of the reply header', async kind => {
    const command = 'cd fixture-directory && export PATH=fixture-path; echo RAW-WAKE-991';
    const base = { id: 'wake', seq: 1, toolCallId: 'wake', launchToolCallId: 'launch', name: command,
      title: command, summary: command, status: 'done' as const, outcome: 'completed' as const };
    const source: TranscriptItem = kind === 'subagent-done-tool-call' ? { ...base, kind, agentId: 'child' } : { ...base, kind };
    const v = mount([source]);
    await until('the reply appears', () => v.host.textContent?.includes('Fixture done.') === true);
    const head = v.host.querySelector<HTMLElement>('[data-conversation-part="head"]')!;
    expect(head.textContent).toBe('Fixture agent');
    expect(head.querySelector('[data-slot="conversation-quote"]')).toBeNull();
    const completion = v.host.querySelector<HTMLElement>('[data-conversation-step="wake"]')!;
    expect(completion.textContent).toContain('RAW-WAKE-991');
    expect(completion.closest('[data-slot="conversation-process-steps"]')).toBeNull();
    expect(completion.getBoundingClientRect().bottom).toBeLessThanOrEqual(head.getBoundingClientRect().top + 1);
    expect(v.host.textContent).not.toContain('Bash');
  });

  it('keeps an independent long completion measured through resizing, disclosure and process folding', async () => {
    const summary = 'cd fixture-workspace && echo checking-a-long-command-line '.repeat(18);
    const v = mount([
      { kind: 'thinking', id: 'first', seq: 1, segmentId: 'first', startedAt: 2000, text: '', status: 'done' },
      { kind: 'background-command-done-tool-call', id: 'completed', seq: 2, toolCallId: 'completed', launchToolCallId: 'launch',
        name: summary, title: summary, summary, status: 'done', outcome: 'completed' },
      { kind: 'thinking', id: 'second', seq: 3, segmentId: 'second', startedAt: 4000, text: 'The next step.', status: 'done' },
    ]);
    await until('the reply appears', () => v.host.textContent?.includes('Fixture done.') === true);
    const completion = () => v.host.querySelector<HTMLElement>('[data-conversation-step="completed"]')!;
    const noOverlap = () => {
      const row = completion();
      expect(row.closest('[data-slot="conversation-process-steps"]')).toBeNull();
      const head = v.host.querySelector<HTMLElement>('[data-conversation-part="head"]')!;
      expect(row.getBoundingClientRect().bottom).toBeLessThanOrEqual(head.getBoundingClientRect().top + 1);
      const text = row.lastElementChild!.getBoundingClientRect();
      const bounds = row.getBoundingClientRect();
      expect(text.top).toBeGreaterThanOrEqual(bounds.top - 1);
      expect(text.bottom).toBeLessThanOrEqual(bounds.bottom + 1);
    };
    for (const width of [900, 500, 1200, 900]) {
      v.host.style.width = `${width}px`;
      await untilStable('resized completion settles', () => completion()?.getBoundingClientRect().width);
      noOverlap();
    }
    completion().querySelector<HTMLButtonElement>('[data-collapse-id]')!.click();
    await until('the completion opens', () => completion().offsetHeight > 32);
    await v.settle();
    expect(completion().textContent).toContain(summary.trim());
    for (const width of [500, 1200]) {
      v.host.style.width = `${width}px`;
      await untilStable('expanded completion remeasures', () => completion()?.getBoundingClientRect().height);
      noOverlap();
    }
    completion().querySelector<HTMLButtonElement>('[data-collapse-id]')!.click();
    await until('the completion closes', () => completion().offsetHeight === 32);
    // Folding either adjacent process never hides this event or attaches it to the reply.
    for (const expanded of [false, true]) {
      v.state.viewState.setCollapsed('hooks:process', expanded);
      v.state.viewState.setCollapsed('hooks:process@completed', expanded);
      await v.settle();
      expect(completion().offsetHeight).toBe(32);
      expect(v.host.querySelector('[data-slot="conversation-quote"]')).toBeNull();
      noOverlap();
    }
  });

  it.each(['notice', 'legacy'] as const)('keeps the reply before a %s Stop hook in its own bubble and starts a new segment', async mode => {
    const longReply = 'The first reply contains an important detail.\n\n'.repeat(35) + 'The final important detail.';
    const hook: TranscriptItem = mode === 'notice'
      ? { kind: 'session-notice', id: 'stop-hook', seq: 3, code: 'provider-notice', title: 'Stop says: Check the fixture.', detail: 'Stop says: Check the fixture.', at: 4000 }
      : { kind: 'message', id: 'stop-hook', seq: 3, role: 'assistant', text: '**Notice:** Stop says: Check the fixture.', at: 4000 };
    const v = mount([bash('before', 1), { kind: 'message', id: 'before-stop', seq: 2, role: 'assistant', text: longReply, at: 3000 }, hook, bash('after', 4)]);
    await until('the final reply appears', () => v.host.textContent?.includes('Fixture done.') === true);
    await v.settle();
    expect(v.host.querySelector('[data-agent-conversation-message="before-stop"][data-conversation-part="body"]')).not.toBeNull();
    const bubble = v.host.querySelector<HTMLElement>('[data-user-card="before-stop"]')!;
    expect(bubble.offsetHeight).toBeGreaterThan(252);
    expect(v.host.querySelector('[data-expand-user-card="before-stop"]')).toBeNull();
    const heads = [...v.host.querySelectorAll<HTMLElement>('[data-conversation-part="head"]')];
    expect(heads).toHaveLength(2);
    expect(heads[0].textContent).toContain('Fixture agent');
    expect(heads[1].textContent).not.toContain('Fixture agent');
    expect(heads[1].querySelector('[data-conversation-process]')).not.toBeNull();
    v.state.viewState.setCollapsed('hooks:process@stop-hook', true);
    await until('the hook summary appears', () => v.host.textContent?.includes('triggered 1 hook') === true);
    expect(v.host.textContent).not.toContain('Stop says:');
    expect(v.host.textContent).not.toContain('Bash');
  });

  it('lets a truncated narration open its full text and keeps the next row below it', async () => {
    const text = 'An observable intermediate detail. '.repeat(50) + 'Narration ending.';
    const v = mount([{ kind: 'message', id: 'narration', seq: 1, role: 'assistant', text }, bash('after', 2)]);
    await until('the reply appears', () => v.host.textContent?.includes('Fixture done.') === true);
    const row = v.host.querySelector<HTMLElement>('[data-conversation-narration="narration"]')!;
    const trigger = row.querySelector<HTMLButtonElement>('[data-collapse-id]');
    expect(trigger).not.toBeNull();
    trigger!.click();
    await until('the full narration opens', () => v.host.querySelector('[data-conversation-narration="narration"]')?.textContent?.includes('Narration ending.') === true);
    await v.settle();
    const full = v.host.querySelector<HTMLElement>('[data-conversation-narration="narration"]')!;
    expect(full.offsetHeight).toBeGreaterThan(32);
    const next = v.host.querySelector<HTMLElement>('[data-slot="tool-run"]')!;
    expect(full.getBoundingClientRect().bottom).toBeLessThanOrEqual(next.getBoundingClientRect().top + 1);
  });

  it('keeps a final Stop-only reason visible outside its counted summary and lets it open', async () => {
    const text = 'The fixture check still needs attention. '.repeat(40) + 'Stop reason ending.';
    const v = mount([bash('before', 1), { kind: 'session-notice', id: 'last-stop', seq: 2, code: 'provider-notice', title: `Stop says: ${text}`, detail: `Stop says: ${text}`, at: 5000 }], null);
    await until('the process appears', () => v.host.querySelector('[data-conversation-process]') !== null);
    const reason = v.host.querySelector<HTMLElement>('[data-conversation-terminal-reason]');
    expect(reason).not.toBeNull();
    expect(reason!.closest('[data-slot="conversation-process-steps"]')).toBeNull();
    expect(v.host.textContent).toMatch(/triggered 1 hook/i);
    expect(v.host.textContent).not.toContain('Stop says:');
    reason!.querySelector<HTMLButtonElement>('[data-collapse-id]')!.click();
    await until('the full reason opens', () => v.host.querySelector('[data-conversation-terminal-reason]')?.textContent?.includes('Stop reason ending.') === true);
    expect(v.host.querySelector<HTMLElement>('[data-conversation-terminal-reason]')!.offsetHeight).toBeGreaterThan(32);
  });

  it('counts SessionStart without splitting the reply or exposing a standalone hook row', async () => {
    const v = mount([bash('before', 1), { kind: 'message', id: 'narration', seq: 2, role: 'assistant', text: 'Still working.' },
      { kind: 'session-notice', id: 'start-hook', seq: 3, code: 'provider-notice', title: 'SessionStart:compact says: Context ready.', detail: 'SessionStart:compact says: Context ready.', at: 4000 }, bash('after', 4)]);
    await until('the reply appears', () => v.host.textContent?.includes('Fixture done.') === true);
    await v.settle();
    expect(v.host.querySelectorAll('[data-conversation-part="head"]')).toHaveLength(1);
    expect(v.host.querySelector('[data-agent-conversation-message="narration"][data-conversation-part="body"]')).toBeNull();
    expect(v.host.textContent).toMatch(/triggered 1 hook/i);
    expect(v.host.textContent).not.toContain('SessionStart:compact says:');
    expect(v.host.querySelector('[data-slot="hook-notice"]')).toBeNull();
  });

  it.each(['notice', 'legacy'] as const)('counts a %s hook between commands without exposing the final single Bash row', async mode => {
    const hook: TranscriptItem = mode === 'notice'
      ? { kind: 'session-notice', id: 'hook', seq: 2, code: 'provider-notice', title: 'Stop says: Check the fixture.', detail: 'Stop says: Check the fixture.', at: 3000 }
      : { kind: 'message', id: 'hook', seq: 2, role: 'assistant', text: '**Notice:** Stop says: Check the fixture.' };
    const v = mount([bash('before', 1), hook, bash('after', 3)]);
    v.state.viewState.setCollapsed('hooks:process@hook', true);
    await until('the reply appears', () => v.host.textContent?.includes('Fixture done.') === true);
    await v.settle();
    const runs = [...v.host.querySelectorAll<HTMLElement>('[data-slot="tool-run"]')];
    expect(runs).toHaveLength(2);
    expect(runs[0].textContent).toMatch(/ran 1 shell command/i);
    expect(runs[1].textContent).toMatch(/ran 1 shell command, triggered 1 hook/i);
    expect(v.host.textContent).not.toContain('Stop says:');
    expect(v.host.textContent).not.toContain('Bash');
    expect(v.host.querySelector('[data-conversation-step]')).toBeNull();
    runs[1].querySelector<HTMLButtonElement>('[data-collapse-id]')!.click();
    await v.settle();
    expect(v.host.textContent).toContain('Check the fixture.');
    expect(v.host.textContent).not.toContain('Stop says:');
    expect(v.host.textContent).not.toContain('Bash');
  });

  it('omits the repeated name and retains a factual process header after sends to another destination', async () => {
    const v = mount([
      { kind: 'mcp-tool-call', id: 'call', seq: 1, toolCallId: 'call', title: 'message_send', status: 'done', server: 'gugu', tool: 'message_send',
        rawInput: JSON.stringify({ chat_id: 'other', text: 'Sent elsewhere.' }),
        outputText: 'sent (id=msg:00000000-0000-4000-8000-000000000977)' },
    ]);
    await until('the local reply appears', () => v.host.textContent?.includes('Fixture done.') === true);
    await v.settle();
    const left = [...v.host.querySelectorAll<HTMLElement>('[data-agent-conversation-message][data-side="left"]')];
    const body = left.findIndex(el => el.dataset.agentConversationMessage === 'reply');
    expect(body).toBeGreaterThan(0);
    expect(left[body - 1].dataset.conversationPart).toBe('head');
    expect(left[body - 1].textContent).not.toContain('Fixture agent');
    expect(left[body - 1].querySelector('[data-conversation-process]')).not.toBeNull();
  });
});
