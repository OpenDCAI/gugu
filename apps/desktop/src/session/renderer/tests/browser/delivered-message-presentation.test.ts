import { afterEach, expect, it, vi } from 'vitest';
import { createChatContext, createChatState, createChatView, type TranscriptTurn } from '@gugu/session-chat-ui';
import type { MessageItem } from '@gugu/core/shared/types/chat';
import { renderDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { connectDeliveredMessagePresentation } from '@renderer/lib/chat/delivered-message-presentation';
import { nativeChatAppearance } from '@renderer/lib/chat/native-chat-appearance.css';

const id = '11111111-2222-4333-8444-555555555555';
const raw = renderDeliveryEnvelope({ route: 'chat', from: 'Sender', fromId: 'user:sender', messageId: `msg:${id}`, at: '', chat: 'chat', chatKind: 'dm',
  content: 'Look at this\n[Folder file gugu-file://proof?v=2 — instructions]\n[Image attached at local path: /private/agent/image.png]' });
const turn: TranscriptTurn = { id: 'turn', seq: 1, initiator: 'user', outcome: { kind: 'done' }, items: [
  { kind: 'message', id: 'input', seq: 0, role: 'user', text: raw },
] };
const source = (kind: 'image' | 'file'): MessageItem => ({ id, content_type: 'attachment', retracted_at: null,
  content: `[附件] original.${kind === 'image' ? 'png' : 'txt'} (${kind === 'image' ? 'image/png' : 'text/plain'})\n[Size] 1\n[Kind] ${kind}\n[Caption]\nLook at this`,
  file_item_id: 'proof', file_version: 2 } as MessageItem);
let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; });

it.each(['image', 'file'] as const)('updates a mounted transcript from the authorized original %s after its message arrives', async kind => {
  const context = createChatContext({ locale: () => 'en-US', layout: { preset: 'double', userGutter: 0, agentConversation: true } });
  const state = createChatState(context);
  const host = document.createElement('div');
  host.className = nativeChatAppearance;
  host.style.cssText = 'position:fixed;top:45px;left:0;width:640px;height:500px';
  document.body.append(host);
  let finish: (message: MessageItem) => void = () => {};
  const load = vi.fn(() => new Promise<MessageItem>(resolve => { finish = resolve; }));
  const stop = connectDeliveredMessagePresentation(state, load, vi.fn());
  const open = vi.fn();
  const view = createChatView({ context, state, parent: host, commands: {
    resolveAttachment: async () => 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=', onOpenLink: open,
  } });
  dispose = () => { stop(); view.dispose(); state.dispose(); context.dispose(); host.remove(); };
  state.transcript.history.seed([turn]);
  await expect.poll(() => load.mock.calls.length).toBe(1);
  expect(load).toHaveBeenCalledWith(id);
  expect(host.textContent).not.toContain('/private/agent');
  finish(source(kind));
  await expect.poll(() => host.querySelector('[data-attachment-chip]')?.getAttribute('data-kind')).toBe(kind);
  expect(host.textContent).toContain('Look at this');
  expect(host.textContent).not.toContain('Folder file');
  expect(host.textContent).not.toContain('/private/agent');
  host.querySelector<HTMLButtonElement>('[data-attachment-chip]')!.click();
  expect(open).toHaveBeenCalledWith('gugu-file://proof?v=2');
  expect(state.transcript.history.get()[0].items[0]).toMatchObject({ text: raw });
});

it('does not replace an unavailable source with transport paths or update a disposed host', async () => {
  const context = createChatContext({ locale: () => 'en-US' }), state = createChatState(context);
  let finish: (message: MessageItem | null) => void = () => {};
  const load = vi.fn(() => new Promise<MessageItem | null>(resolve => { finish = resolve; }));
  const stop = connectDeliveredMessagePresentation(state, load, vi.fn());
  dispose = () => { stop(); state.dispose(); context.dispose(); };
  state.transcript.history.seed([turn]);
  await expect.poll(() => load.mock.calls.length).toBe(1);
  finish(null);
  await Promise.resolve();
  expect(state.session.state.deliveredMessages?.size).toBe(0);
  stop();
  const next = connectDeliveredMessagePresentation(state, load, vi.fn());
  await expect.poll(() => load.mock.calls.length).toBe(2);
  next();
  finish(source('image'));
  await Promise.resolve();
  expect(state.session.state.deliveredMessages?.size).toBe(0);
});
