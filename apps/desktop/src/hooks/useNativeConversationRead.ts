import { useChatSummaries } from '@/lib/chatSummariesBridge'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { dmMessageIdsByItem } from '@/components/chat/agent-dm-read'
import { publishNativeConversationVisibility } from '@/lib/nativeConversationVisibility'
import { useCallback, useEffect, useRef } from 'react'
import type { ChatView } from '@gugu/session-chat-ui'
import { nativeMessageKey } from '@gugu/session-core/session-record/native-read'
import { nativeItemId, writeRead, type NativeItemId } from '@/lib/readWriter'
import { useConversationSessionSummary } from './useConversationSessionSummary'
import { rendererLogger } from '@/lib/log'

/** The same host journal supplies the desktop and phone; only readable bubbles enter it. */
export function useNativeConversationRead(deviceId: string | null, sessionId: string | undefined, shown: boolean, turns: () => readonly TranscriptTurn[]) {
  const summary = useConversationSessionSummary(sessionId, deviceId)
  const readTurns = useRef(turns)
  readTurns.current = turns
  const key = useRef(crypto.randomUUID())
  useEffect(() => { const id = key.current; if (!shown) publishNativeConversationVisibility(id, null); return () => publishNativeConversationVisibility(id, null) }, [shown, sessionId])
  const chats = useChatSummaries()
  const imFirst = [...chats.values()].find(chat => chat.peerUserId === summary?.agent?.userId)?.firstUnreadMessageId
  const current = useRef({ shown, sessionId, deviceId, view: null as ChatView | null, visible: new Set<NativeItemId>(), entering: true })
  // @@@entry-open — where the reader lands is the view's own intent (the row they scrolled to, else the end); an unread
  // reply never moves them. Entering a conversation only opens the folds around its first unread (the earliest of the
  // native journal and the IM count of MCP sends, late data still counts), so a reader who scrolls there can see and
  // acknowledge it. Once each time the page is shown (replies that came in while it was hidden are folded the same way).
  if (current.current.sessionId !== sessionId || current.current.deviceId !== deviceId) {
    current.current = { shown, sessionId, deviceId, view: null, visible: new Set(), entering: true }
  } else if (shown && !current.current.shown) {
    current.current.entering = true
  }
  current.current.shown = shown
  const place = useCallback(() => {
    const state = current.current
    if (!state.entering || !state.shown || !state.view) return
    const turnsNow = readTurns.current()
    const nativeFirst = summary?.nativeUnreadKeys?.[0]
    const imTargets = imFirst ? [...dmMessageIdsByItem(turnsNow)].filter(([, ids]) => ids.includes(imFirst)).map(([id]) => id) : []
    let target: string | undefined
    for (const item of turnsNow.flatMap(turn => turn.items)) {
      if (nativeFirst && (summary?.nativeUnreadAliases?.[nativeMessageKey(item.id)] ?? nativeMessageKey(item.id)) === nativeFirst) target = item.id
      else target = imTargets.find(id => id === item.id || id.startsWith(`${item.id}:`))
      if (target) break
    }
    if (target && state.view.openItem(target)) state.entering = false
  }, [summary, imFirst])
  useEffect(place, [place, shown])
  // Opening retries until the target renders, from either source, and with or without a native journal on the host.
  useEffect(() => {
    if (!shown || !sessionId) return
    const timer = setInterval(place, 500)
    return () => clearInterval(timer)
  }, [place, shown, sessionId])
  useEffect(() => {
    if (!shown || !sessionId || summary?.nativeInputVersion !== 1) return
    let active = true
    let busy = false
    const flush = async () => {
      if (!active || busy || document.visibilityState === 'hidden') return
      const state = current.current
      if (!state.shown || state.sessionId !== sessionId) return
      const unread = new Set(summary?.nativeUnreadKeys ?? [])
      const itemIds = [...state.visible].filter(id => unread.has(summary?.nativeUnreadAliases?.[nativeMessageKey(id)] ?? nativeMessageKey(id)))
      if (!itemIds.length) return
      busy = true
      try {
        await writeRead({ kind: 'native', deviceId, conversationId: sessionId, itemIds: itemIds.slice(0, 500) })
        if (active) for (const id of itemIds.slice(0, 500)) state.visible.delete(id)
      } catch (error) {
        rendererLogger('session/read').warn({ sessionId, error: String(error) }, 'Visible replies could not be acknowledged')
      } finally { busy = false }
    }
    const timer = setInterval(() => { void flush() }, 500)
    return () => { active = false; clearInterval(timer) }
  }, [shown, sessionId, deviceId, summary?.nativeInputVersion, summary?.nativeUnreadKeys, summary?.nativeUnreadAliases])
  return {
    onReady: (view: ChatView) => { current.current.view = view; place() },
    onVisibleItems: useCallback((ids: readonly string[]) => {
      const state = current.current
      if (!state.shown) return
      if (state.sessionId) publishNativeConversationVisibility(key.current, { sessionId: state.sessionId, visible: ids, dmIds: dmMessageIdsByItem(readTurns.current()) })
      for (const id of ids) state.visible.add(nativeItemId(id))
    }, []),
  }
}
