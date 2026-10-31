// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpChatStore } from '../../../../apps/desktop/src/session/renderer/features/sessions/acp/acp-chat-store';
import type { PromptEditorRef } from '@gugu/session-ui/react/components';
import { messageQuoteText } from '@gugu/core/shared/ui/messageQuote';
import { createReactHarness } from '../../../support/testHarness';

vi.mock('@renderer/lib/chat/render-mention-tokens', () => ({ renderMentionTokens: (text: string) => text }));
const { useSessionPromptEditor } = await import('../../../../apps/desktop/src/session/renderer/features/sessions/acp/use-session-prompt-editor');
let harness: ReturnType<typeof createReactHarness>;
beforeEach(() => { harness = createReactHarness(); });
afterEach(() => harness.cleanup());
const source = { kind: 'session' as const, sessionId: 'task', itemId: 'opaque/ID' };
const prompt = messageQuoteText(source, 'original words', 'Agent') + 'question';

describe('legacy prompt body presentation', () => {
  it('restores history into plain editor text without a quote preview', async () => {
    const state = { draftText: prompt, setDraftText: vi.fn((text: string) => { state.draftText = text; }), queuedPromptEdit: null, chatState: {}, sessionId: 'task' };
    const editor = { current: { setText: vi.fn() } as unknown as PromptEditorRef };
    function Probe() { useSessionPromptEditor(state as unknown as AcpChatStore, editor); return null; }
    await harness.render(createElement(Probe));
    expect(state.draftText).toBe('question');
    expect(editor.current.setText).toHaveBeenCalledWith('question');
    expect(harness.container.querySelector('[data-quote]')).toBeNull();
  });
  it('keeps queue edits free of ids and does not recreate the removed whole-message quote', async () => {
    const state = { draftText: 'next draft', queuedPromptEdit: { id: 'queued', text: prompt, originalDraftText: 'next draft', pending: false }, chatState: {}, sessionId: 'task', changeQueuedPromptEdit: vi.fn(), finishQueuedPromptEdit: vi.fn() };
    let adapter!: ReturnType<typeof useSessionPromptEditor>;
    function Probe() { adapter = useSessionPromptEditor(state as unknown as AcpChatStore, { current: null }); return createElement('div', null, adapter.renderQueuedPromptText(prompt)); }
    await harness.render(createElement(Probe));
    expect(adapter.queuedPromptEdit?.text).toBe('question');
    expect(harness.container.textContent).not.toContain('gugu-session:');
    adapter.changeQueuedPromptEdit('edited');
    expect(state.changeQueuedPromptEdit).toHaveBeenCalledWith('edited');
    adapter.finishQueuedPromptEdit('finished');
    expect(state.finishQueuedPromptEdit).toHaveBeenCalledWith('finished');
  });
});
