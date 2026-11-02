import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { FileText, MessageSquare, Search, User, Users, X } from '@/lib/icons'
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
import { PALETTE_HEADING_CLASS, PALETTE_INPUT_CLASS, PaletteFooter, PaletteInputRow } from '../command-palette/palette-shell'
import { PALETTE_ITEM_CLASS } from '../command-palette/palette-item-styles'
import { updateSearchSession, useSearchSession, type SearchChip } from './search-session'
import { instant, SEARCH_LIMIT, useGlobalSearch, type SearchCompletion, type SearchHit } from './use-global-search'

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
 * The global search panel (the desktop modal and the phone's full-screen page). Explicit scope chips, newest first, the
 * matched sentence leading each row; scope by typing in: / from:, or by a group's header. `tasks`: this device has
 * local tasks to search (the phone has none, so it has no task filter).
 */
export function GlobalSearch({ tasks, onClose }: { tasks: boolean; onClose: () => void }) {
  const { translate } = useSessionMessages()
  const { text, chips, selectedId } = useSearchSession()
  const summaries = useChatSummaries()
  const view = useGlobalSearch(text, chips, tasks)
  const [composition, setComposition] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const chatName = (chatId: string) => summaries.get(chatId)?.alias || summaries.get(chatId)?.name || translate('globalSearch.unknownChat')
  const chipLabel = (chip: SearchChip) => chip.kind === 'in' ? chatName(chip.chatId) : chip.kind === 'in-task' ? chip.title
    : chip.kind === 'from' ? chip.name : translate(`globalSearch.chip.${chip.value}`)
  const chipIcon = (chip: SearchChip) => chip.kind === 'from' ? User : chip.kind === 'has' ? FileText
    : chip.kind === 'in-task' || (chip.kind === 'is' && chip.value === 'task') ? MessageSquare : Users
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
  const selectedCompletion = view.completions.find((item) => item.id === selectedId) ?? view.completions[0] ?? null
  const scoped = view.scopes.some((chip) => chip.kind === 'in' || chip.kind === 'in-task')
  const hasQuery = !!text.trim()

  useEffect(() => { listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [selected?.id, selectedCompletion?.id])

  const open = (hit: SearchHit) => { onClose(); openHit(hit) }
  const move = (direction: 1 | -1) => {
    const items = view.completing ? view.completions : ordered
    if (!items.length) return
    const current = view.completing ? selectedCompletion : selected
    const at = items.findIndex((item) => item.id === current?.id)
    updateSearchSession({ selectedId: items[Math.min(items.length - 1, Math.max(0, at + direction))]!.id })
  }
  const setChips = (next: SearchChip[]) => updateSearchSession({ chips: next, selectedId: null })
  const complete = (item: SearchCompletion) => {
    const chip = item.chip
    const next = chip ? [...chips.filter((old) => chip.kind === 'in' || chip.kind === 'in-task'
      ? old.kind !== 'in' && old.kind !== 'in-task' : old.kind !== chip.kind), chip] : chips
    updateSearchSession({ text: item.text, chips: next, selectedId: null })
    inputRef.current?.focus()
  }
  const countLabel = (count: number) => (view.capped && count >= SEARCH_LIMIT ? `${SEARCH_LIMIT}+` : String(count))
  const status = hasQuery && !view.completing && <div className="relative px-4 pb-2 text-xs text-foreground/40" role="status">
    {translate('globalSearch.summary', { count: countLabel(view.hits.length), groups: String(groups.length) })}
    {view.loading && <span aria-hidden className="absolute inset-x-0 -bottom-px h-px overflow-hidden"><span className="block h-full w-1/3 animate-[gs-scan_1s_ease-in-out_infinite] bg-[var(--accent)]" /></span>}
  </div>

  return (
    <div className="flex max-h-[min(600px,80vh)] flex-col overflow-hidden max-sm:h-full max-sm:max-h-none" data-testid="global-search">
      <PaletteInputRow icon={<Search />} status={status}>
        {chips.map((chip, index) => {
          const Icon = chipIcon(chip)
          return (
          <span key={`${chip.kind}:${index}`} className="flex h-6 max-w-40 shrink-0 items-center gap-1 rounded-md bg-foreground/[0.06] pl-2 pr-1 text-xs text-foreground/75">
            <Icon className="h-3 w-3 shrink-0" />
            <span className="truncate">{chipLabel(chip)}</span>
            <button type="button" aria-label={translate('globalSearch.removeChip')} onClick={() => setChips(chips.filter((_, at) => at !== index))}
              className="grid h-5 w-5 place-items-center rounded text-foreground/40 hover:bg-foreground/10 hover:text-foreground"><X className="h-3 w-3" /></button>
          </span>
        )})}
        <input ref={inputRef} autoFocus value={composition ?? text} data-testid="global-search-input" aria-label={translate('globalSearch.placeholder')}
          placeholder={translate(chips.length ? 'globalSearch.placeholderScoped' : 'globalSearch.placeholder')}
          className={PALETTE_INPUT_CLASS}
          onCompositionStart={(event) => setComposition(event.currentTarget.value)}
          onCompositionEnd={(event) => { setComposition(null); updateSearchSession({ text: event.currentTarget.value, selectedId: null }) }}
          onChange={(event) => { if (composition === null) updateSearchSession({ text: event.target.value, selectedId: null }); else setComposition(event.target.value) }}
          onKeyDown={(event) => {
            if (composition !== null || event.nativeEvent.isComposing || event.keyCode === 229) return
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); move(event.key === 'ArrowDown' ? 1 : -1) }
            else if (event.key === 'Enter') { event.preventDefault(); if (view.completing) { if (selectedCompletion) complete(selectedCompletion) } else if (selected) open(selected) }
            else if (event.key === 'Tab' && view.completing && selectedCompletion) { event.preventDefault(); complete(selectedCompletion) }
            else if (event.key === 'Backspace' && !event.currentTarget.value && chips.length) { event.preventDefault(); setChips(chips.slice(0, -1)) }
          }} />
        <button type="button" onClick={onClose} className="shrink-0 text-sm text-foreground/60 sm:hidden">{translate('globalSearch.cancel')}</button>
      </PaletteInputRow>

      <div ref={listRef} className={cn('flex-1 overflow-y-auto px-2', hasQuery && 'min-h-48 pb-2')} role="listbox" aria-label={translate('globalSearch.results')}>
        {view.error && <div role="alert" className="px-3 py-3 text-sm text-[var(--em-foreground-destructive)]">{messageForUser(view.error)}</div>}
        {view.completing && <>
          <div className={PALETTE_HEADING_CLASS}>{translate(view.completionKey === 'in' ? 'globalSearch.completeIn'
            : view.completionKey === 'from' ? 'globalSearch.completeFrom' : 'globalSearch.introScope')}</div>
          {view.completions.map((item) => {
            const on = item.id === selectedCompletion?.id
            const Icon = item.icon === 'task' ? MessageSquare : item.icon === 'person' ? User : item.icon === 'chat' ? Users : null
            return <button type="button" role="option" aria-selected={on} data-selected={on} key={item.id}
              onMouseMove={() => { if (!on) updateSearchSession({ selectedId: item.id }) }}
              onMouseDown={(event) => event.preventDefault()} onClick={() => complete(item)}
              className={cn(PALETTE_ITEM_CLASS, 'w-full gap-3 text-left outline-none')}>
              {Icon ? <Icon className="h-4 w-4 shrink-0 text-foreground/40" /> : null}
              <span className={cn('truncate', item.description && 'w-20 shrink-0 font-mono text-xs')}>{item.label}</span>
              {item.description && <span className="flex-1 text-foreground/60">{translate(item.description as Parameters<typeof translate>[0])}</span>}
              {on && <span className="ml-auto text-foreground/35"><Shortcut hotkey="Tab" variant="keycaps" /></span>}
            </button>
          })}
          {view.completions.length === 0 && !view.loading && !view.error && <div className="px-3 py-8 text-center text-sm text-foreground/45">{translate('globalSearch.unresolved', { text })}</div>}
          <div className="px-3 pb-3 pt-4 text-xs leading-6 text-foreground/40">{translate(tasks ? 'globalSearch.introWhat' : 'globalSearch.introWhatChats')}</div>
        </>}
        {hasQuery && !view.completing && !view.loading && !view.error && ordered.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-3 py-10 text-center text-sm text-foreground/45">
            <span>{view.query ? translate('globalSearch.emptyFor', { text: view.query }) : translate('globalSearch.typeWords')}</span>
            {view.query && chips.length > 0 && (
              <button type="button" className="text-[length:var(--font-body)] text-foreground/70 underline-offset-4 hover:underline"
                onClick={() => updateSearchSession({ chips: [], selectedId: null })}>{translate('globalSearch.widen')}</button>
            )}
          </div>
        )}
        {groups.map((group) => (
          <Fragment key={group.key}>
            {!scoped && <div className={PALETTE_HEADING_CLASS} data-search-group>
              {group.task ? <MessageSquare className="h-3 w-3" /> : <Users className="h-3 w-3" />}
              <span className="truncate font-medium">{group.label}</span>
              {group.task && <span className="shrink-0 text-foreground/35">· {translate('globalSearch.task')}</span>}
              {group.hits.some((hit) => hit.id === selected?.id) && <button type="button" className="ml-auto shrink-0 text-foreground/35 hover:text-foreground/70"
                onClick={() => setChips([...chips, group.scope])}>{translate('globalSearch.scopeTo')}</button>}
            </div>}
            {group.hits.map((hit) => {
              const isSelected = hit.id === selected?.id
              const sender = hit.kind === 'message' ? hit.sender : translate(hit.role === 'assistant' ? 'globalSearch.agent' : 'globalSearch.you')
              return (
                <button type="button" role="option" aria-selected={isSelected} data-selected={isSelected} key={hit.id}
                  onMouseMove={() => { if (!isSelected) updateSearchSession({ selectedId: hit.id }) }}
                  onClick={() => open(hit)}
                  className={cn(PALETTE_ITEM_CLASS, 'w-full items-start gap-3 text-left outline-none')}>
                  <span className="mt-1 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-foreground/[0.07] text-[length:var(--font-caption)] font-medium text-foreground/55">
                    {hit.kind === 'message' && hit.file ? <FileText size={11} /> : Array.from(sender)[0]}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 text-sm leading-5 text-foreground/85"><Highlighted text={hit.text} query={view.query} /></span>
                    <span className="mt-1 flex items-center gap-2 text-xs text-foreground/40">
                      <span className="truncate">{sender}</span>
                      <span aria-hidden>·</span><span className="shrink-0 tabular-nums">{formatWhen(hit.at)}</span>
                    </span>
                  </span>
                  {isSelected && <span className="mt-1 shrink-0 text-foreground/35 max-sm:hidden"><Shortcut hotkey="Enter" variant="keycaps" /></span>}
                </button>
              )
            })}
          </Fragment>
        ))}
      </div>

      <PaletteFooter completion><Shortcut hotkey="Escape" variant="keycaps" />{translate('globalSearch.hintClose')}</PaletteFooter>
    </div>
  )
}
