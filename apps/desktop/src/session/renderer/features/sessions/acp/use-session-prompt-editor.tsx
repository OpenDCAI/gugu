import { useLayoutEffect, type MutableRefObject } from 'react';
import type { PromptEditorRef } from '@gugu/session-ui/react/components';
import { renderMentionTokens } from '@renderer/lib/chat/render-mention-tokens';

import { sessionPromptBody } from './session-message-quote';

export function useSessionPromptEditor<Edit extends { text: string }>(store: {
  sessionId: string; draftText: string; chatState: { uri?: string | null }; queuedPromptEdit: Edit | null;
  setDraftText(text: string): void; changeQueuedPromptEdit(text: string): void; finishQueuedPromptEdit(text: string | null): unknown;
}, editor: MutableRefObject<PromptEditorRef | null>) {
  useLayoutEffect(() => {
    const text = sessionPromptBody(store.draftText);
    if (text === store.draftText) return;
    store.setDraftText(text);
    editor.current?.setText(text);
  }, [store, store.draftText, editor]);
  const editing = store.queuedPromptEdit;
  return {
    queuedPromptEdit: editing ? { ...editing, text: sessionPromptBody(editing.text) } : null,
    changeQueuedPromptEdit: (text: string) => store.changeQueuedPromptEdit(text),
    finishQueuedPromptEdit: (text: string | null) => { void store.finishQueuedPromptEdit(text); },
    renderQueuedPromptText: (text: string) => renderMentionTokens(sessionPromptBody(text), store.chatState.uri ?? store.sessionId),
  };
}
