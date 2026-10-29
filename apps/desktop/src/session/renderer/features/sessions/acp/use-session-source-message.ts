import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { resolveConversationMessageReference, type ChatView, type TranscriptTurn } from '@gugu/session-chat-ui';
import { revealSourceMessage, SOURCE_MESSAGE_FLASH_MS } from '@/lib/sourceMessageReveal';
import type { AcpChatStore } from './acp-chat-store';

/** The chat reveal controller, with the session's history loader and virtual list. */
export function useSessionSourceMessage(store: AcpChatStore | null | undefined, view: MutableRefObject<ChatView | null>, onMissing: () => void) {
  const latest = useRef(store);
  latest.current = store;
  const missing = useRef(onMissing);
  missing.current = onMissing;
  const request = useRef(0);
  const mounted = useRef(true);
  const loading = useRef<{ store: AcpChatStore; promise: Promise<TranscriptTurn[]> } | null>(null);
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
    const promise = current.loadOlderHistory().then(turns => {
      if (mounted.current && latest.current === current && view.current === currentView && turns.length) currentView?.loadOlder(turns);
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
    const valid = () => request.current === token && latest.current === current && view.current === currentView;
    const target = () => {
      const state = current.chatState.transcript.state;
      return resolveConversationMessageReference([...state.committedTurns, ...(state.activeTurnSnapshot ? [state.activeTurnSnapshot] : [])], reference);
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
