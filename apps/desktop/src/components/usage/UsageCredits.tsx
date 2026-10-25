import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CreditUsageDay } from '@gugu/core/shared/usage/dailyUsage'
import { formatDate, formatNumber } from '@/i18n'
import { CalendarClock, Coins, Crown, Gauge, Hash, Layers, ShieldCheck, SquareArrowRight, Zap } from '@/lib/icons'
import { GUGU_BILLING_URL } from '../../lib/appLinks'
import { useAuth } from '../../store/auth'
import {
  daysUntilExpiry,
  describeSpendingPower,
  formatCredits,
  formatUsageCredits,
  getMembership,
  periodUsdFor,
  quotaWindowLabel,
  quotaWindowViews,
  useSpendingPower,
  type Membership,
} from '../../lib/billing'
import { type DayRange } from '../../lib/usage/derive'
import { creditAmounts, perMinute } from '../../lib/usage/charts'
import { fetchLedgerPage, type LedgerRow } from '../../lib/usage/cloud'
import { SectionLabel } from '../ui/SectionLabel'
import { Button } from '../ui/Button'
import { QuotaMeter } from '../credits/QuotaMeter'
import { compact, plain } from './format'
import { EmptyRows, IconBadge, ModelBadge, Pagination, StatStrip } from './UsageParts'
import { ConsumptionCard, ModelAnalysisCard } from './UsageChartCards'
import { ReferralCard } from './ReferralCard'
import type { Loadable } from './useUsageData'
import { desktopIpc } from '../../platform/desktopIpc'

// 用量页的「积分」段 —— 原先侧栏那个积分小面板(CreditsPanel)的全部内容搬到这里,下面接
// 数据看板与使用日志的那一套:统计条 → 消耗分布 → 模型调用分析 → 使用日志(分页表)。
//
// 这一段不内置任何额度政策。窗口长度、上限、对应美元全部来自服务端一行配置,计费说明里的
// 句子都是用返回值拼的 —— 运营改配置不该需要发客户端。取不到就说取不到,不编造数字(#2503)。

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const EMPTY: CreditUsageDay[] = []

export function UsageCredits({ credits, guguTokens, range }: {
  credits: Loadable<CreditUsageDay[]>
  /** 这段时间走咕咕模型的 token(本机日志口径、含缓存,与「活跃」页同一份汇总);null = 还没到或取不到。 */
  guguTokens: Loadable<number>
  range: DayRange
}) {
  const { t } = useTranslation('settings')
  const rows = credits.status === 'ready' ? credits.value : EMPTY
  const creditValues = useMemo(() => creditAmounts(rows, 'credits'), [rows])
  const requestValues = useMemo(() => creditAmounts(rows, 'requests'), [rows])
  const formatCreditsValue = (n: number) => plain(n, 2)
  const formatCalls = (n: number) => plain(n)
  return (
    <section className="gg-usage-section" aria-labelledby="usage-credits" data-testid="usage-credits">
      <SectionLabel id="usage-credits">
        {t('usage.credits')}
      </SectionLabel>
      <CreditsOverview />
      <ReferralCard />
      {credits.status === 'loading' && <div className="gg-usage-skeleton gg-usage-bars" data-testid="usage-credits-loading" />}
      {credits.status === 'error' && <span className="gg-usage-muted" data-testid="usage-credit-bars-error" title={credits.error}>{t('usage.loadError')}</span>}
      {credits.status === 'ready' && (
        <>
          <CreditStats rows={rows} range={range} guguTokens={guguTokens} />
          <ConsumptionCard amounts={creditValues} range={range} format={formatCreditsValue} testId="usage-consumption" />
          <ModelAnalysisCard amounts={requestValues} range={range} kind="calls" format={formatCalls} testId="usage-model-calls" />
        </>
      )}
      <Ledger />
    </section>
  )
}

/**
 * 使用日志顶上那条统计:总数 / 总积分 / 总 Token 数 / 平均 RPM / 平均 TPM,口径是当前时间段。
 * Token 与「活跃」页的「咕咕模型 Token」是同一个数、同一个来源(本机日志汇总,含缓存读写)——
 * ❌ 用计费记录的 token:不同协议的网关对缓存的归法不同,#6660 之前的计费行也没记缓存,两页会对不上。
 */
function CreditStats({ rows, range, guguTokens }: { rows: CreditUsageDay[]; range: DayRange; guguTokens: Loadable<number> }) {
  const { t } = useTranslation('settings')
  let requests = 0, credits = 0
  for (const row of rows) {
    if (row.day < range.from || row.day > range.to) continue
    requests += row.requests; credits += row.credits
  }
  const now = new Date()
  const tokens = guguTokens.status === 'ready' ? guguTokens.value : null
  return (
    <StatStrip testId="usage-credit-stats" items={[
      { key: 'calls', title: t('usage.na.statCalls'), value: plain(requests), icon: <Hash />, tone: 'info' },
      { key: 'credits', title: t('usage.na.statCredits'), value: plain(credits, 2), icon: <Coins />, tone: 'success' },
      { key: 'tokens', title: t('usage.na.statTokens'), value: tokens === null ? '—' : compact(tokens), icon: <Layers />, tone: 'chart-4',
        description: guguTokens.status === 'error' ? t('usage.unavailable') : t('usage.na.statTokensHint') },
      { key: 'rpm', title: t('usage.na.statRpm'), value: plain(perMinute(requests, range, now), 3), icon: <Gauge />, tone: 'chart-2' },
      { key: 'tpm', title: t('usage.na.statTpm'), value: tokens === null ? '—' : plain(perMinute(tokens, range, now), 0), icon: <Zap />, tone: 'warning' },
    ]} />
  )
}

/**
 * 余额、会员、本周期刻度、计费说明 —— 与原积分面板同一套口径和同一套诚实性约束。
 * 版式是「用量概览」:一张卡左右两栏,左栏讲会员与本周期额度,右栏是渐变底的余额面板
 * (大数字 + 两个小格 + 去「会员与额度」的按钮),右上角一颗状态点。
 */
function CreditsOverview() {
  const { t } = useTranslation('settings')
  const { user } = useAuth()
  const { balanceError, windows, windowsError, power, activityRevision } = useSpendingPower(user)
  // undefined = 还没回来;null = 后端没有这一行。取失败单独一格,❌ 折成「免费档」——
  // 那会让付了钱的人在一次网络抖动后看见自己被降级(同 MembershipStatus)。
  const [membership, setMembership] = useState<Membership | null | undefined>(undefined)
  const [membershipError, setMembershipError] = useState<string | null>(null)
  // 免费额度跟设备走:这台设备名额已满时说一句(主进程登录时认领的结果);其余状态什么都不显示。
  const [deviceFull, setDeviceFull] = useState(false)
  useEffect(() => {
    let alive = true
    void desktopIpc()?.invoke('device:free-credits-status')
      .then((s) => { if (alive) setDeviceFull(s === 'device_full') }, () => undefined)
    return () => { alive = false }
  }, [user?.id])

  useEffect(() => {
    let alive = true
    setMembershipError(null)
    getMembership()
      .then((m) => { if (alive) { setMembership(m); setMembershipError(null) } })
      .catch((e: unknown) => { if (alive) setMembershipError(message(e)) })
    return () => { alive = false }
  }, [activityRevision, user?.id])

  const views = windows ? quotaWindowViews(windows) : null
  const periodUsd = windows ? periodUsdFor(windows) : null
  const remainingDays = membership ? daysUntilExpiry(membership.expiresAt) : null
  const copy = power ? describeSpendingPower(power) : null
  // 余额与额度都还在路上 → 占位;任一取不到 → 各自那一行说取不到(不连坐、不折成 0)。
  const pending = !copy && !windowsError && !balanceError
  const status = copy ? (copy.blocked ? 'blocked' : 'ok') : null

  return (
    <div className="na-overview" data-testid="usage-credits-overview">
      <div className="na-overview-main">
        <div className="na-overview-head">
          <IconBadge icon={<Crown />} tone="warning" />
          <b>{t('usage.na.membership')}</b>
          {membership && (
            <span className="na-status"><i data-tone={membership.tier === 'free' ? 'muted' : 'success'} />
              {t(membership.tier === 'free' ? 'usage.na.membershipFree' : 'usage.na.membershipActive')}
            </span>
          )}
        </div>
        {/* 两个到期日不是一回事:会员额度每个周期清零重算(windows.period_ends_at),会员本身到期后
            降回免费档(subscription_expires_at)。官方会员口径「续费与到期」要求两件事用户始终看得到。 */}
        <div className="na-sub" data-testid="usage-credits-membership">
          {membershipError !== null && (
            <span data-testid="usage-credits-membership-error" className="gg-usage-muted">
              {t('membership.statusError', { error: membershipError })}
            </span>
          )}
          {membershipError === null && membership === undefined && <span className="gg-usage-muted">{t('credits.loading')}</span>}
          {membershipError === null && membership && (
            <div className="na-sub-row">
              <span data-testid="usage-credits-membership-status" className="na-sub-title">
                {t(`membership.tier.${membership.tier}`)}
                {membership.expiresAt && remainingDays !== null && ` · ${t('membership.expiresOn', {
                  date: formatDate(membership.expiresAt, { year: 'numeric', month: 'long', day: 'numeric' }),
                  days: formatNumber(remainingDays),
                })}`}
              </span>
            </div>
          )}
          {deviceFull && <span data-testid="usage-credits-device-full" className="na-sub-meta">{t('usage.na.deviceFull')}</span>}
          {windows && (
            <span data-testid="usage-credits-period-reset" className="na-sub-meta">
              {t('credits.periodResetsOn', { date: formatDate(windows.period_ends_at, { month: 'long', day: 'numeric' }) })}
            </span>
          )}
          {/* 额度取不到就整段不画 —— 宁可少一段,也不留含义不明的进度条。 */}
          {!windowsError && views && (
            <div className="na-sub-meter">
              <QuotaMeter window={views.period} testId="usage-credits-period" />
              <span className="na-sub-meta">
                {t('usage.na.periodUsedPercent', { percent: plain(views.period.usedRatio * 100) })}
              </span>
            </div>
          )}
        </div>
        {views && windows && periodUsd !== null && (
          <p className="na-footnote">
            {t('credits.billingCopy', {
              periodLabel: quotaWindowLabel(views.period.hours),
              periodCredits: formatCredits(windows.period_credits),
              // 显式钉住两位小数:120 ÷ 18 否则会渲染成 $6.667。
              usd: formatNumber(periodUsd, { maximumFractionDigits: 2 }),
              endDate: formatDate(windows.period_ends_at, { month: 'long', day: 'numeric' }),
            })}
          </p>
        )}
        {windows && windows.outstanding_credits > 0 && (
          <p className="na-footnote">{t('credits.reservedCopy', { credits: formatCredits(windows.outstanding_credits) })}</p>
        )}
      </div>

      <div className="na-overview-balance">
        <div className="na-balance-top">
          <span className="na-balance-label">{t('credits.spendable')}</span>
          {status && (
            <span className="na-status"><i data-tone={status === 'blocked' ? 'destructive' : 'success'} />
              {t(status === 'blocked' ? 'usage.na.balanceBlocked' : 'usage.na.balanceOk')}
            </span>
          )}
        </div>
        {/* 报的是**合计**:会员额度 + 不过期积分。窗口取不到就是取不到 —— ❌ 拿不过期积分单独顶上冒充合计,
            更❌ 拿 0 冒充「你没有积分」。 */}
        <div className="na-balance-value gg-type-display" data-testid="usage-credits-balance">{power === null ? '--' : formatCredits(power.spendable)}</div>
        {copy && (
          <p className="na-balance-rate" data-blocked={copy.blocked || undefined} data-testid="usage-credits-window-summary">{copy.rate}</p>
        )}
        {balanceError && <p className="na-balance-rate">{t('credits.balanceError', { error: balanceError })}</p>}
        {!copy && windowsError && (
          <p className="na-balance-rate" data-testid="usage-credits-error">{t('credits.quotaError', { error: windowsError })}</p>
        )}
        {pending && <p className="na-balance-rate" data-testid="usage-credits-windows-loading">{t('credits.loading')}</p>}
        {/* 两种积分的过期语义不同(周期额度本期不结转、不过期积分永远在),同屏展示时必须分得出。 */}
        {power && (
          <div className="na-balance-cells" data-testid="usage-credits-breakdown">
            <div className="na-balance-cell">
              <span><CalendarClock />{t('usage.na.periodCredits')}</span>
              <b data-testid="usage-credits-period-credits">{formatCredits(power.periodCredits)}</b>
            </div>
            <div className="na-balance-cell">
              <span><ShieldCheck />{t('usage.na.walletCredits')}</span>
              <b data-testid="usage-credits-wallet-credits">{formatCredits(power.walletCredits)}</b>
            </div>
          </div>
        )}
        {/* 买会员、买加量包、兑礼品码、看购买记录都在网页面板(owner 2026-08-24:app 里不硬编码营销套餐,
            价格烧进包里就是对着用户报错价)。这里只给一条去路,位置在余额面板底部那颗「钱包 →」。
            用 <a target="_blank">:Electron 的 window.open 拦截会交给系统浏览器,支付在用户自己的浏览器里完成。 */}
        <a href={GUGU_BILLING_URL} target="_blank" rel="noreferrer" className="na-balance-link" data-testid="membership-open-web">
          <Button variant="primary" size="md" className="na-balance-button">
            {t('usage.na.openWebBilling')}<SquareArrowRight />
          </Button>
        </a>
      </div>
    </div>
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
function Ledger() {
  const { t } = useTranslation('settings')
  const [draft, setDraft] = useState('')
  const [model, setModel] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [rows, setRows] = useState<LedgerRow[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    setBusy(true)
    fetchLedgerPage({ page, pageSize, model })
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
  }, [page, pageSize, model])

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
