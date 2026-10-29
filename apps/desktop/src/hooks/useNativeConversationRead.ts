import { useChatSummaries } from '@/lib/chatSummariesBridge'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { dmRecordIds } from '@/components/chat/agent-dm-record'
import { publishNativeConversationVisibility } from '@/lib/nativeConversationVisibility'
import { useCallback, useEffect, useRef } from 'react'
import type { ChatView } from '@gugu/session-chat-ui'
import { nativeMessageKey } from '@gugu/session-core/session-record/native-read'
import { platform } from '@/platform'
import { useLiveDeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { rendererLogger } from '@/lib/log'

/** The same host journal supplies the desktop and phone; only readable bubbles enter it. */
export function useNativeConversationRead(deviceId: string | null, sessionId: string | undefined, shown: boolean, turns: () => readonly TranscriptTurn[]) {
  const directory = useLiveDeviceSessions()
  const summary = Object.entries(directory).flatMap(([id, value]) => value.sessions.map(session => ({ id, session })))
    .find(row => row.session.conversationId === sessionId && (!deviceId || row.id === deviceId))?.session
  const readTurns = useRef(turns)
  readTurns.current = turns
  const key = useRef(crypto.randomUUID())
  useEffect(() => { const id = key.current; if (!shown) publishNativeConversationVisibility(id, null); return () => publishNativeConversationVisibility(id, null) }, [shown, sessionId])
  const chats = useChatSummaries()
  const legacyFirst = [...chats.values()].find(chat => chat.peerUserId === summary?.agent?.userId)?.firstUnreadMessageId
  const current = useRef({ shown, sessionId, deviceId, view: null as ChatView | null, visible: new Set<string>(), placed: false })
  if (current.current.sessionId !== sessionId || current.current.deviceId !== deviceId) {
    current.current = { shown, sessionId, deviceId, view: null, visible: new Set(), placed: false }
  } else if (shown && !current.current.shown) {
    current.current.visible.clear(); current.current.placed = false
  }
  current.current.shown = shown
  const place = useCallback(() => {
    const state = current.current
    const first = summary?.nativeUnreadKeys?.[0]
    const aliases = dmRecordIds(readTurns.current())
    const legacyItem = legacyFirst ? [...aliases].find(([id, ids]) => id !== legacyFirst && ids.includes(legacyFirst))?.[0] : null
    if (!state.shown || !state.view || state.placed || (!first && !legacyItem)) return
    const itemId = legacyItem ?? readTurns.current().flatMap(turn => turn.items).find(item => (summary?.nativeUnreadAliases?.[nativeMessageKey(item.id)] ?? nativeMessageKey(item.id)) === first)?.id
    if (itemId) { state.placed = true; state.view.setScrollMode({ kind: 'anchor', itemId, edge: 'top', offset: -8 }) }
  }, [summary, legacyFirst])
  useEffect(place, [place, shown])
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
        const api = platform.kind === 'electron'
          ? (await import('@/session/renderer/lib/ipc')).rpcOn(deviceId).sessionTimeline
          : (await import('@/mobile/agent-watch/sessionpage-rpc')).machineRpc(deviceId!).sessionTimeline
        await api.sessionVisible({ conversationId: sessionId, itemIds: itemIds.slice(0, 500) })
        if (active) for (const id of itemIds.slice(0, 500)) state.visible.delete(id)
      } catch (error) {
        rendererLogger('session/read').warn({ sessionId, error: String(error) }, 'Visible replies could not be acknowledged')
      } finally { busy = false }
    }
    const timer = setInterval(() => { place(); void flush() }, 500)
    return () => { active = false; clearInterval(timer) }
  }, [shown, sessionId, deviceId, summary?.nativeInputVersion, summary?.nativeUnreadKeys, summary?.nativeUnreadAliases, place])
  return {
    onReady: (view: ChatView) => { current.current.view = view; place() },
    onVisibleItems: useCallback((ids: readonly string[]) => {
      const state = current.current
      if (!state.shown) return
      if (state.sessionId) publishNativeConversationVisibility(key.current, { sessionId: state.sessionId, visible: ids, aliases: dmRecordIds(readTurns.current()) })
      for (const id of ids) state.visible.add(id)
    }, []),
  }
}
