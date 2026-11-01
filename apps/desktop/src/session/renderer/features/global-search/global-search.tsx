import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { FileText, Search, X } from '@/lib/icons'
import { useChatSummaries } from '@/lib/chatSummariesBridge'
import { followLink } from '@/lib/guguLinks'
import { UI_EVENTS } from '@/lib/uiEvents'
import { messageForUser } from '@/lib/userFacingError'
import { askTaskReveal } from '@/hooks/useSourceMessageReveal'
import { conversationLink } from '@gugu/core/shared/ui/guguLink'
import { messageQuoteLink } from '@gugu/core/shared/ui/messageQuote'
import { matchRanges } from '@shared/core/search'
import { Shortcut } from '@renderer/lib/ui/shortcut'
import { useSessionMessages } from '@renderer/localization/use-session-messages'
import { cn } from '@renderer/utils/utils'
import { updateSearchSession, useSearchSession, type SearchChip, type SearchFacet } from './search-session'
import { instant, SEARCH_LIMIT, useGlobalSearch, type SearchHit } from './use-global-search'

function Highlighted({ text, query }: { text: string; query: string }): ReactNode {
  const parts: ReactNode[] = []
  let at = 0
  for (const { start, end } of matchRanges(text, query)) {
    if (start > at) parts.push(text.slice(at, start))
    parts.push(<mark key={start} className="rounded-[2px] bg-[var(--accent-tint-row)] px-px text-inherit">{text.slice(start, end)}</mark>)
    at = end
  }
  parts.push(text.slice(at))
  return parts
}

function formatWhen(iso: string): string {
  const date = new Date(instant(iso))
  const now = new Date()
  return new Intl.DateTimeFormat(undefined, date.toDateString() === now.toDateString() ? { hour: '2-digit', minute: '2-digit' }
    : date.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' }).format(date)
}

/** Go to where a hit was said: a chat message through its conversation link, a task turn through the task's reveal. */
export function openHit(hit: SearchHit): void {
  if (hit.kind === 'message') { followLink(conversationLink(hit.chatId, hit.messageId)); return }
  askTaskReveal(hit.taskId, messageQuoteLink({ kind: 'session', sessionId: hit.taskId, itemId: hit.itemId }))
  followLink({ kind: 'session', sessionId: hit.taskId, projectId: hit.projectId })
  window.dispatchEvent(new CustomEvent(UI_EVENTS.chatAsked))
}

/**
 * The global search panel (the desktop modal and the phone's full-screen page). One filter row, newest first, the
 * matched sentence leading each row; scope by typing in: / from:, or by a group's header. `tasks`: this device has
 * local tasks to search (the phone has none, so it has no task filter).
 */
export function GlobalSearch({ tasks, onClose }: { tasks: boolean; onClose: () => void }) {
  const { translate } = useSessionMessages()
  const { text, chips, facet, selectedId } = useSearchSession()
  const summaries = useChatSummaries()
  const view = useGlobalSearch(text, chips, facet, tasks)
  const [composition, setComposition] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const facets: readonly SearchFacet[] = tasks ? ['all', 'message', 'task', 'file'] : ['all', 'message', 'file']

  const chatName = (chatId: string) => summaries.get(chatId)?.alias || summaries.get(chatId)?.name || translate('globalSearch.unknownChat')
  const chipLabel = (chip: SearchChip) => chip.kind === 'in' ? chatName(chip.chatId) : chip.kind === 'in-task' ? chip.title : chip.name
  const groups: { key: string; label: string; task: boolean; scope: SearchChip; hits: SearchHit[] }[] = []
  for (const hit of view.hits) {
    let group = groups.find((existing) => existing.key === hit.group)
    if (!group) {
      group = hit.kind === 'task'
        ? { key: hit.group, label: hit.title, task: true, scope: { kind: 'in-task', taskId: hit.taskId, title: hit.title }, hits: [] }
        : { key: hit.group, label: chatName(hit.chatId), task: false, scope: { kind: 'in', chatId: hit.chatId }, hits: [] }
      groups.push(group)
    }
    group.hits.push(hit)
  }
  const ordered = groups.flatMap((group) => group.hits)
  const selected = ordered.find((hit) => hit.id === selectedId) ?? ordered[0] ?? null
  const scoped = view.scopes.some((chip) => chip.kind === 'in' || chip.kind === 'in-task')
  const hasQuery = !!text.trim()

  useEffect(() => { listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [selected?.id])

  const open = (hit: SearchHit) => { onClose(); openHit(hit) }
  const move = (direction: 1 | -1) => {
    if (!ordered.length) return
    const at = selected ? ordered.indexOf(selected) : -1
    updateSearchSession({ selectedId: ordered[Math.min(ordered.length - 1, Math.max(0, at + direction))]!.id })
  }
  const setChips = (next: SearchChip[]) => updateSearchSession({ chips: next, selectedId: null })
  const cycleFacet = (direction: 1 | -1) =>
    updateSearchSession({ facet: facets[(facets.indexOf(facet) + direction + facets.length) % facets.length]!, selectedId: null })
  const countLabel = (count: number) => (view.capped && count >= SEARCH_LIMIT ? `${SEARCH_LIMIT}+` : String(count))

  return (
    <div className="flex max-h-[min(600px,80vh)] flex-col overflow-hidden max-sm:h-full max-sm:max-h-none" data-testid="global-search">
      <div className="flex h-12 shrink-0 items-center gap-2 px-4">
        <Search className="h-4 w-4 shrink-0 text-foreground/40" />
        {chips.map((chip, index) => (
          <span key={`${chip.kind}:${index}`} className="flex h-6 max-w-40 shrink-0 items-center gap-1 rounded-md bg-foreground/[0.06] pl-2 pr-0.5 text-xs text-foreground/75">
            <span className="truncate">{chipLabel(chip)}</span>
            <button type="button" aria-label={translate('globalSearch.removeChip')} onClick={() => setChips(chips.filter((_, at) => at !== index))}
              className="grid h-5 w-5 place-items-center rounded text-foreground/40 hover:bg-foreground/10 hover:text-foreground"><X className="h-3 w-3" /></button>
          </span>
        ))}
        <input autoFocus value={composition ?? text} data-testid="global-search-input" aria-label={translate('globalSearch.placeholder')}
          placeholder={translate(chips.length ? 'globalSearch.placeholderScoped' : 'globalSearch.placeholder')}
          className="h-full min-w-24 flex-1 bg-transparent text-[15px] outline-none placeholder:text-foreground/35"
          onCompositionStart={(event) => setComposition(event.currentTarget.value)}
          onCompositionEnd={(event) => { setComposition(null); updateSearchSession({ text: event.currentTarget.value, selectedId: null }) }}
          onChange={(event) => { if (composition === null) updateSearchSession({ text: event.target.value, selectedId: null }); else setComposition(event.target.value) }}
          onKeyDown={(event) => {
            if (composition !== null || event.nativeEvent.isComposing || event.keyCode === 229) return
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); move(event.key === 'ArrowDown' ? 1 : -1) }
            else if (event.key === 'Enter') { event.preventDefault(); if (selected) open(selected) }
            else if (event.key === 'Tab') { event.preventDefault(); cycleFacet(event.shiftKey ? -1 : 1) }
            else if (event.key === 'Backspace' && !event.currentTarget.value && chips.length) { event.preventDefault(); setChips(chips.slice(0, -1)) }
          }} />
        <button type="button" onClick={onClose} className="shrink-0 text-sm text-foreground/60 sm:hidden">{translate('globalSearch.cancel')}</button>
      </div>

      {hasQuery && (
        <div className="relative flex h-9 shrink-0 items-end gap-5 overflow-x-auto border-b border-foreground/[0.08] px-4 [scrollbar-width:none]" role="tablist">
          {facets.map((value) => {
            const on = facet === value
            const count = view.counts[value]
            return (
              <button type="button" role="tab" aria-selected={on} key={value} tabIndex={-1}
                onClick={() => updateSearchSession({ facet: value, selectedId: null })}
                className={cn('relative flex h-full shrink-0 items-center gap-1.5 text-[13px] transition-colors',
                  on ? 'text-foreground after:absolute after:inset-x-0 after:-bottom-px after:h-[2px] after:rounded-full after:bg-foreground' : 'text-foreground/50 hover:text-foreground/80')}>
                {translate(`globalSearch.facet.${value}`)}
                {count ? <span className="tabular-nums text-foreground/35">{countLabel(count)}</span> : null}
              </button>
            )
          })}
          {view.loading && <span aria-hidden className="absolute inset-x-0 -bottom-px h-px overflow-hidden"><span className="block h-full w-1/3 animate-[gs-scan_1s_ease-in-out_infinite] bg-[var(--accent)]" /></span>}
        </div>
      )}

      <div ref={listRef} className={cn('flex-1 overflow-y-auto px-2', hasQuery && 'min-h-48 pb-2')} role="listbox" aria-label={translate('globalSearch.results')}>
        {view.error && <div role="alert" className="px-3 py-3 text-sm text-[var(--em-foreground-destructive)]">{messageForUser(view.error)}</div>}
        {!hasQuery && (
          <div className="border-t border-foreground/[0.08] px-3 pb-4 pt-3 text-[13px] leading-6 text-foreground/50">
            <div>{translate(tasks ? 'globalSearch.introWhat' : 'globalSearch.introWhatChats')}</div>
            <div>{translate('globalSearch.introScope')} <code className="rounded bg-foreground/[0.06] px-1 font-mono text-xs text-foreground/70">in:</code> <code className="rounded bg-foreground/[0.06] px-1 font-mono text-xs text-foreground/70">from:</code></div>
          </div>
        )}
        {hasQuery && view.unresolved && <div className="px-3 py-8 text-center text-sm text-foreground/45">{translate('globalSearch.unresolved', { text: view.unresolved })}</div>}
        {hasQuery && !view.unresolved && !view.loading && !view.error && ordered.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-3 py-10 text-center text-sm text-foreground/45">
            <span>{view.query ? translate('globalSearch.emptyFor', { text: view.query }) : translate('globalSearch.typeWords')}</span>
            {view.query && (facet !== 'all' || chips.length > 0) && (
              <button type="button" className="text-[13px] text-foreground/70 underline-offset-4 hover:underline"
                onClick={() => updateSearchSession({ facet: 'all', chips: [], selectedId: null })}>{translate('globalSearch.widen')}</button>
            )}
          </div>
        )}
        {groups.map((group) => (
          <Fragment key={group.key}>
            {!scoped && <button type="button" title={translate('globalSearch.scopeTo')}
              className="flex w-full items-center gap-1.5 px-3 pb-1 pt-3 text-left text-xs text-foreground/45 hover:text-foreground/70"
              onClick={() => setChips([...chips, group.scope])}>
              <span className="truncate font-medium">{group.label}</span>
              {group.task && <span className="shrink-0 text-foreground/35">· {translate('globalSearch.task')}</span>}
            </button>}
            {group.hits.map((hit) => {
              const isSelected = hit.id === selected?.id
              const sender = hit.kind === 'message' ? hit.sender : translate(hit.role === 'assistant' ? 'globalSearch.agent' : 'globalSearch.you')
              return (
                <button type="button" role="option" aria-selected={isSelected} data-selected={isSelected} key={hit.id}
                  onMouseMove={() => { if (!isSelected) updateSearchSession({ selectedId: hit.id }) }}
                  onClick={() => open(hit)}
                  className={cn('flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left outline-none', isSelected && 'bg-foreground/[0.06]')}>
                  <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-foreground/[0.07] text-[10px] font-medium text-foreground/55">
                    {hit.kind === 'message' && hit.file ? <FileText size={11} /> : Array.from(sender)[0]}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 text-sm leading-5 text-foreground/85"><Highlighted text={hit.text} query={view.query} /></span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-xs text-foreground/40">
                      <span className="truncate">{sender}</span>
                      <span aria-hidden>·</span><span className="shrink-0 tabular-nums">{formatWhen(hit.at)}</span>
                    </span>
                  </span>
                  {isSelected && <span className="mt-0.5 shrink-0 text-foreground/35 max-sm:hidden"><Shortcut hotkey="Enter" variant="keycaps" /></span>}
                </button>
              )
            })}
          </Fragment>
        ))}
      </div>

      <div className="flex shrink-0 items-center gap-4 border-t border-foreground/[0.08] px-4 py-2 text-xs text-foreground/40 max-sm:hidden">
        <span className="flex items-center gap-1"><Shortcut hotkey="ArrowUp" variant="keycaps" /><Shortcut hotkey="ArrowDown" variant="keycaps" />{translate('globalSearch.hintSelect')}</span>
        <span className="flex items-center gap-1"><Shortcut hotkey="Tab" variant="keycaps" />{translate('globalSearch.hintFilter')}</span>
        <span className="ml-auto flex items-center gap-1"><Shortcut hotkey="Escape" variant="keycaps" />{translate('globalSearch.hintClose')}</span>
      </div>
    </div>
  )
}
