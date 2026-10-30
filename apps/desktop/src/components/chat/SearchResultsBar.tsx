import { ChevronDown, ChevronUp, ListFilter, Search, X } from '@/lib/icons'
import { useCommandProvider } from '@renderer/lib/commands/use-command-provider'
import { useSessionMessages } from '@renderer/localization/use-session-messages'
import { closeSearchBar, reopenGlobalSearch, stepHit, useSearchSession } from '@renderer/features/global-search/search-session'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { SEARCH_FACET_CAP } from '@gugu/core/shared/search/types'

/**
 * globalSearch.v3: after a jump from the search modal, the chat it landed in shows where it is in the results.
 * ⌘G / ⇧⌘G step through them; "Results" reopens the modal on the same query, chips and selection.
 */
export function SearchResultsBar({ chatId }: { chatId: string }) {
  const { translate } = useSessionMessages()
  const { barChatId, results, selectedId, text, total } = useSearchSession()
  const visible = barChatId === chatId && results.length > 0
  useCommandProvider({
    scopeId: 'app',
    isActive: () => visible,
    getCommands: () => [
      { id: 'chat.searchNext', hideFromPalette: true, execute: () => { void stepHit(1) } },
      { id: 'chat.searchPrevious', hideFromPalette: true, execute: () => { void stepHit(-1) } },
    ],
  })
  if (!visible) return null
  const at = results.findIndex((hit) => hit.id === selectedId)
  return (
    <div data-testid="search-results-bar" className="window-no-drag-region flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-accent-soft)] px-3 text-[length:var(--font-body)]"
      onKeyDown={(event) => { if (event.key === 'Escape') closeSearchBar() }}>
      <Search size={14} className="shrink-0 text-[var(--text-secondary)]" />
      <span className="min-w-0 truncate text-[var(--text-primary)]">{text}</span>
      <span className="shrink-0 tabular-nums text-[var(--text-secondary)]">{at + 1} / {total > SEARCH_FACET_CAP ? `${SEARCH_FACET_CAP}+` : total}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        <IconButton size="sm" aria-label={translate('globalSearch.previous')} onClick={() => { void stepHit(-1) }}><ChevronUp size={14} /></IconButton>
        <IconButton size="sm" aria-label={translate('globalSearch.next')} onClick={() => { void stepHit(1) }}><ChevronDown size={14} /></IconButton>
        <Button size="sm" onClick={reopenGlobalSearch}>
          <ListFilter size={14} />{translate('globalSearch.results')}
        </Button>
        <IconButton size="sm" aria-label={translate('globalSearch.closeBar')} onClick={closeSearchBar}><X size={14} /></IconButton>
      </span>
    </div>
  )
}
