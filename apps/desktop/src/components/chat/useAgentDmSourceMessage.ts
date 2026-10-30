import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { resolveConversationMessageReference, type TranscriptTurn, type ChatView } from '@gugu/session-chat-ui'
import { messageQuoteLink, parseMessageQuoteLink } from '@gugu/core/shared/ui/messageQuote'
import { useAskedSourceMessage } from '@/hooks/useSourceMessageReveal'
import { revealSourceMessage, SOURCE_MESSAGE_FLASH_MS } from '@/lib/sourceMessageReveal'
import { dmTranscriptItem } from './agent-dm-read'

/** Consume the existing chat reveal intent after both the authorized IM anchor and its transcript alias exist. */
export function useAgentDmSourceMessage(input: {
  chatId: string
  shown: boolean
  ready: boolean
  view: MutableRefObject<ChatView | null>
  sessionId?: string
  turns: readonly TranscriptTurn[]
  aliases: ReadonlyMap<string, readonly string[]>
  messageIds: readonly string[]
  oldestTurnId: string | null
  hasOlder: boolean
  loadMessageAnchor: (id: string) => Promise<void>
  loadOlder: () => Promise<void>
  leaveTail: () => void
  onMissing: () => void
}) {
  const latest = useRef(input)
  latest.current = input
  const request = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [flashMessageId, setFlashMessageId] = useState<string | null>(null)
  useEffect(() => () => {
    request.current++
    if (timer.current) clearTimeout(timer.current)
  }, [input.chatId])

  const reveal = useCallback((reference: string) => {
    const source = parseMessageQuoteLink(reference)
    const messageId = source?.kind === 'chat' ? source.messageId
      : latest.current.aliases.get(reference)?.[0] ?? (latest.current.messageIds.includes(reference) ? reference : null)
    if ((source?.kind === 'chat' && source.chatId !== latest.current.chatId)
      || (source?.kind === 'session' && source.sessionId !== latest.current.sessionId)) {
      latest.current.onMissing()
      return
    }
    const token = ++request.current
    const chatId = latest.current.chatId
    const sessionId = latest.current.sessionId
    const view = latest.current.view.current
    const valid = () => request.current === token && latest.current.chatId === chatId && latest.current.sessionId === sessionId && latest.current.view.current === view && latest.current.shown
    const target = () => messageId
      ? latest.current.messageIds.includes(messageId) ? dmTranscriptItem(messageId, latest.current.aliases) : null
      : resolveConversationMessageReference(latest.current.turns, reference, latest.current.sessionId)
    const showLoaded = () => {
      const id = target()
      const current = latest.current
      if (!id || !valid() || !current.view.current) return false
      current.leaveTail()
      current.view.current.scrollToItem(id, { align: 'center' })
      return true
    }
    const layout = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    void revealSourceMessage(reference, {
      current: valid,
      showLoaded,
      load: async () => {
        if (messageId) await latest.current.loadMessageAnchor(messageId)
        await layout()
        if (showLoaded()) return
        while (valid() && latest.current.hasOlder) {
          const before = latest.current.oldestTurnId
          await latest.current.loadOlder()
          await layout()
          if (showLoaded()) return
          if (latest.current.oldestTurnId === before) break
        }
        throw new Error('Original private message is unavailable')
      },
      missing: () => latest.current.onMissing(),
      flash: () => {
        setFlashMessageId(target())
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setFlashMessageId(null), SOURCE_MESSAGE_FLASH_MS)
      },
    })
  }, [])
  useAskedSourceMessage({ activeChatId: input.chatId, enabled: input.shown, ready: input.ready, navigationTarget: true,
    reveal: id => reveal(messageQuoteLink({ kind: 'chat', chatId: input.chatId, messageId: id })) })
  return { reveal, flashMessageId }
}
