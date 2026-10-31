import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { SessionTranscriptView } from '@/components/assistant-ui/session-transcript-view.aui';
import { MessageLoadFailure } from '@/components/chat/MessageLoadFailure';
import { useAskedSourceMessage } from '@/hooks/useSourceMessageReveal';
import { readSelfIdentityBridge } from '@/lib/selfIdentityBridge';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';
import type { ChatView } from '@gugu/session-chat-ui';
import { rpcOn } from '@renderer/lib/ipc';
import { toast } from '@renderer/lib/hooks/use-toast';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { useSessionSourceMessage } from '../acp/use-session-source-message';

const disconnected = () => () => {};

/** A read-only host for the existing transcript and reveal controller. It never acquires an ACP or PTY runtime. */
export function StoredTranscriptView({ sessionId, shown = true }: { sessionId: string; shown?: boolean }) {
  const identity = readSelfIdentityBridge();
  const accountId = useSyncExternalStore(identity?.subscribe ?? disconnected, () => identity?.getSnapshot()?.userId ?? null);
  return accountId ? <StoredSessionHistory key={`${accountId}:${sessionId}`} accountId={accountId} sessionId={sessionId} shown={shown} /> : null;
}

function StoredSessionHistory({ accountId, sessionId, shown }: { accountId: string; sessionId: string; shown: boolean }) {
  const { translate } = useSessionMessages();
  const history = useInfiniteQuery({
    queryKey: ['session-stored-history', accountId, sessionId],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => rpcOn(null).sessions.getStoredHistory({ sessionId, before: pageParam }),
    getNextPageParam: page => page.nextCursor ?? undefined,
    retry: false, gcTime: 0, refetchOnWindowFocus: false,
  });
  const turns = history.data?.pages.toReversed().flatMap(page => page.turns) ?? [];
  const latest = useRef({ history, turns });
  latest.current = { history, turns };
  const committed = useRef(history.data);
  const mounted = useRef(true);
  const pending = useRef<{ data: typeof history.data; resolve: () => void } | null>(null);
  useLayoutEffect(() => {
    committed.current = history.data;
    if (pending.current && pending.current.data === history.data) { pending.current.resolve(); pending.current = null; }
  }, [history.data]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pending.current?.resolve(); pending.current = null; };
  }, []);
  const source = useMemo(() => ({
    sessionId,
    historyManagedByHost: true,
    get chatState() { return { transcript: { state: { committedTurns: latest.current.turns } } }; },
    get canLoadOlderHistory() { return latest.current.history.hasNextPage; },
    async loadOlderHistory() {
      if (!latest.current.history.hasNextPage) return [];
      const page = await latest.current.history.fetchNextPage({ cancelRefetch: false, throwOnError: true });
      if (!mounted.current) return [];
      // A cache result is not yet a rendered history page. The shared reveal waits for this host's commit,
      // then its existing layout frame, before trying the newly loaded anchor.
      if (committed.current !== page.data) await new Promise<void>(resolve => { pending.current = { data: page.data, resolve }; });
      return page.data?.pages.at(-1)?.turns ?? [];
    },
  }), [sessionId]);
  const view = useRef<ChatView | null>(null);
  const [ready, setReady] = useState(false);
  const reveal = useSessionSourceMessage(source, view,
    () => toast({ title: translate('transcript.originalMessageMissing'), variant: 'destructive' }));
  useAskedSourceMessage({ activeChatId: `task:${sessionId}`, enabled: shown,
    ready: ready && history.isSuccess, reveal: reference => reveal.reveal(reference) });

  if (history.error) return <MessageLoadFailure error={history.error} inline={false} onRetry={async () => { await history.refetch(); }} />;
  if (history.isPending) return <LoadingIndicator ariaLabel={translate('globalSearch.taskHistory')} />;
  return <SessionTranscriptView uri={`stored:${accountId}:${sessionId}`} turns={turns} activeTurnId={null} shown={shown}
    className="relative h-full min-h-0 min-w-0 overflow-hidden" onReady={handle => { view.current = handle; setReady(true); }}
    commands={{ onConversationReply: reveal.reveal, flashMessageId: reveal.flashMessageId }}
    onReachStart={() => { void reveal.loadOlder().catch(error => toast({ title: String(error), variant: 'destructive' })); }} />;
}
