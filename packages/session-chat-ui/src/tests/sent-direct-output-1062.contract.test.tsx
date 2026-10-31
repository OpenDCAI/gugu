/** @jsxImportSource solid-js */
import { afterEach, expect, it } from 'vitest';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { createChatState } from '@session-chat/state/chat-state';
import type { TranscriptItem, TranscriptTurn } from '@session-chat/model';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach(dispose => dispose()));
it.each([['ADJ', 900], ['DISTANT', 900], ['FILE', 900], ['FILE', 390]] as const)('shows direct output after a %s send at %spx in both process states and hides only silence', async (mode, width) => {
  const context = createChatContext();
  context.setLayout({ preset: 'double', userGutter: 72, agentConversation: true });
  const state = createChatState(context), host = document.createElement('div');
  host.style.cssText = `position:fixed;inset:0;width:${width}px;height:5000px`;
  document.body.append(host);
  const view = createChatView({ context, state, parent: host, commands: { conversationAgentName: () => 'Fixture agent' } });
  cleanups.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });
  const messageId = '6417511d-8f36-4cbc-8cbb-81ce9f97df73';
  const directText = mode === 'ADJ' ? 'T1062-ADJ-OK 已回复。' : mode === 'DISTANT' ? 'T1062-DISTANT-OK 已发出。' : 'The file is ready; here is additional context.';
  const send: TranscriptItem = { kind: 'mcp-tool-call', id: 'send', seq: 1, toolCallId: 'send', title: 'message_send', server: 'gugu',
    tool: mode === 'FILE' ? 'message_send_file' : 'message_send', status: 'done', at: 2000, completedAt: 3000,
    rawInput: JSON.stringify({ chat_id: 'fixture-dm',
      ...(mode === 'FILE' ? { file_name: 'proof.txt', file_path: '/fixture/proof.txt' }
        : { reply_to_message_id: mode === 'DISTANT' ? 'older' : 'source', text: `T1062-${mode}-OK` }) }),
    outputText: mode === 'FILE' ? JSON.stringify({ status: 'sent', message_id: messageId, file_name: 'proof.txt' }) : `sent (id=msg:${messageId})` };
  const turn: TranscriptTurn = { id: 'direct-output', seq: 0, initiator: 'user', startedAt: 1000, endedAt: 9000, outcome: { kind: 'done' }, items: [
    { kind: 'message', id: 'input', seq: 0, role: 'user', text: '<gugu_delivery route="chat" from="Owner" from_id="user:owner" msg="msg:source" chat="fixture-dm" chat_kind="dm"><![CDATA[Please respond]]></gugu_delivery>' }, send,
    { kind: 'message', id: 'direct', seq: 2, role: 'assistant', text: directText, at: 4000 },
    { kind: 'message', id: 'silent', seq: 3, role: 'assistant', text: '[NO_REPLY]' },
  ] };
  state.transcript.history.seed([turn]);
  await until('the input is rendered', () => host.querySelector('[data-user-card="input"]') !== null);
  for (const collapsed of [true, false]) {
    state.viewState.setCollapsed('direct-output:process', collapsed);
    await untilStable('the transcript geometry settles', () => host.querySelector('[data-chat-canvas]')?.getBoundingClientRect().height);
    expect(host.querySelector('[data-user-card="direct"]')?.textContent, host.textContent ?? '').toContain(directText);
    const direct = host.querySelector('[data-agent-conversation-message="direct"]')!;
    expect(direct.querySelector('[data-slot="conversation-reference"]')).toBeNull();
    expect(host.querySelectorAll('[data-user-card="direct"]')).toHaveLength(1);
    expect(host.querySelector('[data-agent-conversation-message="silent"]')).toBeNull();
    expect(host.textContent).not.toContain('[NO_REPLY]');
    if (mode === 'FILE') {
      expect(host.querySelectorAll('[data-attachment-chip]')).toHaveLength(1);
      const destinations = host.querySelectorAll('[data-slot="sent-to"]');
      expect(destinations, 'a real captionless file tool receipt keeps its destination').toHaveLength(1);
      expect(destinations[0]?.getAttribute('aria-label')).toContain('Owner');
    }
    else expect(host.querySelectorAll(`[data-user-card="send:sent:${messageId}"]`)).toHaveLength(1);
  }
});
