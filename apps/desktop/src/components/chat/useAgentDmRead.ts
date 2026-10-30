import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { ChatItem, MessageItem } from '@gugu/core/shared/types/chat'
import type { ChatView } from '@gugu/session-chat-ui'
import type { CapturedUnreadEntry } from '@/lib/chatUnreadLocator'
import { AgentDmReadCursor, dmTranscriptItem, visibleDmMessageIds } from './agent-dm-read'

export function useAgentDmRead({ chat, shown, messages, ignoredMessageIds, aliases, unreadEntry, markMessageVisible, setFollowingTail, loadMessageAnchor, onError }: {
  chat: ChatItem; shown: boolean; messages: readonly MessageItem[]; aliases: ReadonlyMap<string, readonly string[]>
  ignoredMessageIds: readonly string[]
  unreadEntry?: CapturedUnreadEntry | null
  markMessageVisible: (message: MessageItem) => void
  setFollowingTail: (following: boolean | undefined) => void
  loadMessageAnchor: (id: string) => Promise<void>
  onError: (error: unknown) => void
}) {
  const view = useRef<ChatView | null>(null)
  const [loadedAnchor, setLoadedAnchor] = useState<string | null>(null)
  const atBottom = useRef(false)
  const activation = useRef<{ shown: boolean; cursor: AgentDmReadCursor; first: string | null; placed: string | null; loading: boolean; seenEntry: boolean } | null>(null)
  if (!activation.current || (shown && !activation.current.shown)) {
    const locator = unreadEntry?.locator ?? chat.unread_locator
    const first = locator?.message_id ?? null
    activation.current = { shown, cursor: new AgentDmReadCursor(first, Math.max(locator?.cursor_seq ?? 0, chat.last_read_seq), locator?.message_seq ?? undefined), first, placed: null, loading: false, seenEntry: false }
  }
  activation.current.shown = shown
  const current = activation.current
  current.cursor.acknowledge(chat.last_read_seq)
  // An authorized IM row can precede the session window's watermark without
  // having a projected item. It cannot become a permanent visibility barrier.
  const unavailable = messages.filter(row => !dmTranscriptItem(row.id, aliases)).map(row => row.id)
  current.cursor.ignore([...ignoredMessageIds, ...unavailable])
  if (current.first && (ignoredMessageIds.includes(current.first) || unavailable.includes(current.first))) current.first = null
  if (current.first === loadedAnchor && !messages.some(row => row.id === current.first)) {
    current.cursor.ignore(loadedAnchor ? [loadedAnchor] : [])
    current.first = null
  }
  const reportFollowing = useCallback(() => setFollowingTail(shown && atBottom.current && current.cursor.canFollow(messages)), [shown, current, messages, setFollowingTail])
  const place = useCallback(() => {
    if (!shown || !current.first || !view.current) return
    const itemId = dmTranscriptItem(current.first, aliases)
    if (itemId && current.placed !== itemId) {
      current.placed = itemId
      // Keep the intent even when the first history seed has not built its
      // render units yet; an imperative item lookup at mount can miss them.
      view.current.setScrollMode({ kind: 'anchor', itemId, edge: 'top', offset: -8 })
    }
  }, [shown, current, aliases])
  useLayoutEffect(() => {
    reportFollowing()
    place()
    if (!shown || current.seenEntry || !current.first || messages.some(row => row.id === current.first) || current.loading) return
    current.loading = true
    const id = current.first
    void loadMessageAnchor(id).then(() => { if (activation.current === current) setLoadedAnchor(id) }).catch(onError)
  }, [shown, current, messages, place, reportFollowing, loadMessageAnchor, onError])
  useLayoutEffect(() => () => setFollowingTail(undefined), [setFollowingTail])
  const onVisibleItems = useCallback((ids: readonly string[]) => {
    if (!shown || document.visibilityState === 'hidden') return
    const canonical = visibleDmMessageIds(ids, aliases, messages)
    for (const row of current.cursor.visible(canonical, messages)) markMessageVisible(row)
    if (!current.seenEntry && current.first && canonical.includes(current.first)) { current.seenEntry = true; unreadEntry?.onSeen() }
    reportFollowing()
  }, [shown, aliases, messages, current, markMessageVisible, unreadEntry, reportFollowing])
  return { view, onVisibleItems, onAtBottomChange: (value: boolean) => { atBottom.current = value; reportFollowing() },
    onReady: (ready: ChatView) => { view.current = ready; place() } }
}
