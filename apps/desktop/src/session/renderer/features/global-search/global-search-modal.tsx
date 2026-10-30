import { useQuery } from '@tanstack/react-query'
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { parseQuery, SearchQueryError } from '@gugu/core/shared/search/query'
import { SEARCH_FACET_CAP, type SearchMessageHit, type SearchQuery, type SearchResults } from '@gugu/core/shared/search/types'
import { CalendarClock, FileText, Globe, Image as ImageIcon, Link as LinkIcon, Search, User, X } from '@/lib/icons'
import { useChatSummaries } from '@/lib/chatSummariesBridge'
import { readIdentityDirectoryBridge } from '@/lib/identityDirectoryBridge'
import { useDebounce } from '@renderer/lib/hooks/useDebounce'
import { rpcOn } from '@renderer/lib/ipc'
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider'
import { modalStore } from '@renderer/lib/modal/modal-store'
import { Shortcut } from '@renderer/lib/ui/shortcut'
import { useSessionMessages } from '@renderer/localization/use-session-messages'
import { cn } from '@renderer/utils/utils'
import { rankPaletteMatches } from '../command-palette/palette-rank'
import { GlobalSearchInput } from './global-search-input'
import { defaultSort, loadMoreHits, SEARCH_PAGE, setSearchResults, showHit, updateSearchSession, useSearchSession, type SearchChip, type SearchFacet } from './search-session'

const countLabel = (count: number, capped = false) => (count > SEARCH_FACET_CAP ? `${SEARCH_FACET_CAP}+` : capped ? `${count}+` : String(count))

function useIdentities() {
  const bridge = readIdentityDirectoryBridge()
  const [snapshot, setSnapshot] = useState(() => bridge?.getSnapshot() ?? null)
  useEffect(() => bridge?.subscribe(() => setSnapshot(bridge.getSnapshot())), [bridge])
  return snapshot ?? {}
}

/** Chips and the facet become the structured filters; typed modifiers in the text are parsed by the same core parser. */
function toQuery(text: string, chips: readonly SearchChip[], facet: SearchFacet, sort: SearchQuery['sort'],
  kindOf: (chatId: string) => string | null, resolveIn: (value: string) => string[], resolveFrom: (value: string) => string[]): SearchQuery {
  const filters: SearchQuery['filters'] = {}
  for (const chip of chips) {
    if (chip.kind === 'in') filters.in = [...(filters.in ?? []), { kind: kindOf(chip.chatId) === 'topic' ? 'topic' : 'chat', id: chip.chatId }]
    else if (chip.kind === 'from') filters.from = [...(filters.from ?? []), chip.userId]
    else filters.on = chip.date
  }
  if (facet !== 'all') filters.has = [facet]
  return parseQuery(text, {
    now: new Date(), filters, sort,
    resolveIn: (value) => resolveIn(value).map((id) => ({ kind: kindOf(id) === 'topic' ? 'topic' as const : 'chat' as const, id })),
    resolveFrom,
  })
}

function Highlighted({ text, hit }: { text: string; hit: SearchMessageHit }): ReactNode {
  const parts: ReactNode[] = []
  let at = 0
  for (const { start, end } of hit.highlights) {
    if (start > at) parts.push(text.slice(at, start))
    parts.push(<mark key={start} className="rounded-[2px] bg-[var(--accent-tint-row)] px-px text-inherit">{text.slice(start, end)}</mark>)
    at = end
  }
  parts.push(text.slice(at))
  return parts
}

function formatWhen(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  return new Intl.DateTimeFormat(undefined, sameDay ? { hour: '2-digit', minute: '2-digit' }
    : date.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' })
    .format(date)
}

export function GlobalSearchModal({ onClose }: BaseModalProps) {
  const { translate } = useSessionMessages()
  const session = useSearchSession()
  const { text, chips, facet, sort, selectedId } = session
  const summaries = useChatSummaries()
  const identities = useIdentities()
  const [memberPicker, setMemberPicker] = useState(false)
  const [memberQuery, setMemberQuery] = useState('')
  const [showReasons, setShowReasons] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const debounced = useDebounce(text, 120)

  const chatName = (chatId: string) => summaries.get(chatId)?.alias || summaries.get(chatId)?.name || chatId.slice(0, 8)
  const personName = (userId: string | null) => (userId && identities[userId]?.display_name) || '?'
  const resolveIn = (value: string) => rankPaletteMatches([...summaries].filter(([, chat]) => chat.name), value,
    ([, chat]) => [chat.name, chat.alias]).slice(0, 2).map(([id]) => id)
  const people = Object.entries(identities)
  const resolveFrom = (value: string) => rankPaletteMatches(people, value, ([, identity]) => [identity.display_name]).slice(0, 2).map(([id]) => id)

  let query: SearchQuery | null = null
  // A malformed filter is the user's to fix: show what to check, not the parser's internal message.
  let queryInvalid = false
  try {
    query = toQuery(debounced, chips, facet, sort, (id) => summaries.get(id)?.kind ?? null, resolveIn, resolveFrom)
  } catch (error) {
    if (!(error instanceof SearchQueryError)) throw error
    queryInvalid = true
  }
  const runnable = query && (query.text.trim() || Object.keys(query.filters).length > 0) ? query : null
  const { data } = useQuery<{ query: SearchQuery; page: SearchResults }>({
    queryKey: ['global-search', runnable],
    queryFn: async () => ({ query: runnable!, page: await rpcOn(null).search.global({ query: runnable!, limit: SEARCH_PAGE }) }),
    enabled: runnable !== null,
    placeholderData: (previous) => previous,
  })
  // The session holds the one result set (and its total) that this list and the in-chat bar both page through.
  const hasQuery = runnable !== null
  useEffect(() => {
    if (hasQuery && data) setSearchResults(data.query, data.page)
    else if (!hasQuery) setSearchResults(null, null)
  }, [data, hasQuery])
  const results = session.results

  const scoped = chips.filter((chip) => chip.kind === 'in').length === 1
  const groups = useMemo(() => {
    if (scoped) return [{ chatId: null as string | null, hits: results }]
    const byChat = new Map<string, SearchMessageHit[]>()
    for (const hit of results) byChat.set(hit.chatId, [...(byChat.get(hit.chatId) ?? []), hit])
    return [...byChat].map(([chatId, hits]) => ({ chatId: chatId as string | null, hits }))
  }, [results, scoped])
  const ordered = groups.flatMap((group) => group.hits)
  const selected = ordered.find((hit) => hit.id === selectedId) ?? ordered[0] ?? null

  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selected?.id])
  useEffect(() => {
    const alt = (event: KeyboardEvent) => setShowReasons(event.altKey)
    window.addEventListener('keydown', alt)
    window.addEventListener('keyup', alt)
    return () => { window.removeEventListener('keydown', alt); window.removeEventListener('keyup', alt) }
  }, [])

  const setChips = (next: SearchChip[]) => updateSearchSession({ chips: next, sort: defaultSort(next), selectedId: null })
  const removeChip = (index: number) => setChips(chips.filter((_, at) => at !== index))
  // The jump sets focus itself (the entered chat's composer): the modal must not hand it back to its opener first.
  const open = (hit: SearchMessageHit) => { modalStore.closeWithoutFocusReturn(); onClose(); showHit(hit) }
  const move = (direction: 1 | -1) => {
    if (ordered.length === 0) return
    const at = selected ? ordered.indexOf(selected) : -1
    if (direction === 1 && at >= ordered.length - 2) void loadMoreHits()
    updateSearchSession({ selectedId: ordered[Math.min(ordered.length - 1, Math.max(0, at + direction))]!.id })
  }
  const facets = data?.page.facets
  const coverage = data?.page.coverage
  const memberMatches = rankPaletteMatches(people, memberQuery, ([, identity]) => [identity.display_name]).slice(0, 8)

  const facetButton = (value: SearchFacet, label: string, icon: ReactNode, count?: number) => (
    <button type="button" key={value} onClick={() => updateSearchSession({ facet: facet === value && value !== 'all' ? 'all' : value, selectedId: null })}
      className={cn('flex h-7 shrink-0 items-center gap-2 rounded-full border px-3 text-xs transition-colors',
        facet === value ? 'border-transparent bg-foreground text-background' : 'border-foreground/10 text-foreground/70 hover:bg-foreground/5')}>
      {icon}{label}{count ? <span className={facet === value ? '' : 'text-foreground/45'}>{countLabel(count, (facets?.total ?? 0) > SEARCH_FACET_CAP)}</span> : null}
    </button>
  )

  return (
    <div className="flex max-h-[min(640px,80vh)] flex-col overflow-hidden" data-testid="global-search">
      <div className="flex items-center gap-2 border-b border-foreground/10 px-4 py-3">
        <Search className="h-4 w-4 shrink-0 text-foreground/45" />
        {chips.map((chip, index) => (
          <span key={`${chip.kind}:${index}`} className="flex h-6 shrink-0 items-center gap-1 rounded-md border border-foreground/10 bg-foreground/[0.04] pl-2 pr-1 font-mono text-xs text-foreground/70">
            {chip.kind === 'in' ? `in: ${chatName(chip.chatId)}` : chip.kind === 'from' ? `from: ${personName(chip.userId)}` : `on: ${chip.date}`}
            <button type="button" aria-label={translate('globalSearch.removeChip')} onClick={() => removeChip(index)}
              className="grid h-4 w-4 place-items-center rounded text-foreground/45 hover:bg-foreground/10 hover:text-foreground"><X className="h-3 w-3" /></button>
          </span>
        ))}
        <GlobalSearchInput value={text} autoFocus placeholder={chips.length ? '' : translate('globalSearch.placeholder')}
          className="min-w-24 flex-1 bg-transparent text-sm outline-none placeholder:text-foreground/40" data-testid="global-search-input"
          onValueChange={(value) => updateSearchSession({ text: value, selectedId: null })}
          onSubmit={() => { if (selected) open(selected) }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); move(event.key === 'ArrowDown' ? 1 : -1) }
            else if (event.key === 'Backspace' && !event.currentTarget.value && chips.length) { event.preventDefault(); removeChip(chips.length - 1) }
          }} />
        <div className="flex shrink-0 rounded-md border border-foreground/10 p-1 text-xs">
          {(['recent', 'relevant'] as const).map((value) => (
            <button type="button" key={value} onClick={() => updateSearchSession({ sort: value })}
              className={cn('rounded px-2 py-1', sort === value ? 'bg-foreground/[0.07] text-foreground' : 'text-foreground/50 hover:text-foreground')}>
              {translate(value === 'recent' ? 'globalSearch.sortRecent' : 'globalSearch.sortRelevant')}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2 overflow-x-auto px-4 py-2">
        {facetButton('all', translate('globalSearch.facetAll', { count: countLabel(facets?.total ?? 0) }), null)}
        <div className="relative shrink-0">
          <button type="button" onClick={() => setMemberPicker((value) => !value)}
            className="flex h-7 items-center gap-2 rounded-full border border-foreground/10 px-3 text-xs text-foreground/70 hover:bg-foreground/5">
            <User size={14} />{translate('globalSearch.facetMember')}
          </button>
          {memberPicker && (
            <div className="absolute left-0 top-8 z-10 w-56 rounded-lg border border-foreground/10 bg-[var(--em-surface-base)] p-1 shadow-lg">
              <GlobalSearchInput value={memberQuery} autoFocus placeholder={translate('globalSearch.memberPlaceholder')}
                className="w-full rounded-md bg-[var(--em-surface-input)] px-2 py-2 text-xs outline-none"
                onValueChange={setMemberQuery}
                onSubmit={() => { const first = memberMatches[0]; if (first) { setChips([...chips, { kind: 'from', userId: first[0] }]); setMemberPicker(false); setMemberQuery('') } }} />
              {memberMatches.map(([id, identity]) => (
                <button type="button" key={id} className="block w-full truncate rounded px-2 py-2 text-left text-xs hover:bg-foreground/5"
                  onClick={() => { setChips([...chips, { kind: 'from', userId: id }]); setMemberPicker(false); setMemberQuery('') }}>
                  {identity.display_name}
                </button>
              ))}
            </div>
          )}
        </div>
        <label className="relative flex h-7 shrink-0 cursor-pointer items-center gap-2 rounded-full border border-foreground/10 px-3 text-xs text-foreground/70 hover:bg-foreground/5">
          <CalendarClock size={14} />{translate('globalSearch.facetDate')}
          <input type="date" className="absolute inset-0 cursor-pointer opacity-0"
            onChange={(event) => { if (event.target.value) setChips([...chips.filter((chip) => chip.kind !== 'on'), { kind: 'on', date: event.target.value }]) }} />
        </label>
        {facetButton('file', translate('globalSearch.facetFile'), <FileText size={14} />, facets?.file)}
        {facetButton('image', translate('globalSearch.facetImage'), <ImageIcon size={14} />, facets?.image)}
        {facetButton('link', translate('globalSearch.facetLink'), <LinkIcon size={14} />, facets?.link)}
        {coverage && (
          <span className="ml-auto shrink-0 pl-2 text-xs text-foreground/40">
            {translate(coverage.complete ? 'globalSearch.coverageComplete' : 'globalSearch.coveragePartial')}
          </span>
        )}
      </div>

      <div ref={listRef} className="min-h-40 flex-1 overflow-y-auto px-2 pb-2" role="listbox"
        onScroll={(event) => {
          const list = event.currentTarget
          if (list.scrollTop + list.clientHeight >= list.scrollHeight - 48) void loadMoreHits()
        }}>
        {queryInvalid && <div className="px-3 py-6 text-center text-sm text-[var(--em-foreground-destructive)]">{translate('globalSearch.queryInvalid')}</div>}
        {!queryInvalid && runnable && data && results.length === 0 && (
          <div className="px-3 py-8 text-center text-sm text-foreground/40">{translate('globalSearch.empty')}</div>
        )}
        {groups.map((group) => (
          <Fragment key={group.chatId ?? 'scope'}>
            {group.chatId && <div className="px-3 pb-1 pt-3 text-xs font-medium text-foreground/45">{chatName(group.chatId)}</div>}
            {group.hits.map((hit) => {
              const isSelected = hit.id === selected?.id
              const isFile = hit.attachment !== null
              return (
                <button type="button" role="option" aria-selected={isSelected} data-selected={isSelected} key={hit.id}
                  onMouseMove={() => { if (!isSelected) updateSearchSession({ selectedId: hit.id }) }}
                  onClick={() => open(hit)}
                  className={cn('relative flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left',
                    isSelected && 'bg-foreground/[0.05] before:absolute before:-left-2 before:bottom-1 before:top-1 before:w-[2px] before:rounded-full before:bg-[var(--accent)]')}>
                  <span className="mt-1 grid h-6 w-6 shrink-0 place-items-center rounded-md bg-foreground/[0.06] text-[length:var(--font-caption)] text-foreground/60">
                    {isFile ? (hit.text.split('\n')[0]!.match(/\.([a-z0-9]{1,4})$/i)?.[1] ?? 'FILE').toUpperCase() : Array.from(personName(hit.senderId))[0]}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{isFile ? <Highlighted text={hit.text} hit={hit} /> : personName(hit.senderId)}</span>
                      <span className="ml-auto shrink-0 text-xs text-foreground/40">{formatWhen(hit.createdAt)}</span>
                    </span>
                    <span className="mt-1 line-clamp-2 text-[length:var(--font-body)] leading-5 text-foreground/70">
                      {isFile ? translate('globalSearch.sentFile', { name: personName(hit.senderId) }) : <Highlighted text={hit.text} hit={hit} />}
                    </span>
                    {showReasons && (
                      <span className="mt-1 block font-mono text-[length:var(--font-caption)] text-foreground/40">
                        {hit.rank.reasons.map((reason) => `${reason.code} ${Math.round(reason.points)}`).join(' · ')}
                      </span>
                    )}
                  </span>
                </button>
              )
            })}
          </Fragment>
        ))}
        {scoped && (facets?.otherChats ?? 0) > 0 && (
          <button type="button" onClick={() => setChips(chips.filter((chip) => chip.kind !== 'in'))}
            className="mx-1 mt-2 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded-lg border border-foreground/10 px-3 py-2 text-left text-xs text-foreground/60 hover:bg-foreground/[0.03]">
            <Globe size={14} className="shrink-0" />
            <span className="flex-1">{translate('globalSearch.otherChats', { count: countLabel(facets!.otherChats) })}</span>
            <span className="flex items-center gap-1 text-foreground/45">{translate('globalSearch.removeChip')}<Shortcut hotkey="Backspace" variant="keycaps" /></span>
          </button>
        )}
      </div>

      <div className="flex items-center gap-4 border-t border-foreground/10 px-4 py-2 text-xs text-foreground/40">
        <span className="flex items-center gap-1"><Shortcut hotkey="ArrowUp" variant="keycaps" /><Shortcut hotkey="ArrowDown" variant="keycaps" />{translate('globalSearch.hintSelect')}</span>
        <span className="flex items-center gap-1"><Shortcut hotkey="Enter" variant="keycaps" />{translate('globalSearch.hintOpen')}</span>
        {chips.length > 0 && <span className="flex items-center gap-1"><Shortcut hotkey="Backspace" variant="keycaps" />{translate('globalSearch.hintRemoveChip')}</span>}
        <span className="ml-auto flex items-center gap-1"><Shortcut hotkey="Escape" variant="keycaps" />{translate('globalSearch.hintClose')}</span>
      </div>
    </div>
  )
}
