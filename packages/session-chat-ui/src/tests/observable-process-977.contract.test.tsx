/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it } from 'vitest';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { createChatState } from '@session-chat/state/chat-state';
import type { TranscriptItem, TranscriptTurn } from '@session-chat/model';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

const disposers: (() => void)[] = [];
afterEach(() => disposers.splice(0).forEach(dispose => dispose()));
const nativeName = 'mcp__plugin_gugu-product_gugu__message_send';
const pending: TranscriptItem = { kind: 'mcp-tool-call', id: 'send', seq: 1, toolCallId: 'send',
  title: nativeName, tool: 'message_send', server: 'plugin_gugu-product_gugu', status: 'running',
  rawInput: JSON.stringify({ chat_id: '977', text: 'Status update.' }) };

function mount(items: TranscriptItem[], trigger?: TranscriptTurn['trigger']) {
  const context = createChatContext();
  context.setLayout({ preset: 'double', userGutter: 72, agentConversation: true });
  const state = createChatState(context);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;width:900px;height:1000px';
  document.body.append(host);
  const view = createChatView({ context, state, parent: host, commands: { conversationClock: () => 22000 } });
  disposers.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });
  state.transcript.activeTurn.set({ id: 'live', seq: 0, initiator: trigger ? 'agent' : 'user',
    startedAt: 1000, ...(trigger ? { trigger } : {}), items });
  return { host, state, settle: () => untilStable('process layout settles', () => host.querySelector('[data-chat-canvas]')?.getBoundingClientRect().height) };
}

describe('observable conversation process', () => {
  it.each(['delivery', 'schedule', 'agent'] as const)('keeps a %s-triggered live header factual', async kind => {
    const v = mount([pending], { kind, ...(kind === 'delivery' ? { chatIds: ['977'] } : {}) });
    await until('live process appears', () => !!v.host.querySelector('[data-conversation-process]'));
    const header = v.host.querySelector('[data-conversation-process]')!;
    expect(header.textContent).toBe('Thinking and working · 21s · 1 step›');
  });

  it('includes an unfinished send in the same semantic summary, without a raw tool row', async () => {
    const v = mount([
      { kind: 'spawn-subagent-tool-call', id: 'spawn', seq: 0, toolCallId: 'spawn', title: 'Agent', status: 'done', name: 'helper' },
      { kind: 'unknown-tool-call', id: 'other', seq: 1, toolCallId: 'other', title: 'OtherNativeTool', name: 'OtherNativeTool', toolKind: 'other', status: 'done' },
      pending,
    ]);
    await until('process steps appear', () => !!v.host.querySelector('[data-slot="conversation-process-steps"]'));
    await v.settle();
    const runs = v.host.querySelectorAll('[data-slot="tool-run"]');
    expect(runs).toHaveLength(1);
    expect(runs[0].getAttribute('data-step-count')).toBe('3');
    expect(runs[0].textContent).toMatch(/called 1 MCP tool/i);
    expect(runs[0].textContent).toContain('launched 1 subagent');
    expect(runs[0].textContent).toContain('used 1 tool');
    expect(v.host.textContent).not.toContain(nativeName);
    expect(v.host.querySelector('[data-row-kind="mcp-tool-call"]')).toBeNull();
    runs[0].querySelector<HTMLButtonElement>('[data-collapse-id]')!.click();
    await v.settle();
    expect(v.host.textContent).not.toContain(nativeName);
  });

  it('summarizes a single pending call and does not expose raw rows through stored disclosure state', async () => {
    const v = mount([pending]);
    await until('process appears', () => !!v.host.querySelector('[data-conversation-process]'));
    await v.settle();
    const run = v.host.querySelector('[data-slot="tool-run"]');
    expect(run).not.toBeNull();
    expect(run!.getAttribute('data-step-count')).toBe('1');
    expect(run!.textContent).toContain('Called 1 MCP tool');
    v.state.viewState.setCollapsed('live:run:send', true);
    await v.settle();
    expect(v.host.textContent).not.toContain(nativeName);
    expect(v.host.querySelector('[data-row-kind="mcp-tool-call"]')).toBeNull();
  });
});
