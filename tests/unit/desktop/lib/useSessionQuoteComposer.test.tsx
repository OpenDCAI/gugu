// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpChatStore } from '../../../../apps/desktop/src/session/renderer/features/sessions/acp/acp-chat-store';
import type { PromptEditorRef } from '@gugu/session-ui/react/components';
import { messageQuoteText, readMessageQuote } from '@gugu/core/shared/ui/messageQuote';
import { createReactHarness } from '../../../support/testHarness';
import { setSessionQuote } from '../../../../apps/desktop/src/session/renderer/features/sessions/acp/session-quote-draft';

vi.mock('@/components/chat/ChatComposerContextBands', () => ({ MessageQuotePreview: ({ quote, onClear }: { quote: { content: string; senderName: string }; onClear?: () => void }) => createElement('div', { 'data-quote': true }, quote.senderName, ':', quote.content, onClear ? createElement('button', { onClick: onClear }, 'clear') : null) }));
vi.mock('@renderer/lib/chat/render-mention-tokens', () => ({ renderMentionTokens: (text: string) => text }));
const { useSessionQuoteComposer } = await import('../../../../apps/desktop/src/session/renderer/features/sessions/acp/use-session-quote-composer');
let harness: ReturnType<typeof createReactHarness>;
beforeEach(() => { harness = createReactHarness(); });
afterEach(() => harness.cleanup());
const source = { kind: 'session' as const, sessionId: 'task', itemId: 'opaque/ID' };
const prompt = messageQuoteText(source, 'original words', 'Agent') + 'question';

describe('task composer quote presentation', () => {
  it('restores history into plain editor text and renders a dismissible preview', async () => {
    const state = { draftText: prompt, setDraftText: vi.fn((text: string) => { state.draftText = text; }), queuedPromptEdit: null, chatState: {}, sessionId: 'task' };
    const editor = { current: { setText: vi.fn() } as unknown as PromptEditorRef };
    function Probe() { return useSessionQuoteComposer(state as unknown as AcpChatStore, editor).preview; }
    await harness.render(createElement(Probe));
    expect(state.draftText).toBe('question');
    expect(editor.current.setText).toHaveBeenCalledWith('question');
    expect(harness.container.textContent).toContain('Agent:original words');
    expect(harness.container.textContent).not.toContain('gugu-session:');
    await act(async () => harness.container.querySelector('button')!.click());
    expect(harness.container.querySelector('[data-quote]')).toBeNull();
  });
  it('keeps queue edits and presentation free of ids without dropping the persisted source', async () => {
    const state = { draftText: 'next draft', queuedPromptEdit: { id: 'queued', text: prompt, originalDraftText: 'next draft', pending: false }, chatState: {}, sessionId: 'task', changeQueuedPromptEdit: vi.fn(), finishQueuedPromptEdit: vi.fn() };
    let adapter!: ReturnType<typeof useSessionQuoteComposer>;
    function Probe() { adapter = useSessionQuoteComposer(state as unknown as AcpChatStore, { current: null }); return createElement('div', null, adapter.preview, adapter.renderQueuedPromptText(prompt)); }
    await harness.render(createElement(Probe));
    expect(adapter.queuedPromptEdit?.text).toBe('question');
    expect(harness.container.textContent).not.toContain('gugu-session:');
    adapter.changeQueuedPromptEdit('edited');
    expect(readMessageQuote(state.changeQueuedPromptEdit.mock.calls[0]![0])).toMatchObject({ source, body: 'edited' });
    adapter.finishQueuedPromptEdit('finished');
    expect(readMessageQuote(state.finishQueuedPromptEdit.mock.calls[0]![0]!)).toMatchObject({ source, body: 'finished' });
    await act(async () => setSessionQuote(state, { source, text: 'other quote', sender: 'Agent' }));
  });
});
