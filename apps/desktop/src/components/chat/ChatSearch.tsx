import { useEffect, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { isChatSearchTarget } from '@/lib/chatSearchTarget'
import { UI_EVENTS } from '@/lib/uiEvents'
import { AUTOMATION_TEST_IDS } from '@/lib/automationDom'
import { SearchField } from '../ui/SearchField'
import { Button } from '../ui/Button'

/** The existing in-window search policy, independent of the pane's presentation. */
export function useChatSearch(chatId: string | null, enabled: boolean, messages: MessageItem[], surface: RefObject<HTMLElement | null>) {
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
      const target = (event as CustomEvent<{ chatId?: string }>).detail?.chatId
      if (target ? target === chatId : isChatSearchTarget(surface.current, chatId)) open()
    }
    window.addEventListener('keydown', onKey); window.addEventListener(UI_EVENTS.openChatSearch, onOpen)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener(UI_EVENTS.openChatSearch, onOpen) }
  }, [chatId, enabled, surface])
  const isFiltering = searchMode && !!searchQuery.trim()
  const displayedMessages = isFiltering ? messages.filter((message) => !message.retracted_at
    && message.content_type !== 'attachment' && (message.content ?? '').toLowerCase().includes(searchQuery.toLowerCase())) : messages
  return { searchMode, setSearchMode, searchQuery, setSearchQuery, searchInputRef, isFiltering, displayedMessages }
}

export function ChatSearchControls({ search }: { search: ReturnType<typeof useChatSearch> }) {
  const { t } = useTranslation('messaging')
  const close = () => { search.setSearchMode(false); search.setSearchQuery('') }
  return <>
    <SearchField ref={search.searchInputRef} className="flex-1" data-testid={AUTOMATION_TEST_IDS.chatHeaderSearchInput}
      value={search.searchQuery} onChange={(event) => search.setSearchQuery(event.target.value)}
      onKeyDown={(event) => { if (event.key === 'Escape') close() }} placeholder={t('chatArea.searchMessages')} />
    <Button variant="ghost" size="sm" className="shrink-0" data-testid={AUTOMATION_TEST_IDS.chatHeaderSearchCancelButton}
      onClick={close}>{t('common.cancel')}</Button>
  </>
}
