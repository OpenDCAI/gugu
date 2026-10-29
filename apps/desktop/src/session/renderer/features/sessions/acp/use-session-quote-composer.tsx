import { useCallback, useLayoutEffect, useSyncExternalStore, type MutableRefObject } from 'react';
import { readMessageQuote } from '@gugu/core/shared/ui/messageQuote';
import type { PromptEditorRef } from '@gugu/session-ui/react/components';
import { MessageQuotePreview } from '@/components/chat/ChatComposerContextBands';
import { renderMentionTokens } from '@renderer/lib/chat/render-mention-tokens';
import type { AcpChatStore } from './acp-chat-store';
import { getSessionQuote, quotedSessionPrompt, restoreSessionQuote, setSessionQuote, subscribeSessionQuote, type SessionQuoteDraft } from './session-quote-draft';

const quoteOf = (text: string): SessionQuoteDraft | null => {
  const quoted = readMessageQuote(text);
  return quoted ? { source: quoted.source, text: quoted.excerpt, sender: quoted.sender } : null;
};
const previewOf = (quote: SessionQuoteDraft | null, onClear?: () => void) => quote
  ? <MessageQuotePreview quote={{ senderName: quote.sender, content: quote.text }} onClear={onClear} /> : null;

export function useSessionQuoteComposer(store: AcpChatStore, editor: MutableRefObject<PromptEditorRef | null>) {
  const subscribe = useCallback((listener: () => void) => subscribeSessionQuote(store, listener), [store]);
  const snapshot = useCallback(() => getSessionQuote(store), [store]);
  const quote = useSyncExternalStore(subscribe, snapshot, snapshot);
  // Retry, revert and prompt-history paths return the persisted prompt. Decode before paint.
  useLayoutEffect(() => {
    if (!readMessageQuote(store.draftText)) return;
    const text = restoreSessionQuote(store, store.draftText);
    store.setDraftText(text);
    editor.current?.setText(text);
  }, [store, store.draftText, editor]);
  const editing = store.queuedPromptEdit;
  const queuedQuote = editing ? quoteOf(editing.text) : null;
  return {
    preview: editing ? previewOf(queuedQuote, () => store.changeQueuedPromptEdit(readMessageQuote(editing.text)?.body ?? editing.text))
      : previewOf(quote, () => setSessionQuote(store, null)),
    queuedPromptEdit: editing ? { ...editing, text: readMessageQuote(editing.text)?.body ?? editing.text } : null,
    changeQueuedPromptEdit: (text: string) => store.changeQueuedPromptEdit(quotedSessionPrompt(text, queuedQuote)),
    finishQueuedPromptEdit: (text: string | null) => { void store.finishQueuedPromptEdit(text === null ? null : quotedSessionPrompt(text, queuedQuote)); },
    renderQueuedPromptText: (text: string) => <>{previewOf(quoteOf(text))}{renderMentionTokens(readMessageQuote(text)?.body ?? text, store.chatState.uri ?? store.sessionId)}</>,
  };
}
