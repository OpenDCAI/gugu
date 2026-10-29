import { useMemo, useRef, type MutableRefObject } from 'react'
import type { ChatView } from '@gugu/session-chat-ui'
import type { PromptEditorRef } from '@gugu/session-ui/react/components'
import type { useConversationQueue } from '@/components/chat/useConversationQueue'
import { useSessionMessageQuotes } from '@renderer/features/sessions/acp/use-session-message-quotes'
import { useSessionQuoteComposer } from '@renderer/features/sessions/acp/use-session-quote-composer'
import { useSessionSourceMessage } from '@renderer/features/sessions/acp/use-session-source-message'
import { consumeSessionQuote, getSessionQuote, quotedSessionPrompt, type SessionQuoteDraft } from '@renderer/features/sessions/acp/session-quote-draft'
import { toast } from '@renderer/lib/hooks/use-toast'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import type { AgentWatchTimeline } from './agent-watch-store'

/** The phone owns data/RPC; quote identity, preview, serialization and reveal stay shared with desktop. */
export function usePhoneSessionQuotes(input: {
  deviceId: string; sessionId: string; timeline: AgentWatchTimeline;
  draftText: string; setDraftText(text: string): void;
  queue: ReturnType<typeof useConversationQueue>['props']; onLoadOlder(): Promise<void>;
  editor: MutableRefObject<PromptEditorRef | null>; view: MutableRefObject<ChatView | null>;
}) {
  const latest = useRef(input)
  latest.current = input
  const { deviceId, sessionId, editor, view } = input
  const owner = useMemo(() => ({
    deviceId, sessionId,
    get draftText() { return latest.current.draftText },
    setDraftText: (text: string) => latest.current.setDraftText(text),
    get queuedPromptEdit() { return latest.current.queue.queuedPromptEdit },
    changeQueuedPromptEdit: (text: string) => latest.current.queue.onChangeQueuedPromptEdit(text),
    finishQueuedPromptEdit: (text: string | null) => latest.current.queue.onFinishQueuedPromptEdit(text),
    get chatState() { return { uri: sessionId, transcript: { state: { committedTurns: latest.current.timeline.turns, activeTurnSnapshot: null } } } },
    get canLoadOlderHistory() { return latest.current.timeline.hasOlder },
    historyManagedByHost: true,
    loadOlderHistory: async () => {
      const before = new Set(latest.current.timeline.turns.map(turn => turn.id))
      await latest.current.onLoadOlder()
      // The host publishes and lays out the fetched page; do not prepend it twice.
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      return latest.current.timeline.turns.filter(turn => !before.has(turn.id))
    },
  }), [deviceId, sessionId])
  const menus = useSessionMessageQuotes(owner, editor)
  const composer = useSessionQuoteComposer(owner, editor)
  const source = useSessionSourceMessage(owner, view, () => toast({ title: translateSessionMessage('transcript.originalMessageMissing'), tier: 'error' }))
  return {
    composer,
    commands: { onMessageTextMount: menus.onMessageTextMount, onRestorePrompt: menus.restorePrompt,
      onConversationReply: source.reveal, flashMessageId: source.flashMessageId },
    capture: () => getSessionQuote(owner),
    prompt: (text: string, quote: SessionQuoteDraft | null) => quotedSessionPrompt(text, quote),
    consume: (quote: SessionQuoteDraft | null) => consumeSessionQuote(owner, quote),
  }
}
