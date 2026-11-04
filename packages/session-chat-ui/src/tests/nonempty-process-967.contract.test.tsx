/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it } from 'vitest';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { createChatState } from '@session-chat/state/chat-state';
import type { TranscriptTurn } from '@session-chat/model';
import { until, untilStable } from '../../../../tests/support/awaitCondition';
import fixture from './fixtures/nonempty-process-967.json';

// Only the reported native round: private text, identities and destinations were
// replaced. Its event order, clocks, tool kinds and successful sends are retained.
const recorded = fixture as TranscriptTurn[];
const processId = `${recorded[0].id}:process`;
const disposers: (() => void)[] = [];
afterEach(() => disposers.splice(0).forEach(dispose => dispose()));

function mount() {
  const context = createChatContext({ locale: () => 'en-US' });
  context.setLayout({ preset: 'double', userGutter: 72, agentConversation: true });
  const state = createChatState(context);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;width:900px;height:1200px';
  document.body.append(host);
  const view = createChatView({ context, state, parent: host });
  disposers.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });
  const header = () => host.querySelector<HTMLButtonElement>(`[data-conversation-process="${processId}"]`)!;
  const steps = () => host.querySelector<HTMLElement>(`[data-process-id="${processId}:steps"]`);
  const settle = () => untilStable('process layout settles', () => [host.querySelector('[data-chat-canvas]')?.childElementCount, host.querySelector<HTMLElement>('[data-chat-canvas]')?.offsetHeight]);
  const append = (seq: number) => state.transcript.history.append([{
    id: `later-${seq}`, seq, initiator: 'user', outcome: { kind: 'done' }, items: [
      { kind: 'message', id: `later-input-${seq}`, seq: 0, role: 'user', text: 'Another update.' },
      { kind: 'message', id: `later-output-${seq}`, seq: 1, role: 'assistant', text: 'Acknowledged.' },
    ],
  }]);
  state.transcript.history.seed(recorded);
  return { host, state, view, header, steps, settle, append };
}

describe('historical process disclosure after new turns', () => {
  it('reveals the recorded process when a later reply has already been appended', async () => {
    const v = mount();
    await until('original header mounts', () => v.header() !== null);
    v.append(1);
    await v.settle();
    v.header().click();
    await until('old header is expanded', () => v.header().getAttribute('aria-expanded') === 'true');
    await v.settle();
    expect(v.steps()).not.toBeNull();
    expect(v.steps()!.textContent).toContain('Called 1 MCP tool');
    expect(v.steps()!.querySelector('[data-slot="tool-run"]')?.getAttribute('data-step-count')).toBe('1');
    expect(v.steps()!.textContent).not.toContain('message_conversations');
    expect(v.steps()!.offsetHeight).toBeGreaterThan(0);
  });

  it('can collapse and reopen an older process across successive appends', async () => {
    const v = mount();
    await until('original header mounts', () => v.header() !== null);
    v.header().click();
    await until('initial process opens', () => v.steps() !== null);
    v.append(1);
    await v.settle();
    v.header().click();
    await until('old header is collapsed', () => v.header().getAttribute('aria-expanded') === 'false');
    await v.settle();
    expect(v.steps()).toBeNull();
    v.append(2);
    await v.settle();
    v.header().click();
    await v.settle();
    expect(v.steps()).not.toBeNull();
    expect(v.steps()!.textContent).toContain('Called 1 MCP tool');
    expect(v.steps()!.textContent).not.toContain('message_conversations');
  });

  it('keeps send-only segments non-expandable without losing their step counts or bubbles', async () => {
    const v = mount();
    await until('send bubbles mount', () => v.host.textContent?.includes('Sent status update.'));
    const sent = [...v.host.querySelectorAll<HTMLButtonElement>('[data-conversation-process]')].filter(button => button.disabled && button.textContent?.includes('1 step'));
    expect(sent).toHaveLength(3);
    for (const button of sent) {
      expect(button.hasAttribute('data-collapse-id')).toBe(false);
      expect(button.hasAttribute('aria-expanded')).toBe(false);
      expect(button.querySelector('span[aria-hidden]')).toBeNull();
    }
    expect(v.host.querySelectorAll('[data-agent-conversation-message][data-side="left"] [data-user-card]')).toHaveLength(4);
  });
});
