import * as HeatGraph from 'heat-graph'
import { useTranslation } from 'react-i18next'
import { formatDate } from '@/i18n'
import type { HeatPoint } from '../../lib/usage/derive'
import { HEATMAP_DAYS, addDays, parseDay } from '../../lib/usage/derive'
import { HEAT_SCALE, leftPct, swatch } from './format'
import { useMobileShell } from '../../hooks/useMobileShell'

// 月份与星期用 Intl 取:中文「9月」「周二」,英文「Sep」「Tue」—— ❌ 不用 heat-graph 自带的英文常量表。
const monthLabel = (month: number) => formatDate(new Date(2024, month, 1), { month: 'short' })
const weekdayLabel = (dayOfWeek: number) => formatDate(new Date(2024, 0, 7 + dayOfWeek), { weekday: 'short' })

/**
 * 近一年的活跃热力图(GitHub 那种)。骨架是 heat-graph(assistant-ui 出的无样式组件:
 * 只管排格子、算日期、做悬停定位),颜色、字号、深浅色全走这一页自己的 token。
 * 固定铺 53 周 —— 时间段切换只改上面的数字,❌ 不改这张图的跨度(3 个月铺满整宽时格子大得像瓷砖)。
 */
export function UsageHeatmap({ data, today, formatValue }: {
  data: HeatPoint[]
  today: string
  /** 悬停时这一格的量怎么读:「12 个会话」「3.4 万 token」。0 时由这里统一说「没有使用」。 */
  formatValue: (count: number) => string
}) {
  const { t } = useTranslation('settings')
  // 月份标签是按周列绝对定位的,相邻两个只隔 ~4.3 周。「10月」「Sep」约 28px:手机上 53 周铺 290–340px(一周 5.5–6.4px),
  // 挨着的月份必然压字 ⇒ 隔一个月标一次;桌面一周 ~11px,只需躲开开头那段不满 3 周的残月。从左往右,离上一个太近的不画。
  const minGapWeeks = useMobileShell() ? 6 : 3
  let lastShownColumn = -Infinity
  const start = parseDay(addDays(today, -(HEATMAP_DAYS - 1)))
  // 开头那个月只露出不满 3 周就不标:否则留下的是那段残月,把紧跟着的整月挤掉。
  const leadDays = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate() - start.getDate() + 1
  return (
    <HeatGraph.Root
      data={data}
      start={start}
      end={parseDay(today)}
      weekStart="monday"
      colorScale={HEAT_SCALE}
      className="gg-usage-heat"
    >
      <div className="gg-usage-months" aria-hidden="true">
        <HeatGraph.MonthLabels>
          {({ label, totalWeeks }) => {
            // MonthLabels 会自己重渲染(不经过这里):新一轮又从最左边开始,不能拿上一轮的位置比。
            if (label.column <= lastShownColumn) lastShownColumn = -Infinity
            if (label.column === 0 && leadDays < 21) return null
            if (label.column - lastShownColumn < minGapWeeks) return null
            lastShownColumn = label.column
            return <span style={leftPct(label.column / totalWeeks)}>{monthLabel(label.month)}</span>
          }}
        </HeatGraph.MonthLabels>
      </div>
      <div className="gg-usage-heat-row">
        <div className="gg-usage-days" aria-hidden="true">
          <HeatGraph.DayLabels>
            {({ label }) => <span>{label.row % 2 === 1 ? weekdayLabel(label.dayOfWeek) : ''}</span>}
          </HeatGraph.DayLabels>
        </div>
        <HeatGraph.Grid className="gg-usage-grid" data-testid="usage-heatmap-grid">
          {() => <HeatGraph.Cell className="gg-usage-cell" />}
        </HeatGraph.Grid>
      </div>
      <HeatGraph.Tooltip sideOffset={6}>
        {({ cell }) => (
          <div className="gg-usage-tip">
            {t('usage.heat.tip', {
              date: formatDate(cell.date, { month: 'long', day: 'numeric', weekday: 'short' }),
              value: cell.count > 0 ? formatValue(cell.count) : t('usage.heat.none'),
            })}
          </div>
        )}
      </HeatGraph.Tooltip>
    </HeatGraph.Root>
  )
}

export function HeatLegend() {
  const { t } = useTranslation('settings')
  return (
    <span className="gg-usage-legend" aria-hidden="true">
      {t('usage.heat.less')}
      {HEAT_SCALE.map((color) => <i key={color} className="gg-usage-legend-swatch" style={swatch(color)} />)}
      {t('usage.heat.more')}
    </span>
  )
}
