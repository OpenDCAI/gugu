import { useEffect, useRef, useState, type RefObject } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { isChatSearchTarget } from '@/lib/chatSearchTarget'
import { UI_EVENTS } from '@/lib/uiEvents'

/** The existing in-window search policy, independent of the pane's presentation. */
export function useChatSearch(chatId: string | null, enabled: boolean, messages: MessageItem[], surface: RefObject<HTMLElement | null>, viewportKey: string) {
  const [searchMode, setSearchMode] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { setSearchMode(false); setSearchQuery('') }, [chatId])
  useEffect(() => {
    if (!searchMode) return
    const timer = setTimeout(() => searchInputRef.current?.focus(), 50)
    return () => clearTimeout(timer)
  }, [searchMode])
  useEffect(() => {
    if (!chatId || !enabled) return
    const open = () => { setSearchQuery(''); setSearchMode(true) }
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey && event.code === 'KeyF' && !event.metaKey && !event.ctrlKey && isChatSearchTarget(surface.current, chatId)) {
        event.preventDefault(); open()
      }
    }
    const onOpen = (event: Event) => {
      const target = (event as CustomEvent<{ chatId?: string; viewportKey?: string }>).detail
      if (target?.chatId && target.chatId !== chatId) return
      if (target?.viewportKey ? target.viewportKey === viewportKey : isChatSearchTarget(surface.current, chatId)) open()
    }
    window.addEventListener('keydown', onKey); window.addEventListener(UI_EVENTS.openChatSearch, onOpen)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener(UI_EVENTS.openChatSearch, onOpen) }
  }, [chatId, enabled, surface, viewportKey])
  const isFiltering = searchMode && !!searchQuery.trim()
  const displayedMessages = isFiltering ? messages.filter((message) => !message.retracted_at
    && message.content_type !== 'attachment' && (message.content ?? '').toLowerCase().includes(searchQuery.toLowerCase())) : messages
  return { searchMode, setSearchMode, searchQuery, setSearchQuery, searchInputRef, isFiltering, displayedMessages }
}

