// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@gugu/session-chat-ui';
import type { AcpChatStore } from '../../../../apps/desktop/src/session/renderer/features/sessions/acp/acp-chat-store';
import type { PromptEditorRef } from '@gugu/session-ui/react/components';
import { messageQuoteText } from '@gugu/core/shared/ui/messageQuote';
import { createReactHarness } from '../../../support/testHarness';

const menu = vi.hoisted(() => vi.fn());
const writeClipboardText = vi.hoisted(() => vi.fn(async (_text: string) => {}));
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/lib/contentContextMenu', () => ({ showRendererContentMenu: menu }));
vi.mock('@/platform', () => ({ platform: { writeClipboardText } }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
const { useSessionMessageQuotes } = await import('../../../../apps/desktop/src/session/renderer/features/sessions/acp/use-session-message-quotes');

let harness: ReturnType<typeof createReactHarness>;
beforeEach(() => { harness = createReactHarness(); menu.mockReset(); writeClipboardText.mockClear(); toast.mockClear(); document.getSelection()?.removeAllRanges(); });
afterEach(() => harness.cleanup());

async function setup() {
  const state = { sessionId: 'session-a', draftText: 'my question', submitPrompt: vi.fn(), queuePrompt: vi.fn(), setDraftText(text: string) { this.draftText = text; } };
  const store = state as unknown as AcpChatStore;
  const editor = { current: { setText: vi.fn(), focus: vi.fn() } as unknown as PromptEditorRef };
  let commands!: ReturnType<typeof useSessionMessageQuotes>;
  function Probe({ current = store }: { current?: AcpChatStore }) { commands = useSessionMessageQuotes(current, editor); return null; }
  await harness.render(createElement(Probe));
  const root = document.createElement('div'); root.textContent = 'same words'; document.body.append(root);
  let item: ChatMessage = { kind: 'message', id: 'first', role: 'assistant', text: 'same words' };
  const dispose = commands.onMessageTextMount({ root, itemId: item.id, message: () => item, sender: () => 'Agent' });
  return { state, editor, root, dispose, commands, setItem: (value: ChatMessage) => { item = value; }, render: (current: AcpChatStore) => harness.render(createElement(Probe, { current })) };
}

describe('task message copy menus and legacy prompt restoration', () => {
  it.each([false, true])('uses the platform clipboard for copy (selected=%s)', async selected => {
    const c = await setup();
    if (selected) {
      const range = document.createRange(); range.setStart(c.root.firstChild!, 0); range.setEnd(c.root.firstChild!, 4);
      document.getSelection()!.addRange(range);
    }
    menu.mockResolvedValue('copy');
    await act(async () => c.root.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    expect(writeClipboardText).toHaveBeenCalledExactlyOnceWith(selected ? 'same' : 'same words');
    expect(c.state.draftText).toBe('my question');
    c.dispose(); c.root.remove();
  });
  it('reports clipboard failure without a copied-success notification', async () => {
    const c = await setup();
    menu.mockResolvedValue('copy');
    writeClipboardText.mockRejectedValueOnce(new Error('clipboard unavailable'));
    await act(async () => c.root.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    expect(writeClipboardText).toHaveBeenCalledExactlyOnceWith('same words');
    expect(toast).toHaveBeenCalledExactlyOnceWith({ title: 'task.copyFailed', tier: 'error' });
    c.dispose(); c.root.remove();
  });
  it('ignores a removed whole-message quote action after its row is recycled', async () => {
    const c = await setup();
    let answer!: (action: string) => void;
    menu.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
    c.root.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    c.setItem({ kind: 'message', id: 'recycled', role: 'assistant', text: 'same words' });
    await act(async () => answer('quote'));
    expect(menu.mock.calls[0]![0].some((item: { id?: string }) => item.id === 'quote')).toBe(false);
    expect(c.state.draftText).toBe('my question');
    expect(c.editor.current.setText).not.toHaveBeenCalled();
    expect(c.editor.current.focus).not.toHaveBeenCalled();
    expect(c.state.submitPrompt).not.toHaveBeenCalled();
    expect(c.state.queuePrompt).not.toHaveBeenCalled();
    c.dispose(); c.root.remove();
  });
  it('keeps selection copy but refuses fragment quote sending until compatible receivers ship', async () => {
    const c = await setup();
    const range = document.createRange(); range.setStart(c.root.firstChild!, 0); range.setEnd(c.root.firstChild!, 4);
    document.getSelection()!.addRange(range);
    menu.mockResolvedValue('quote');
    await act(async () => c.root.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    expect(c.state.draftText).toBe('my question');
    expect(c.state.draftText).toBe('my question');
    expect(menu.mock.calls[0]![0].some((item: { id?: string }) => item.id === 'quote')).toBe(false);
    expect(menu.mock.calls[0]![0]).toContainEqual({ id: 'copy', label: 'transcript.copySelection' });
    c.dispose(); c.root.remove();
  });
  it('restores only the body of a persisted quote without recreating its quote', async () => {
    const c = await setup();
    c.commands.restorePrompt({ text: messageQuoteText({ kind: 'session', sessionId: 'session-a', itemId: 'first' }, 'same words', 'Agent') + 'retry this' });
    expect(c.state.draftText).toBe('retry this');
    expect(c.editor.current.setText).toHaveBeenCalledWith('retry this');
    c.dispose(); c.root.remove();
  });
  it('does not apply a menu from one task to a task opened while the menu was waiting', async () => {
    const c = await setup();
    let answer!: (action: string) => void;
    menu.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
    c.root.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await c.render({ ...c.state, sessionId: 'session-b' } as unknown as AcpChatStore);
    await act(async () => answer('quote'));
    expect(c.state.draftText).toBe('my question');
    c.dispose(); c.root.remove();
  });
});
