import { expect, it, vi } from 'vitest';
import { createChatContext, createChatState, createChatView } from '@gugu/session-chat-ui';
import { nativeUserAttachmentCommands } from '@/mobile/agent-watch/native-user-attachments';
import type { TranscriptTurn } from '@gugu/session-core/acp/client';

it.each([390, 1280])('renders a decoded user thumbnail and opens its full image at %s px', async width => {
  const ref = { id: 'immutable-image', name: 'photo.png', mimeType: 'image/png' as const };
  const turns: TranscriptTurn[] = [{ id: 'c:turn:s28', seq: 28, initiator: 'user', outcome: { kind: 'done' }, items: [
    { kind: 'message', id: 'c:turn:s28:message:user', seq: 0, role: 'user', text: 'caption', attachments: [ref] },
    { kind: 'message', id: 'c:turn:s28:message:answer', seq: 1, role: 'assistant', text: '收到图片' },
  ] }];
  const url = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aIrkAAAAASUVORK5CYII=';
  const openImage = vi.fn(), readImage = vi.fn(async () => url);
  const commands = nativeUserAttachmentCommands({ turns: () => turns, readImage, readPathImage: vi.fn(), openImage, openFile: vi.fn(), onError: vi.fn(), unavailable: () => 'missing' });
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;top:45px;left:0;width:${width}px;height:800px`;
  document.body.append(host);
  const context = createChatContext({ locale: () => 'en-US' });
  context.setLayout({ preset: 'double', agentConversation: true, userGutter: 0 });
  const state = createChatState(context);
  state.transcript.history.seed(turns);
  const view = createChatView({ context, state, parent: host, commands });
  try {
    await vi.waitFor(() => expect(host.querySelector<HTMLImageElement>('[data-attachment-chip] img')?.naturalWidth).toBe(1));
    const chip = host.querySelector<HTMLButtonElement>('[data-attachment-chip]')!;
    expect(chip.dataset.kind).toBe('image');
    chip.click();
    await vi.waitFor(() => expect(openImage).toHaveBeenCalledWith(url, ref.name, expect.any(HTMLImageElement)));
    expect(readImage).toHaveBeenCalledExactlyOnceWith(turns[0]!.items[0]!.id, ref.id);
    expect(host.textContent).toContain('caption');
  } finally { view.dispose(); state.dispose(); context.dispose(); host.remove(); }
});
