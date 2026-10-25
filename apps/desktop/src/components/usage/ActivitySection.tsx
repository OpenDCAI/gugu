import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { UsageDay } from '@gugu/core/shared/usage/dailyUsage'
import { formatDate, useLocale } from '@/i18n'
import { useAuth } from '../../store/auth'
import { useDevicesStore } from '../../store/devicesContext'
import { useDisplayDevices } from '../../hooks/useAssistantHomeLabel'
import { SegmentedTabs } from '../ui/SegmentedTabs'
import { SectionLabel } from '../ui/SectionLabel'
import { EngineIcon } from '../AgentHarnessIdentity'
import { engineLabel } from '../../lib/usage/engineLabel'
import {
  RANGE_PRESETS,
  activeDays,
  busiestDay,
  changeRatio,
  engineRows,
  heatSeries,
  hourHistogram,
  parseDay,
  peakHour,
  rangeFor,
  streaks,
  tokenComparison,
  totalsFor,
  type HeatMetric,
  type RangePreset,
  type DayRange,
  type UsageTotals,
} from '../../lib/usage/derive'
import { useUsageData, type Loadable } from './useUsageData'
import { HeatLegend, UsageHeatmap } from './UsageHeatmap'
import { compact, duration, heightPx, plain } from './format'
import { tokenAmounts } from '../../lib/usage/charts'
import { Layers, Zap } from '@/lib/icons'
import { ModelBadge, SegSwitch, StatStrip } from './UsageParts'
import { ModelAnalysisCard, RhythmCard } from './UsageChartCards'
import '../settings/settings.css'
import './usage.css'

/**
 * 设置 →「活跃」(product spec)。从上往下:总览 → 活跃热力图 → 按引擎 → 节奏。
 * 积分与使用日志在另一页「用量」(UsageSection.tsx)。
 * 数据是云端的跨设备汇总;本机在打开这一页时先把最新数据送上去(见 lib/usage/sync.ts)。
 */
export function ActivitySection() {
  const { t } = useTranslation('settings')
  const { user } = useAuth()
  const knownDevices = useDisplayDevices(useDevicesStore().devices)
  const [preset, setPreset] = useState<RangePreset>('30d')
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [metric, setMetric] = useState<HeatMetric>('sessions')
  const data = useUsageData({ userId: user?.id ?? null, deviceId, wantPreviousYear: preset === '1y' })

  const { current, previous } = useMemo(() => rangeFor(preset, data.today), [preset, data.today])
  const usage = data.usage.status === 'ready' ? data.usage.value : null

  const deviceOptions = useMemo(() => data.devices.map((d) => {
    const known = knownDevices.find((k) => k.device_id === d.deviceId)
    return { id: d.deviceId, label: known ? `${known.label}${known.is_current_device ? t('usage.thisDevice') : ''}` : t('usage.unknownDevice') }
  }), [data.devices, knownDevices, t])

  return (
    <div className="gg-usage" data-testid="activity-section">
      <div className="gg-usage-toolbar">
        {deviceOptions.length > 1 || deviceId ? (
          <select
            // @@@6436 与设置里其它下拉(语言)同一种:手机上 44px 触控高度,桌面 32。
            className="gg-settings-select"
            aria-label={t('usage.deviceFilter')}
            value={deviceId ?? ''}
            onChange={(e) => setDeviceId(e.target.value || null)}
            data-testid="usage-device-filter"
          >
            <option value="">{t('usage.allDevices')}</option>
            {deviceOptions.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
        ) : <span className="gg-usage-caption">{t('usage.allDevices')}</span>}
        {data.syncing && <span className="gg-usage-caption mr-auto" data-testid="usage-syncing">{t('usage.syncing')}</span>}
        <SegmentedTabs
          ariaLabel={t('usage.range')}
          value={preset}
          onChange={setPreset}
          items={RANGE_PRESETS.map((p) => ({ value: p, label: t(`usage.ranges.${p}`), testId: `usage-range-${p}` }))}
        />
      </div>
      {data.syncError && <span className="gg-usage-caption" data-testid="usage-sync-error" title={data.syncError}>{t('usage.syncError')}</span>}

      <Summary data={data} usage={usage} current={current} previous={previous} preset={preset} />

      <section className="gg-usage-section" aria-labelledby="usage-activity">
        <SectionLabel id="usage-activity">{t('usage.activity')}</SectionLabel>
        <Activity usageState={data.usage} today={data.today} metric={metric} onMetric={setMetric} range={current} />
      </section>

      <section className="gg-usage-section" aria-labelledby="usage-engines">
        <SectionLabel id="usage-engines">{t('usage.engines')}</SectionLabel>
        <Guarded state={data.usage} height={120}>
          {usage && <Engines usage={usage} range={current} />}
        </Guarded>
      </section>

      <section className="gg-usage-section" aria-labelledby="usage-rhythm">
        <SectionLabel id="usage-rhythm">{t('usage.rhythm')}</SectionLabel>
        <Guarded state={data.usage} height={120}>
          {usage && <Rhythm usage={usage} range={current} />}
        </Guarded>
      </section>
    </div>
  )
}

/** 一段数据的三种状态统一在这里落地:加载是占位块,失败是一句明说,❌ 失败时不画一张全灰的图冒充「没用过」。 */
function Guarded<T>({ state, height, children }: { state: Loadable<T>; height: number; children: ReactNode }) {
  const { t } = useTranslation('settings')
  if (state.status === 'loading') return <div className="gg-usage-skeleton" style={heightPx(height)} data-testid="usage-loading" />
  // 失败原因只进 title(悬停可见、方便截图报障),❌ 不拼进句子:对用户不可操作(user-copy-leak-check)。
  if (state.status === 'error') return <span className="gg-usage-muted" data-testid="usage-error" title={state.error}>{t('usage.loadError')}</span>
  return <>{children}</>
}

function Summary({ data, usage, current, previous, preset }: {
  data: ReturnType<typeof useUsageData>
  usage: UsageDay[] | null
  current: { from: string; to: string }
  previous: { from: string; to: string }
  preset: RangePreset
}) {
  const { t } = useTranslation('settings')
  const now = usage ? totalsFor(usage, current) : null
  // 对照段:一年档的上一年要单独取(取失败就说取不到,❌ 装成「没有可比数据」);其余档都落在已取回的近一年里。
  let prev: UsageTotals | null = null
  let prevFailed = false
  if (preset === '1y') {
    if (data.previousYear?.status === 'ready') prev = totalsFor(data.previousYear.value.usage, previous)
    prevFailed = data.previousYear?.status === 'error'
  } else if (usage) {
    prev = totalsFor(usage, previous)
  }

  const tile = (key: string, label: string, value: string | null, sub: ReactNode, failed: boolean, detail?: string) => (
    <div className="gg-usage-tile" data-testid={`usage-tile-${key}`} title={detail}>
      <div className="gg-usage-caption">{label}</div>
      <div className="gg-usage-tile-value">{failed ? '—' : value ?? <span className="gg-usage-skeleton">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>}</div>
      <div className="gg-usage-caption">{failed ? t('usage.unavailable') : sub}</div>
    </div>
  )
  const change = (current: number, previousValue: number | null) =>
    <Change now={current} prev={previousValue} failed={prevFailed} />
  const failed = data.usage.status === 'error'
  // Token 分两格:走咕咕模型(扣积分)的与走自己账号(BYOK)的。说不清来源的那部分(来源记录出现之前的会话)
  // 不塞进任何一格,只在悬停里说出来,❌ 猜一边。
  const unknown = now ? Math.max(0, now.tokens - now.guguTokens - now.byokTokens) : 0
  const detail = now && unknown > 0 ? t('usage.tiles.tokensUnknown', { value: compact(unknown) }) : undefined
  return (
    <div className="gg-usage-tiles">
      {tile('sessions', t('usage.tiles.sessions'), now ? plain(now.sessions) : null, change(now?.sessions ?? 0, prev?.sessions ?? null), failed)}
      {tile('gugu-tokens', t('usage.tiles.guguTokens'), now ? compact(now.guguTokens) : null, change(now?.guguTokens ?? 0, prev?.guguTokens ?? null), failed, detail)}
      {tile('byok-tokens', t('usage.tiles.byokTokens'), now ? compact(now.byokTokens) : null, change(now?.byokTokens ?? 0, prev?.byokTokens ?? null), failed, detail)}
      {tile('runtime', t('usage.tiles.runtime'), now ? duration(now.runSeconds, t) : null, change(now?.runSeconds ?? 0, prev?.runSeconds ?? null), failed)}
    </div>
  )
}

function Change({ now, prev, failed }: { now: number; prev: number | null; failed: boolean }) {
  const { t } = useTranslation('settings')
  if (failed) return <>{t('usage.compareUnavailable')}</>
  const ratio = changeRatio(now, prev)
  if (ratio === null) return <>{t('usage.noCompare')}</>
  const up = ratio >= 0
  return (
    <span className={up ? 'gg-usage-up' : 'gg-usage-down'}>
      {t(up ? 'usage.changeUp' : 'usage.changeDown', { percent: plain(Math.abs(ratio) * 100) })}
    </span>
  )
}

/**
 * 热力图:汇总还没回来是占位、挂了是一句明说,❌ 先画一张全灰的图(那等于告诉他「这一年没用过」)。
 */
function Activity({ usageState, today, metric, onMetric, range }: {
  usageState: Loadable<UsageDay[]>
  today: string
  metric: HeatMetric
  onMetric: (m: HeatMetric) => void
  range: { from: string; to: string }
}) {
  const { t } = useTranslation('settings')
  const { resolvedLocale } = useLocale()
  const usage = usageState.status === 'ready' ? usageState.value : EMPTY_USAGE
  const series = useMemo(() => heatSeries(metric, usage), [metric, usage])
  const active = useMemo(() => activeDays(usage), [usage])
  const settled = usageState.status !== 'loading'
  const { current, longest } = streaks(active, today)
  const busiest = busiestDay(usage, range)
  const totals = totalsFor(usage, range)
  const comparison = tokenComparison(totals.tokens, resolvedLocale.startsWith('zh') ? 'zh' : 'en', today)
  const formatValue = (count: number) => metric === 'sessions'
    ? t('usage.units.sessions', { count, value: plain(count) })
    : t('usage.units.tokens', { value: compact(count) })
  return (
    <>
      <div className="gg-usage-card">
        <div className="gg-usage-heat-head">
          <span className="gg-usage-muted" data-testid="usage-streaks">
            {!settled ? '' : active.size === 0 ? t('usage.emptyHeat') : t('usage.streaks', { current, longest, active: active.size })}
          </span>
          <SegmentedTabs
            ariaLabel={t('usage.metric')}
            value={metric}
            onChange={onMetric}
            items={(['sessions', 'tokens'] as const).map((m) => ({ value: m, label: t(`usage.metrics.${m}`), testId: `usage-metric-${m}` }))}
          />
        </div>
        <Guarded state={usageState} height={120}>
          <UsageHeatmap data={series} today={today} formatValue={formatValue} />
        </Guarded>
        <div className="gg-usage-heat-foot">
          <span className="gg-usage-caption">
            {busiest ? t('usage.busiest', { date: formatDate(parseDay(busiest.day), { month: 'long', day: 'numeric', weekday: 'short' }), count: busiest.sessions }) : ''}
          </span>
          <HeatLegend />
        </div>
      </div>
      {comparison && (
        <div className="gg-usage-quip" data-testid="usage-quip">
          {t('usage.quip', { tokens: compact(totals.tokens), book: t(`usage.books.${comparison.key}`), times: plain(comparison.times) })}
        </div>
      )}
    </>
  )
}

const EMPTY_USAGE: UsageDay[] = []

function Engines({ usage, range }: { usage: UsageDay[]; range: DayRange }) {
  const { t } = useTranslation('settings')
  const rows = engineRows(usage, range)
  const totals = totalsFor(usage, range)
  if (rows.length === 0) return <span className="gg-usage-muted" data-testid="usage-engines-empty">{t('usage.enginesEmpty')}</span>
  return (
    <>
      <div className="na-table-wrap">
        <table className="na-table na-table--engines" data-testid="usage-engines">
          <thead>
            <tr>
              <th>{t('usage.na.colEngine')}</th><th>{t('usage.na.colSessions')}</th>
              <th>{t('usage.na.colGuguTokens')}</th><th>{t('usage.na.colByokTokens')}</th><th>{t('usage.na.colRuntime')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.engine} data-testid={`usage-engine-${row.engine}`}>
                <td data-label={t('usage.na.colEngine')}><ModelBadge model={engineLabel(row.engine)} icon={<EngineIcon engine={row.engine} size={16} />} /></td>
                <td data-label={t('usage.na.colSessions')}>
                  <div className="na-cell-stack">
                    <span>{plain(row.sessions)}</span>
                    <span className="na-tokens-sub">{plain(row.share * 100)}%</span>
                  </div>
                </td>
                <td data-label={t('usage.na.colGuguTokens')}><span className="na-mono-xs">{row.guguTokens > 0 ? compact(row.guguTokens) : '—'}</span></td>
                <td data-label={t('usage.na.colByokTokens')}><span className="na-mono-xs">{row.byokTokens > 0 ? compact(row.byokTokens) : '—'}</span></td>
                <td data-label={t('usage.na.colRuntime')}>{row.runSeconds > 0 ? <span className="na-cost">{duration(row.runSeconds, t)}</span> : <span className="gg-usage-muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <StatStrip testId="usage-parallel" items={[
        { key: 'peak', title: t('usage.na.parallelPeak'), value: t('usage.peakValue', { count: totals.peakConcurrency, value: plain(totals.peakConcurrency) }), icon: <Layers />, tone: 'chart-2', description: t('usage.peakHint') },
        { key: 'time', title: t('usage.na.parallelTime'), value: duration(totals.parallelSeconds, t), icon: <Zap />, tone: 'warning', description: t('usage.parallelHint') },
      ]} />
      <ModelTokensCard usage={usage} range={range} />
    </>
  )
}

/** 模型用量分析:可以只看咕咕模型或只看自己账号(BYOK)的 token。 */
function ModelTokensCard({ usage, range }: { usage: UsageDay[]; range: DayRange }) {
  const { t } = useTranslation('settings')
  const [source, setSource] = useState<'all' | 'gugu' | 'byok'>('all')
  const amounts = useMemo(() => tokenAmounts(usage, source === 'all' ? null : source), [usage, source])
  return (
    <ModelAnalysisCard amounts={amounts} range={range} kind="tokens" format={compact} testId="usage-model-tokens"
      filter={<SegSwitch label={t('usage.na.source')} value={source} onChange={setSource} items={[
        { value: 'all', label: t('usage.na.sourceAll'), testId: 'usage-source-all' },
        { value: 'gugu', label: t('usage.na.sourceGugu'), testId: 'usage-source-gugu' },
        { value: 'byok', label: t('usage.na.sourceByok'), testId: 'usage-source-byok' },
      ]} />} />
  )
}

function Rhythm({ usage, range }: { usage: UsageDay[]; range: DayRange }) {
  const { t } = useTranslation('settings')
  const hours = hourHistogram(usage, range)
  const peak = peakHour(hours)
  return <RhythmCard hours={hours} hint={peak === null ? t('usage.rhythmEmpty') : t('usage.peakHour', { hour: peak })} format={(n) => plain(n)} />
}
