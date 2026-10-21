import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, Clock3, MessageSquare } from '@/lib/icons'
import type { ImportedSessionHistory } from '../lib/importedHistoryReader'
import { formatCalendarDay } from '../lib/calendarTime'

interface ImportedHistoryPanelProps {
  histories: ImportedSessionHistory[]
  loading: boolean
  error: string | null
}

const iconButtonClass =
  'gg-pressable grid size-9 shrink-0 cursor-pointer place-items-center rounded-lg border-none bg-transparent text-[var(--muted-fg)] hover:bg-[var(--hover)] hover:text-[var(--fg)]'

export function ImportedHistoryPanel({ histories, loading, error }: ImportedHistoryPanelProps) {
  const { t } = useTranslation('messaging')
  const [selectedRootId, setSelectedRootId] = useState<string | null>(null)
  const selected = histories.find((history) => history.rootId === selectedRootId) ?? null
  const detailBackRef = useRef<HTMLButtonElement>(null)
  const historyItemRefs = useRef(new Map<string, HTMLButtonElement>())
  const returnFocusRootIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (selectedRootId && !histories.some((history) => history.rootId === selectedRootId)) setSelectedRootId(null)
  }, [histories, selectedRootId])

  useEffect(() => {
    if (selectedRootId) {
      detailBackRef.current?.focus()
      return
    }
    const rootId = returnFocusRootIdRef.current
    if (!rootId) return
    historyItemRefs.current.get(rootId)?.focus()
    returnFocusRootIdRef.current = null
  }, [selectedRootId])

  return (
    <section
      aria-label={selected ? undefined : t('importedHistory.label')}
      aria-labelledby={selected ? 'imported-history-detail-title' : undefined}
      className="min-h-0"
    >
      {selected ? (
        <header className="mb-2 flex min-h-10 items-center gap-2 border-b border-[var(--border)] pb-2">
          <button ref={detailBackRef} className={iconButtonClass} type="button" aria-label={t('importedHistory.backToList')} title={t('common.back')} onClick={() => setSelectedRootId(null)}>
            <ChevronLeft size={20} />
          </button>
          <p id="imported-history-detail-title" className="min-w-0 flex-1 truncate text-xs text-[var(--faint-fg)]">{selected.title}</p>
        </header>
      ) : null}

      <div>
        {loading ? <div className="py-10 text-center text-sm text-[var(--faint-fg)]">{t('common.loading')}</div> : null}
        {!loading && error ? (
          <div role="alert" className="rounded-lg border border-[var(--danger)] px-3 py-3 text-sm text-[var(--danger)]">{error}</div>
        ) : null}
        {!loading && !error && histories.length === 0 ? (
          <div className="py-10 text-center text-sm text-[var(--faint-fg)]">{t('history.empty.imported')}</div>
        ) : null}

        {!loading && !error && !selected ? (
          <div className="flex flex-col gap-1">
            {histories.map((history) => (
              <button
                key={history.rootId}
                ref={(node) => {
                  if (node) historyItemRefs.current.set(history.rootId, node)
                  else historyItemRefs.current.delete(history.rootId)
                }}
                type="button"
                data-testid={`imported-history-item-${history.rootId}`}
                className="grid min-h-[64px] w-full cursor-pointer grid-cols-[36px_minmax(0,1fr)] items-center gap-3 rounded-lg border-none bg-transparent px-2 py-2 text-left hover:bg-[var(--hover)]"
                aria-label={t('importedHistory.view', { title: history.title })}
                onClick={() => {
                  returnFocusRootIdRef.current = history.rootId
                  setSelectedRootId(history.rootId)
                }}
              >
                <span className="grid size-9 place-items-center rounded-lg bg-[var(--muted)] text-[var(--muted-fg)]" aria-hidden>
                  <Clock3 size={18} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[length:var(--font-body)] font-medium text-[var(--fg)]">{history.title}</span>
                  <span className="mt-1 flex items-center gap-1.5 text-xs text-[var(--faint-fg)]">
                    <MessageSquare size={13} />
                    {t('importedHistory.turnMeta', { count: history.turns.length, date: formatCalendarDay(history.createdAt) })}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : null}

        {!loading && !error && selected ? (
          <section data-testid="imported-history-turns" aria-label={selected.title} className="flex flex-col">
            {selected.turns.map((turn) => (
              <article key={turn.id} className="border-b border-[var(--border)] px-1 py-3 last:border-b-0">
                <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
                  <span className="font-medium text-[var(--muted-fg)]">{turn.role === 'user' ? t('importedHistory.userRole') : t('importedHistory.agentRole')}</span>
                  <time className="shrink-0 text-[var(--faint-fg)]" dateTime={turn.createdAt}>{formatCalendarDay(turn.createdAt)}</time>
                </div>
                <p className="whitespace-pre-wrap break-words text-[length:var(--font-prose)] leading-[var(--lh-prose)] text-[var(--fg)]">{turn.content}</p>
              </article>
            ))}
          </section>
        ) : null}
      </div>
    </section>
  )
}
