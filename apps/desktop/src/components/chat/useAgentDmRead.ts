import { useCallback, useLayoutEffect, useRef } from 'react'
import type { ChatItem, MessageItem } from '@gugu/core/shared/types/chat'
import type { ChatView } from '@gugu/session-chat-ui'
import type { CapturedUnreadEntry } from '@/lib/chatUnreadLocator'
import { AgentDmReadCursor, dmTranscriptItem } from './agent-dm-read'

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
  const atBottom = useRef(false)
  const activation = useRef<{ shown: boolean; cursor: AgentDmReadCursor; first: string | null; placed: string | null; loading: boolean } | null>(null)
  if (!activation.current || (shown && !activation.current.shown)) {
    const locator = unreadEntry?.locator ?? chat.unread_locator
    const first = locator?.message_id ?? null
    activation.current = { shown, cursor: new AgentDmReadCursor(first, locator?.cursor_seq ?? chat.last_read_seq), first, placed: null, loading: false }
  }
  activation.current.shown = shown
  const current = activation.current
  current.cursor.ignore(ignoredMessageIds)
  if (current.first && ignoredMessageIds.includes(current.first)) current.first = null
  const reportFollowing = useCallback(() => setFollowingTail(shown && atBottom.current && current.cursor.canFollow(messages)), [shown, current, messages, setFollowingTail])
  const place = useCallback(() => {
    if (!shown || !current.first || !view.current) return
    const itemId = dmTranscriptItem(current.first, aliases)
    if (itemId && current.placed !== itemId) {
      current.placed = itemId
      view.current.setScrollMode({ kind: 'anchor', itemId, edge: 'top', offset: 0 })
    }
  }, [shown, current, aliases])
  useLayoutEffect(() => {
    reportFollowing()
    place()
    if (!shown || !current.first || messages.some(row => row.id === current.first) || current.loading) return
    current.loading = true
    void loadMessageAnchor(current.first).catch(onError)
  }, [shown, current, messages, place, reportFollowing, loadMessageAnchor, onError])
  useLayoutEffect(() => () => setFollowingTail(undefined), [setFollowingTail])
  const onVisibleItems = useCallback((ids: readonly string[]) => {
    if (!shown || document.visibilityState === 'hidden') return
    const canonical = ids.flatMap(id => aliases.get(id) ?? (messages.some(row => row.id === id) ? [id] : []))
    for (const row of current.cursor.visible(canonical, messages)) markMessageVisible(row)
    if (current.first && canonical.includes(current.first)) unreadEntry?.onSeen()
    reportFollowing()
  }, [shown, aliases, messages, current, markMessageVisible, unreadEntry, reportFollowing])
  return { view, onVisibleItems, onAtBottomChange: (value: boolean) => { atBottom.current = value; reportFollowing() },
    onReady: (ready: ChatView) => { view.current = ready; place() } }
}
