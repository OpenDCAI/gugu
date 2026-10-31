import { useChatSummaries } from '@/lib/chatSummariesBridge'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { dmRecordIds } from '@/components/chat/agent-dm-record'
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
  const legacyFirst = [...chats.values()].find(chat => chat.peerUserId === summary?.agent?.userId)?.firstUnreadMessageId
  const current = useRef({ shown, sessionId, deviceId, view: null as ChatView | null, visible: new Set<NativeItemId>(), landing: true, placed: false, legacy: { first: null as string | null, placed: false } })
  // Landing on the first unread belongs to entering the conversation, and the entry ends when the page is first hidden.
  // A retained page shown again (back from another rail section) lands nowhere: the replies that arrived while it was
  // hidden must not pull a reader who was following the tail to the first of them.
  if (current.current.sessionId !== sessionId || current.current.deviceId !== deviceId) {
    current.current = { shown, sessionId, deviceId, view: null, visible: new Set(), landing: true, placed: false, legacy: { first: null, placed: false } }
  } else if (!shown && current.current.shown) {
    current.current.landing = false
  }
  current.current.shown = shown
  const place = useCallback(() => {
    const state = current.current
    if (!state.landing) return
    const first = summary?.nativeUnreadKeys?.[0]
    if (!legacyFirst) state.legacy = { first: null, placed: false }
    else if (!state.legacy.first) state.legacy.first = legacyFirst
    const aliases = dmRecordIds(readTurns.current())
    const legacyItem = state.legacy.first ? [...aliases].find(([id, ids]) => id !== state.legacy.first && ids.includes(state.legacy.first!))?.[0] : null
    if (!state.shown || !state.view) return
    // The two counters have separate ownership. An earlier native landing
    // cannot consume a later IM entry before its first receipt is readable.
    if (legacyItem && !state.legacy.placed) {
      state.legacy.placed = state.view.revealItem(legacyItem)
      return
    }
    if (state.placed || !first) return
    const itemId = readTurns.current().flatMap(turn => turn.items).find(item => (summary?.nativeUnreadAliases?.[nativeMessageKey(item.id)] ?? nativeMessageKey(item.id)) === first)?.id
    if (itemId) state.placed = state.view.revealItem(itemId)
  }, [summary, legacyFirst])
  useEffect(place, [place, shown])
  // IM landing must keep retrying even when the host has no native journal API.
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
      if (state.sessionId) publishNativeConversationVisibility(key.current, { sessionId: state.sessionId, visible: ids, aliases: dmRecordIds(readTurns.current()) })
      for (const id of ids) state.visible.add(nativeItemId(id))
    }, []),
  }
}
