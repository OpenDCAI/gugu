import { useCommandProvider } from '@renderer/lib/commands/use-command-provider'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { isChatSearchTarget } from '@/lib/chatSearchTarget'
import { UI_EVENTS } from '@/lib/uiEvents'
import { globalSearchV3Enabled, useGlobalSearchV3 } from '@renderer/features/global-search/global-search-flag'
import { findMemberMessages, openGlobalSearch } from '@renderer/features/global-search/search-session'

export { SearchResultsBar } from './SearchResultsBar'

/** The existing in-window search policy, independent of the pane's presentation. */
export function useChatSearch(chatId: string | null, enabled: boolean, messages: MessageItem[], surface: RefObject<HTMLElement | null>, viewportKey: string) {
  const [searchMode, setSearchMode] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  // globalSearch.v3: every in-chat entry (⌘F, the header button, the assistant's) opens the one search modal scoped
  // to this chat. The in-window filter below stays only for the flag-off and phone paths until the flag defaults on.
  const open = useCallback(() => {
    if (chatId && globalSearchV3Enabled()) return openGlobalSearch({ chips: [{ kind: 'in', chatId }] })
    setSearchQuery(''); setSearchMode(true)
  }, [chatId])
  const globalSearch = useGlobalSearchV3()
  // A member's messages in this chat: the same modal with in: and from: (member profile cards).
  const findMessagesOf = globalSearch && chatId
    ? (userId: string) => findMemberMessages(chatId, userId) : undefined
  useEffect(() => { setSearchMode(false); setSearchQuery('') }, [chatId])
  useEffect(() => {
    if (!searchMode) return
    const timer = setTimeout(() => searchInputRef.current?.focus(), 50)
    return () => clearTimeout(timer)
  }, [searchMode])
  useEffect(() => {
    if (!chatId || !enabled) return
    const onOpen = (event: Event) => {
      const target = (event as CustomEvent<{ chatId?: string; viewportKey?: string }>).detail
      if (target?.chatId && target.chatId !== chatId) return
      if (target?.viewportKey ? target.viewportKey === viewportKey : isChatSearchTarget(surface.current, chatId)) open()
    }
    window.addEventListener(UI_EVENTS.openChatSearch, onOpen)
    return () => { window.removeEventListener(UI_EVENTS.openChatSearch, onOpen) }
  }, [chatId, enabled, open, surface, viewportKey])
  useCommandProvider({
    // The visible chat also answers from the sidebar; focused terminal/editor commands take precedence.
    scopeId: 'app',
    isActive: (element) => enabled && !!chatId && isChatSearchTarget(surface.current, chatId, element),
    getCommands: () => !chatId ? [] : [{
      id: 'app.find', hideFromPalette: true,
      execute: open,
    }],
  })
  const isFiltering = searchMode && !!searchQuery.trim()
  const displayedMessages = isFiltering ? messages.filter((message) => !message.retracted_at
    && message.content_type !== 'attachment' && (message.content ?? '').toLowerCase().includes(searchQuery.toLowerCase())) : messages
  return { searchMode, setSearchMode, searchQuery, setSearchQuery, searchInputRef, isFiltering, displayedMessages, findMessagesOf }
}

