import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Database } from '@/lib/icons'
import { formatNumber } from '@/i18n'
import { resolveModelProvider } from '../../session/renderer/features/sessions/session-config/model-provider'
import { modelProviderIcon } from '../../session/renderer/features/sessions/session-config/model-provider-icon'
import { swatch } from './format'
import { Button } from '../ui/Button'
import { PAGE_SIZES, pageNumbers, stringToColor } from '../../lib/usage/table'

// 用量页共用的几件:统计条、图表卡、模型标签、表格、分页器。

export type Tone = 'info' | 'success' | 'warning' | 'chart-2' | 'chart-4'

export function IconBadge({ icon, tone, size = 'sm' }: { icon: ReactNode; tone: Tone; size?: 'sm' | 'stat' }) {
  return <span className="na-icon-badge" data-tone={tone} data-size={size} aria-hidden="true">{icon}</span>
}

export type StatItem = { key: string; title: string; value: string; icon: ReactNode; tone: Tone; description?: string }

/** 统计条:一条带竖分隔的横排数字格。 */
export function StatStrip({ items, testId }: { items: StatItem[]; testId?: string }) {
  return (
    <div className="na-stats" data-testid={testId}>
      <div className="na-stats-grid" data-cols={items.length}>
        {items.map((item) => (
          <div className="na-stat" key={item.key} data-testid={testId ? `${testId}-${item.key}` : undefined}>
            <div className="na-stat-title">
              <IconBadge icon={item.icon} tone={item.tone} size="stat" />
              <span className="na-stat-label">{item.title}</span>
            </div>
            <div className="na-stat-value">{item.value}</div>
            {item.description && <div className="na-stat-desc">{item.description}</div>}
          </div>
        ))}
      </div>
    </div>
  )
}

/** 图表卡:头部(图标 + 标题 + 总计 + 右侧切换)+ 固定高度的图区。 */
export function ChartCard({ icon, tone, title, total, actions, children, testId }: {
  icon: ReactNode; tone: Tone; title: string; total?: string; actions?: ReactNode; children: ReactNode; testId?: string
}) {
  const { t } = useTranslation('settings')
  return (
    <div className="na-card" data-testid={testId}>
      <div className="na-card-head">
        <div className="na-card-title">
          <IconBadge icon={icon} tone={tone} />
          <b>{title}</b>
          {total !== undefined && <span>{t('usage.na.total')}{total}</span>}
        </div>
        {actions}
      </div>
      <div className="na-card-body">{children}</div>
    </div>
  )
}

/** 分段切换:bg-muted/60 的槽 + 选中项 bg-background shadow-sm。 */
export function SegSwitch<T extends string>({ value, onChange, items, label }: {
  value: T; onChange: (v: T) => void; items: { value: T; label: string; icon?: ReactNode; testId?: string }[]; label: string
}) {
  return (
    <div className="na-seg" role="group" aria-label={label}>
      {items.map((item) => (
        <Button key={item.value} variant="ghost" size="sm" className="na-seg-item" aria-pressed={item.value === value}
          onClick={() => onChange(item.value)} data-testid={item.testId}>
          {item.icon}{item.label}
        </Button>
      ))}
    </div>
  )
}

/** 模型标签:厂商图标(认不出就是一颗按名字取色的点)+ 模型名;点一下复制。 */
export function ModelBadge({ model, icon }: { model: string; icon?: ReactNode }) {
  const { t } = useTranslation('settings')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(timer)
  }, [copied])
  const glyph = icon ?? modelProviderIcon(resolveModelProvider(model))
  return (
    <span className="na-badge" role="button" tabIndex={0} title={copied ? t('usage.na.copied') : model}
      onClick={() => { void navigator.clipboard?.writeText(model).then(() => setCopied(true), () => {}) }}
      onKeyDown={(e) => { if (e.key === 'Enter') void navigator.clipboard?.writeText(model).then(() => setCopied(true), () => {}) }}>
      {glyph ? <span className="na-badge-icon">{glyph}</span> : <span className="na-badge-dot" style={swatch(stringToColor(model))} />}
      <span>{model}</span>
    </span>
  )
}

export function EmptyRows({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="na-empty" data-testid="usage-na-empty">
      <span className="na-empty-icon"><Database size={16} /></span>
      <b>{title}</b>
      {hint && <span>{hint}</span>}
    </div>
  )
}

/** 分页器:右对齐的「总计 / 每页行数 / 首·上·页码·下·末」。 */
export function Pagination({ page, pageSize, total, onPage, onPageSize }: {
  page: number; pageSize: number; total: number; onPage: (p: number) => void; onPageSize: (s: number) => void
}) {
  const { t } = useTranslation('settings')
  const pages = Math.max(1, Math.ceil(total / pageSize))
  return (
    <div className="na-pager" data-testid="usage-pager">
      <span className="na-pager-total"><span>{t('usage.na.total')}</span>{formatNumber(total)}</span>
      <label className="na-pager-size">
        {t('usage.na.rowsPerPage')}
        <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))} data-testid="usage-pager-size">
          {PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
        </select>
      </label>
      <div className="na-pager-btns">
        <Button variant="secondary" size="icon" className="na-pager-btn na-pager-edge" aria-label={t('usage.na.firstPage')} disabled={page <= 1} onClick={() => onPage(1)}><ChevronsLeft /></Button>
        <Button variant="secondary" size="icon" className="na-pager-btn" aria-label={t('usage.na.prevPage')} disabled={page <= 1} onClick={() => onPage(page - 1)}><ChevronLeft /></Button>
        {pageNumbers(page, pages).map((n, i) => n === 'ellipsis'
          ? <span key={`e${i}`} className="na-pager-ellipsis">…</span>
          : <Button key={n} variant={n === page ? 'primary' : 'secondary'} size="icon" className="na-pager-btn" aria-current={n === page ? 'page' : undefined}
            onClick={() => onPage(n)} data-testid={`usage-page-${n}`}>{n}</Button>)}
        <Button variant="secondary" size="icon" className="na-pager-btn" aria-label={t('usage.na.nextPage')} disabled={page >= pages} onClick={() => onPage(page + 1)}><ChevronRight /></Button>
        <Button variant="secondary" size="icon" className="na-pager-btn na-pager-edge" aria-label={t('usage.na.lastPage')} disabled={page >= pages} onClick={() => onPage(pages)}><ChevronsRight /></Button>
      </div>
    </div>
  )
}
