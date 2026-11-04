/** @jsxImportSource solid-js */
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { createChatState } from '@session-chat/state/chat-state';
import type { TranscriptItem, TranscriptTurn } from '@session-chat/model';

const chat = '127ec4f0-30b1-4583-b469-706756153bdd';
const owner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ids = ['6417511d-8f36-4cbc-8cbb-81ce9f97df73', '7417511d-8f36-4cbc-8cbb-81ce9f97df73'];
const image = 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=';
let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; });
const tool = (id: string, name: string, input: object, output: object): Extract<TranscriptItem, { kind: 'mcp-tool-call' }> => ({
  kind: 'mcp-tool-call', id, seq: 1, toolCallId: id, title: name, tool: name, server: 'gugu', status: 'done', at: 2000, completedAt: 3000,
  rawInput: JSON.stringify(input), outputText: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(output) }] }),
});
async function mount(agentConversation: boolean, items: TranscriptItem[], active = false) {
  const context = createChatContext({ locale: () => 'en-US', layout: { preset: 'double', userGutter: 0, agentConversation },
    selfIdentity: () => ({ userId: owner, displayName: 'Reader', guguNumber: null }), chatName: id => id === chat ? 'Design review' : null });
  const state = createChatState(context), host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;width:900px;height:1700px;background:white';
  document.body.append(host);
  const open = vi.fn((_href: string) => true), resolve = vi.fn(async () => image);
  const view = createChatView({ context, state, parent: host, commands: { onOpenLink: open, resolveAttachment: resolve, conversationAgentName: () => 'Fixture agent' } });
  dispose = () => { view.dispose(); state.dispose(); context.dispose(); host.remove(); };
  const turn: TranscriptTurn = { id: 'sent-output', seq: 0, initiator: 'user', startedAt: 1000,
    ...(!active ? { endedAt: 4000, outcome: { kind: 'done' as const } } : {}), items };
  if (active) state.transcript.activeTurn.set(turn);
  else state.transcript.history.seed([turn]);
  state.viewState.setCollapsed('sent-output:process', true);
  return { host, open, resolve };
}
it.each([false, true])('draws two scoped images as one card group with clickable previews (conversation=%s)', async conversation => {
  const files = ids.map((id, index) => tool(`file-${index}`, 'message_send_file', { chat_id: `user:${owner}`, file_name: `proof-${index}.png` },
    { message_id: id, file_name: `proof-${index}.png`, source_link: `gugu-chat://${chat}/${id}`, mime_type: 'image/png' }));
  const { host, open, resolve } = await mount(conversation, files);
  await expect.poll(() => host.querySelectorAll('[data-attachment-chip] img').length).toBe(2);
  const chips = host.querySelectorAll<HTMLButtonElement>('[data-attachment-chip]');
  expect(chips).toHaveLength(2);
  expect(chips[0].parentElement).toBe(chips[1].parentElement);
  expect([...chips].every(chip => chip.dataset.kind === 'image')).toBe(true);
  chips.forEach(chip => chip.click());
  expect(open.mock.calls.map(call => call[0])).toEqual(ids.map(id => `gugu-message-file://${id}?chat=${chat}`));
  expect(resolve).toHaveBeenCalledTimes(2);
  expect(host.querySelectorAll('[data-slot="sent-to"]')).toHaveLength(1);
  expect(host.querySelector('[data-slot="sent-to"]')?.getAttribute('aria-label')).toBe('Sent to you');
  await page.screenshot({ path: `__screenshots__/sent-output-1333/${conversation ? 'conversation' : 'session'}-files.png` });
});
it.each([false, true])('shows session_message words and recipient count and retains the message_send control (conversation=%s)', async conversation => {
  const relay = tool('relay', 'session_message', { to: ['session:a', 'session:b'], text: 'Sent to two sessions' },
    { route: 'session-direct', recipients: ids.map(message_id => ({ status: 'delivered', message_id: `msg:${message_id}` })) });
  const message = tool('text-send', 'message_send', { chat_id: chat, text: 'Group message control' }, { message_id: '8417511d-8f36-4cbc-8cbb-81ce9f97df73' });
  const { host } = await mount(conversation, [relay, message]);
  await expect.poll(() => host.textContent).toContain('Sent to two sessions');
  expect(host.textContent).toContain('Group message control');
  const destinations = conversation ? [...host.querySelectorAll('[data-slot="sent-to"]')].map(e => e.getAttribute('aria-label'))
    : [...host.querySelectorAll('[data-agent-send-to]')].map(e => e.textContent);
  expect(destinations).toEqual(['Sent to 2 tasks', 'Sent to Design review']);
  await page.screenshot({ path: `__screenshots__/sent-output-1332/${conversation ? 'conversation' : 'session'}-messages.png` });
});

for (const active of [true, false]) {
  it.each([['one recipient', 1, false], ['multiple recipients', 2, false], ['failed send', 1, true]] as const)(
    `renders the native MCP receipt correctly: %s (active=${active})`, async (_name, count, failed) => {
      const receipt = { route: 'session-direct', recipients: ids.slice(0, count).map(message_id => ({ status: 'queued', message_id: `msg:${message_id}` })) };
      const outputText = failed ? 'Recipient not found' : JSON.stringify(receipt);
      const relay: TranscriptItem = { ...tool('native-relay', 'session_message',
        { to: ids.slice(0, count).map(id => `session:${id}`), text: 'Native relay words', then: 'continue' }, receipt),
        server: 'plugin_gugu-product_gugu', status: failed ? 'error' : 'done',
        rawOutput: JSON.stringify([{ type: 'text', text: outputText }]), outputText };
      const { host } = await mount(true, [relay], active);
      if (failed && active) {
        const disclosure = () => host.querySelector<HTMLButtonElement>('[data-conversation-process][aria-expanded="false"]');
        await expect.poll(disclosure).not.toBeNull();
        disclosure()!.click();
      }
      await expect.poll(() => host.textContent).toContain(failed ? 'MCP' : 'Native relay words');
      await expect.poll(() => host.querySelectorAll('[data-slot="sent-to"]').length).toBe(failed ? 0 : 1);
      if (!failed) {
        expect(host.textContent).toContain('Native relay words');
        expect(host.querySelector('[data-slot="sent-to"]')?.getAttribute('aria-label'))
          .toBe(count === 1 ? 'Sent to another task' : 'Sent to 2 tasks');
      }
    },
  );
}
