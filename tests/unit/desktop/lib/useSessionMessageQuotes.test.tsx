// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@gugu/session-chat-ui';
import type { AcpChatStore } from '../../../../apps/desktop/src/session/renderer/features/sessions/acp/acp-chat-store';
import type { PromptEditorRef } from '@gugu/session-ui/react/components';
import { messageQuoteText } from '@gugu/core/shared/ui/messageQuote';
import { getSessionQuote } from '../../../../apps/desktop/src/session/renderer/features/sessions/acp/session-quote-draft';
import { createReactHarness } from '../../../support/testHarness';

const menu = vi.hoisted(() => vi.fn());
vi.mock('@/lib/contentContextMenu', () => ({ showRendererContentMenu: menu }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
const { useSessionMessageQuotes } = await import('../../../../apps/desktop/src/session/renderer/features/sessions/acp/use-session-message-quotes');

let harness: ReturnType<typeof createReactHarness>;
beforeEach(() => { harness = createReactHarness(); menu.mockReset(); document.getSelection()?.removeAllRanges(); });
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

describe('task message quote entry points', () => {
  it('quotes a whole Solid message by identity, keeps the draft and never sends it', async () => {
    const c = await setup();
    let answer!: (action: string) => void;
    menu.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
    c.root.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    c.setItem({ kind: 'message', id: 'recycled', role: 'assistant', text: 'same words' });
    await act(async () => answer('quote'));
    expect(getSessionQuote(c.state)).toMatchObject({ source: { kind: 'session', sessionId: 'session-a', itemId: 'first' }, text: 'same words' });
    expect(c.state.draftText).toBe('my question');
    expect(c.editor.current.setText).not.toHaveBeenCalled();
    expect(c.editor.current.focus).toHaveBeenCalledWith('end');
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
    expect(getSessionQuote(c.state)).toBeNull();
    expect(c.state.draftText).toBe('my question');
    expect(menu.mock.calls[0]![0].some((item: { id?: string }) => item.id === 'quote')).toBe(false);
    expect(menu.mock.calls[0]![0]).toContainEqual({ id: 'copy', label: 'transcript.copySelection' });
    c.dispose(); c.root.remove();
  });
  it('restores a persisted quote into its preview without exposing its id in the editor', async () => {
    const c = await setup();
    c.commands.restorePrompt({ text: messageQuoteText({ kind: 'session', sessionId: 'session-a', itemId: 'first' }, 'same words', 'Agent') + 'retry this' });
    expect(c.state.draftText).toBe('retry this');
    expect(c.editor.current.setText).toHaveBeenCalledWith('retry this');
    expect(getSessionQuote(c.state)?.source).toMatchObject({ itemId: 'first' });
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
