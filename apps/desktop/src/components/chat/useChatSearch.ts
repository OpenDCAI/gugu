import { useCommandProvider } from '@renderer/lib/commands/use-command-provider'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { isChatSearchTarget } from '@/lib/chatSearchTarget'
import { UI_EVENTS } from '@/lib/uiEvents'

/** The existing in-window search policy, independent of the pane's presentation. */
export function useChatSearch(chatId: string | null, enabled: boolean, messages: MessageItem[], surface: RefObject<HTMLElement | null>, viewportKey: string) {
  const [searchMode, setSearchMode] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const open = useCallback(() => { setSearchQuery(''); setSearchMode(true) }, [])
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
  return { searchMode, setSearchMode, searchQuery, setSearchQuery, searchInputRef, isFiltering, displayedMessages }
}

