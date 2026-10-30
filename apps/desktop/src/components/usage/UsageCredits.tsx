import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CreditUsageDay } from '@gugu/core/shared/usage/dailyUsage'
import { formatNumber } from '@/i18n'
import { formatUsageCredits } from '../../lib/billing'
import { type DayRange } from '../../lib/usage/derive'
import { creditAmounts } from '../../lib/usage/charts'
import { fetchLedgerPage, type LedgerRow } from '../../lib/usage/cloud'
import { Button } from '../ui/Button'
import { plain } from './format'
import { EmptyRows, ModelBadge, Pagination } from './UsageParts'
import { ConsumptionCard, ModelAnalysisCard } from './UsageChartCards'
import type { Loadable } from './useUsageData'

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
const EMPTY: CreditUsageDay[] = []

/** Account consumption follows the page period; balances and membership belong in subscriptions. */
export function UsageCredits({ credits, range }: {
  credits: Loadable<CreditUsageDay[]>
  range: DayRange
}) {
  const { t } = useTranslation('settings')
  const rows = credits.status === 'ready' ? credits.value : EMPTY
  const creditValues = useMemo(() => creditAmounts(rows, 'credits'), [rows])
  const requestValues = useMemo(() => creditAmounts(rows, 'requests'), [rows])
  return (
    <section className="gg-usage-section" data-testid="usage-credits">
      {credits.status === 'loading' && <div className="gg-usage-skeleton gg-usage-bars" data-testid="usage-credits-loading" />}
      {credits.status === 'error' && <span className="gg-usage-muted" data-testid="usage-credit-bars-error" title={credits.error}>{t('usage.loadError')}</span>}
      {credits.status === 'ready' && (
        <>
          <ConsumptionCard amounts={creditValues} range={range} format={(n: number) => plain(n, 2)} testId="usage-consumption" />
          <ModelAnalysisCard amounts={requestValues} range={range} kind="calls" format={(n: number) => plain(n)} testId="usage-model-calls" />
        </>
      )}
      <Ledger range={range} />
    </section>
  )
}

function pad(n: number) { return String(n).padStart(2, '0') }
/** 时间列:YYYY-MM-DD HH:mm:ss,本地时区。 */
function stamp(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const DEFAULT_PAGE_SIZE = 20

/**
 * 使用日志表 —— 时间 / 模型 / Tokens / 费用,顶上是「模型名称」筛选,底下是分页器
 * (❌ 一路往下滚的长列表)。总数是库里精确计数,翻页按页码取。
 */
function Ledger({ range }: { range: DayRange }) {
  const { t } = useTranslation('settings')
  const [draft, setDraft] = useState('')
  const [model, setModel] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [pageRange, setPageRange] = useState({ from: range.from, to: range.to })
  // 时段变化只重置页码,模型筛选和每页行数保持。调整发生在同组件渲染内,不提交旧页的查询。
  if (pageRange.from !== range.from || pageRange.to !== range.to) {
    setPageRange({ from: range.from, to: range.to })
    setPage(1)
  }
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [rows, setRows] = useState<LedgerRow[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    setBusy(true)
    fetchLedgerPage({ page, pageSize, model, range: { from: range.from, to: range.to } })
      .then((result) => {
        if (!alive) return
        // 翻到了已经不存在的页(别处刚删过数据、或换了每页行数)→ 退到最后一页。
        const last = Math.max(1, Math.ceil(result.total / pageSize))
        if (page > last) { setPage(last); return }
        setRows(result.rows); setTotal(result.total); setError(null)
      })
      .catch((e: unknown) => { if (alive) setError(message(e)) })
      .finally(() => { if (alive) setBusy(false) })
    return () => { alive = false }
  }, [page, pageSize, model, range.from, range.to])

  const search = () => { setModel(draft.trim() || null); setPage(1) }
  const reset = () => { setDraft(''); setModel(null); setPage(1) }

  return (
    <div className="grid gap-[var(--spacing-md)]" data-testid="usage-ledger">
      <div className="gg-usage-caption">{t('usage.na.logs')}</div>
      <form className="na-filter" onSubmit={(e) => { e.preventDefault(); search() }}>
        <input className="na-input" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t('usage.na.modelName')}
          aria-label={t('usage.na.modelName')} data-testid="usage-ledger-model" />
        <Button variant="secondary" size="md" onClick={reset} data-testid="usage-ledger-reset">{t('usage.na.reset')}</Button>
        <Button type="submit" variant="primary" size="md" data-testid="usage-ledger-search">{t('usage.na.search')}</Button>
      </form>
      {error !== null && (
        <span data-testid="usage-ledger-error" className="gg-usage-muted" title={error}>{t('credits.activityError', { error })}</span>
      )}
      <div className="na-table-wrap" data-busy={busy && rows !== null ? '' : undefined}>
        <table className="na-table na-table--ledger" data-testid="usage-ledger-rows">
          <thead>
            <tr>
              <th>{t('usage.na.colTime')}</th><th>{t('usage.na.colModel')}</th><th>{t('usage.na.colTokens')}</th><th>{t('usage.na.colCost')}</th>
            </tr>
          </thead>
          <tbody>
            {rows === null && error === null && Array.from({ length: 5 }, (_, i) => (
              <tr key={i} className="na-skel-row">{[0, 1, 2, 3].map((c) => <td key={c}><div className="na-skel" /></td>)}</tr>
            ))}
            {rows !== null && rows.length > 0 && rows.map((row) => (
              <tr key={row.id}>
                <td data-field="time" data-label={t('usage.na.colTime')}>
                  <div className="na-cell-stack">
                    <span className="na-mono-xs">{stamp(row.created_at)}</span>
                    <span className="na-type">{t('usage.na.typeConsume')}</span>
                  </div>
                </td>
                <td data-field="model" data-label={t('usage.na.colModel')}>{row.model ? <ModelBadge model={row.model} /> : <span className="gg-usage-muted">{t('credits.modelUsage')}</span>}</td>
                <td data-field="tokens" data-label={t('usage.na.inputOutputTokens')}>
                  <div className="na-cell-stack">
                    <span className="na-mono-xs">{`${formatNumber(row.input_tokens)} / ${formatNumber(row.output_tokens)}`}</span>
                    {/* 缓存行:读 ↓、写 ↑,为 0 的那项不写。 */}
                    {(row.cache_read_tokens > 0 || row.cache_creation_tokens > 0) && (
                      <span className="na-sub-meta" data-testid="usage-ledger-cache">
                        {[t('usage.na.cache'),
                          row.cache_read_tokens > 0 && `↓ ${formatNumber(row.cache_read_tokens)}`,
                          row.cache_creation_tokens > 0 && `↑ ${formatNumber(row.cache_creation_tokens)}`,
                        ].filter(Boolean).join(' ')}
                      </span>
                    )}
                  </div>
                </td>
                <td data-field="cost" data-label={t('usage.na.colCost')}><span className="na-cost">{formatUsageCredits(row.credits_charged)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows !== null && rows.length === 0 && error === null && <EmptyRows title={t('usage.na.empty')} hint={model ? t('usage.na.emptyHint') : undefined} />}
      </div>
      {rows !== null && total > 0 && (
        <Pagination page={page} pageSize={pageSize} total={total} onPage={setPage}
          onPageSize={(size) => { setPageSize(size); setPage(1) }} />
      )}
    </div>
  )
}
