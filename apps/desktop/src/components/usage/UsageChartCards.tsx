import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AreaChart, BarChart3, Clock, PieChart, TrendingUp, WalletCards } from '@/lib/icons'
import { rankModels, stackedPoints, type ModelAmount } from '../../lib/usage/charts'
import type { DayRange } from '../../lib/usage/derive'
import { ChartCard, SegSwitch, type Tone } from './UsageParts'
import { heightPx } from './format'

// 用量看板的两张卡:「消耗分布」(柱状/面积二选一)与「模型调用分析」(趋势/分布/排行三页签)。
// 图本体在 UsageCharts.tsx,懒加载。

const StackedChart = lazy(() => import('./UsageCharts').then((m) => ({ default: m.StackedChart })))
const ShareChart = lazy(() => import('./UsageCharts').then((m) => ({ default: m.ShareChart })))
const RankChart = lazy(() => import('./UsageCharts').then((m) => ({ default: m.RankChart })))
const HourChart = lazy(() => import('./UsageCharts').then((m) => ({ default: m.HourChart })))

function ChartSlot({ empty, children }: { empty: boolean; children: ReactNode }) {
  const { t } = useTranslation('settings')
  if (empty) return <div className="na-empty"><span>{t('usage.na.emptyChart')}</span></div>
  return <Suspense fallback={<div className="gg-usage-skeleton" style={heightPx(360)} />}>{children}</Suspense>
}

export function ConsumptionCard({ amounts, range, format, testId }: { amounts: ModelAmount[]; range: DayRange; format: (n: number) => string; testId?: string }) {
  const { t } = useTranslation('settings')
  const [mode, setMode] = useState<'bar' | 'area'>('bar')
  const other = t('usage.na.other')
  const { points, domain, total } = useMemo(() => stackedPoints(amounts, range, 10, other), [amounts, range, other])
  return (
    <ChartCard icon={<WalletCards />} tone="success" title={t('usage.na.consumption')} total={format(total)} testId={testId}
      actions={<SegSwitch label={t('usage.na.consumption')} value={mode} onChange={setMode} items={[
        { value: 'bar', label: t('usage.na.bar'), icon: <BarChart3 />, testId: 'usage-consumption-bar' },
        { value: 'area', label: t('usage.na.area'), icon: <AreaChart />, testId: 'usage-consumption-area' },
      ]} />}>
      <ChartSlot empty={total === 0}>
        <StackedChart mode={mode} points={points} domain={domain} format={format} totalLabel={t('usage.na.total')} otherLabel={other} />
      </ChartSlot>
    </ChartCard>
  )
}

type AnalysisTab = 'trend' | 'share' | 'rank'

/** kind=calls:「调用」口径(积分明细里的请求次数);kind=tokens:本机日志里各模型的 token。 */
export function ModelAnalysisCard({ amounts, range, kind, format, testId, filter }: {
  amounts: ModelAmount[]; range: DayRange; kind: 'calls' | 'tokens'; format: (n: number) => string; testId?: string
  /** 卡头右侧、页签左边的额外筛选(模型用量卡用它切「咕咕模型 / 自己账号」)。 */
  filter?: ReactNode
}) {
  const { t } = useTranslation('settings')
  const [tab, setTab] = useState<AnalysisTab>('trend')
  const other = t('usage.na.other')
  const stacked = useMemo(() => stackedPoints(amounts, range, 10, other), [amounts, range, other])
  const ranked = useMemo(() => rankModels(amounts, range, 20, other), [amounts, range, other])
  const labels = kind === 'calls'
    ? { title: t('usage.na.modelCalls'), trend: t('usage.na.callTrend'), share: t('usage.na.callShare'), rank: t('usage.na.callRank') }
    : { title: t('usage.na.modelTokens'), trend: t('usage.na.tokenTrend'), share: t('usage.na.tokenShare'), rank: t('usage.na.tokenRank') }
  const tone: Tone = 'chart-4'
  return (
    <ChartCard icon={<PieChart />} tone={tone} title={labels.title} total={format(stacked.total)} testId={testId}
      actions={<div className="na-card-actions">{filter}<SegSwitch label={labels.title} value={tab} onChange={setTab} items={[
        { value: 'trend', label: labels.trend, icon: <TrendingUp />, testId: `${testId}-trend` },
        { value: 'share', label: labels.share, icon: <PieChart />, testId: `${testId}-share` },
        { value: 'rank', label: labels.rank, icon: <BarChart3 />, testId: `${testId}-rank` },
      ]} /></div>}>
      <ChartSlot empty={stacked.total === 0}>
        {tab === 'trend' && <StackedChart mode="area" points={stacked.points} domain={stacked.domain} format={format} totalLabel={t('usage.na.total')} otherLabel={other} />}
        {tab === 'share' && <ShareChart totals={ranked} format={format} />}
        {tab === 'rank' && <RankChart totals={ranked} format={format} />}
      </ChartSlot>
    </ChartCard>
  )
}

export function RhythmCard({ hours, hint, format }: { hours: number[]; hint: string; format: (n: number) => string }) {
  const { t } = useTranslation('settings')
  return (
    <ChartCard icon={<Clock />} tone="info" title={t('usage.na.rhythm')} testId="usage-rhythm"
      actions={<span className="gg-usage-caption">{hint}</span>}>
      <ChartSlot empty={hours.every((h) => h === 0)}>
        <HourChart hours={hours} seriesLabel={t('usage.na.colSessions')} format={format} />
      </ChartSlot>
    </ChartCard>
  )
}
