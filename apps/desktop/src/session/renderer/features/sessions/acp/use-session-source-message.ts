import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { resolveConversationMessageReference, type ChatView, type TranscriptTurn } from '@gugu/session-chat-ui';
import { revealSourceMessage, SOURCE_MESSAGE_FLASH_MS } from '@/lib/sourceMessageReveal';
import { parseMessageQuoteLink } from '@gugu/core/shared/ui/messageQuote';

type SourceStore = {
  sessionId: string;
  chatState: { transcript: { state: { committedTurns: readonly TranscriptTurn[]; activeTurnSnapshot?: TranscriptTurn | null } } };
  canLoadOlderHistory: boolean;
  loadOlderHistory(): Promise<TranscriptTurn[]>;
  /** A phone host applies fetched pages through its timeline props. */
  historyManagedByHost?: boolean;
};

/** The chat reveal controller, with the session's history loader and virtual list. */
export function useSessionSourceMessage(store: SourceStore | null | undefined, view: MutableRefObject<ChatView | null>, onMissing: () => void) {
  const latest = useRef(store);
  latest.current = store;
  const missing = useRef(onMissing);
  missing.current = onMissing;
  const request = useRef(0);
  const mounted = useRef(true);
  const loading = useRef<{ store: SourceStore; promise: Promise<TranscriptTurn[]> } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [flashMessageId, setFlashMessageId] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    setFlashMessageId(null);
    return () => {
      mounted.current = false;
      request.current++;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [store]);

  // Top-edge pagination and quote navigation share this request, so one page is prepended once.
  const loadOlder = useCallback(async () => {
    const current = latest.current;
    if (!current) return [];
    if (loading.current?.store === current) return loading.current.promise;
    const currentView = view.current;
    const promise = current.loadOlderHistory().then(async turns => {
      if (mounted.current && latest.current === current && view.current === currentView && currentView && turns.length) {
        if (!current.historyManagedByHost) currentView.loadOlder(turns);
        // History is committed before the virtual list publishes its rows and height map.
        // Let that layout frame finish before resolving an anchor or starting its flash.
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
      return turns;
    });
    loading.current = { store: current, promise };
    try { return await promise; }
    finally { if (loading.current?.promise === promise) loading.current = null; }
  }, [view]);

  const reveal = useCallback((reference: string) => {
    const current = latest.current;
    const currentView = view.current;
    if (!current || !currentView) return;
    const token = ++request.current;
    const source = parseMessageQuoteLink(reference);
    if (source?.kind === 'session' && source.sessionId !== current.sessionId) {
      missing.current();
      return;
    }
    const valid = () => request.current === token && latest.current === current && view.current === currentView;
    const target = () => {
      const state = current.chatState.transcript.state;
      return resolveConversationMessageReference([...state.committedTurns, ...(state.activeTurnSnapshot ? [state.activeTurnSnapshot] : [])], reference, current.sessionId);
    };
    const showLoaded = () => {
      const id = target();
      if (!id || !valid()) return false;
      currentView.scrollToItem(id, { align: 'center' });
      return true;
    };
    void revealSourceMessage(reference, {
      showLoaded,
      load: async () => {
        while (valid() && current.canLoadOlderHistory) {
          const turns = await loadOlder();
          if (showLoaded()) return;
          if (!turns.length) break;
        }
        throw new Error('Original session message is unavailable');
      },
      current: valid,
      missing: () => missing.current(),
      flash: () => {
        setFlashMessageId(target());
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setFlashMessageId(null), SOURCE_MESSAGE_FLASH_MS);
      },
    });
  }, [loadOlder, view]);
  return { reveal, loadOlder, flashMessageId };
}
