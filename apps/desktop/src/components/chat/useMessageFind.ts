import { useCallback, useMemo, type RefObject } from 'react'
import { useFindBar } from '@renderer/lib/ui/use-find-bar'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { FlowListHandle } from '@/lib/flowList'
import type { ScrollableRow } from '@/lib/sourceMessageScroll'
import type { useChatSearch } from './useChatSearch'
import { createMessageFind } from './messageFind'

export function useMessageFind({ messages, rows, rootRef, listRef, scrollerRef, enabled, search }: {
  messages: readonly MessageItem[]
  rows: readonly ScrollableRow[]
  rootRef: RefObject<HTMLElement | null>
  listRef: RefObject<FlowListHandle | null>
  scrollerRef: RefObject<HTMLElement | null>
  enabled: boolean
  search: ReturnType<typeof useChatSearch>
}) {
  const backend = useMemo(() => createMessageFind({ messages, rows,
    root: () => rootRef.current, list: () => listRef.current, scroller: () => scrollerRef.current,
  }), [messages, rows, rootRef, listRef, scrollerRef])
  const closeSearch = useCallback(() => { search.setSearchMode(false); search.setSearchQuery('') }, [search.setSearchMode, search.setSearchQuery])
  const find = useFindBar({ rootRef, backend, enabled, onOpen: closeSearch,
    isActive: (element) => element.closest('[data-chat-surface]') === rootRef.current,
  })
  const searchAll = () => { const query = find.searchQuery; find.onClose(); search.open(query) }
  return { ...find, searchAll }
}
