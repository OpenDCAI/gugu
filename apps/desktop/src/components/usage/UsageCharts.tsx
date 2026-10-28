import { tokenColor, useChartTheme } from './useChartTheme'
import { VChart } from '@visactor/react-vchart'
import type { ChartPoint, ModelTotal } from '../../lib/usage/charts'

// 用量页的 VChart 图。这个模块整体懒加载 ——
// VChart 有几百 KB,只有打开用量页才需要。

// VChart 自带的默认色板:≤10 个系列用 10 色,更多用 20 色。
const PALETTE_10 = ['#1664FF', '#1AC6FF', '#FF8A00', '#3CC780', '#7442D4', '#FFC400', '#304D77', '#B48DEB', '#009488', '#FF7DDA']
const PALETTE_20 = ['#1664FF', '#B2CFFF', '#1AC6FF', '#94EFFF', '#FF8A00', '#FFCE7A', '#3CC780', '#B9EDCD', '#7442D4', '#DDC5FA',
  '#FFC400', '#FAE878', '#304D77', '#8B959E', '#B48DEB', '#EFE3FF', '#009488', '#59BAA8', '#FF7DDA', '#FFCFEE']
const colorScale = (domain: string[]) => ({ type: 'ordinal', domain, range: domain.length > 10 ? PALETTE_20 : PALETTE_10 })

const OPTIONS = { mode: 'desktop-browser' as const }
const BASE = { background: 'transparent', padding: { top: 12, right: 12, bottom: 4, left: 4 } }

type TooltipItem = { key: string; value: string | number; datum?: { value?: number } }

/** 维度浮窗:按量降序,首行「总计」,只列前 15 个,剩下的并成「其他」。 */
function dimensionContent(format: (n: number) => string, totalLabel: string, otherLabel: string) {
  return (items: TooltipItem[]) => {
    const rows = items
      .map((item) => ({ item, value: Number(item.datum?.value ?? 0) }))
      .filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value)
    const total = rows.reduce((sum, r) => sum + r.value, 0)
    const head = rows.slice(0, 15).map((r) => ({ ...r.item, value: format(r.value) }))
    const rest = rows.slice(15).reduce((sum, r) => sum + r.value, 0)
    const first = items[0]
    return [
      ...(first ? [{ ...first, key: totalLabel, value: format(total), hasShape: false }] : []),
      ...head,
      ...(rest > 0 && first ? [{ ...first, key: otherLabel, value: format(rest), hasShape: false }] : []),
    ]
  }
}

export function StackedChart({ mode, points, domain, format, totalLabel, otherLabel }: {
  mode: 'bar' | 'area'; points: ChartPoint[]; domain: string[]; format: (n: number) => string; totalLabel: string; otherLabel: string
}) {
  const theme = useChartTheme()
  const common = {
    ...BASE,
    data: [{ id: 'series', values: points }],
    xField: 'time',
    yField: 'value',
    seriesField: 'model',
    stack: true,
    color: colorScale(domain),
    legends: { visible: true, selectMode: 'single' as const, orient: 'bottom' as const },
    axes: [{ orient: 'left', label: { formatMethod: (v: number | string) => format(Number(v)) } }, { orient: 'bottom', type: 'band' }],
    tooltip: {
      mark: { content: [{ key: (d: ChartPoint) => d.model, value: (d: ChartPoint) => format(d.value) }] },
      dimension: { updateContent: dimensionContent(format, totalLabel, otherLabel) },
    },
  }
  const spec = mode === 'bar'
    ? { ...common, type: 'bar', bar: { state: { hover: { stroke: tokenColor('--fg'), lineWidth: 1 } } } }
    : { ...common, type: 'area', area: { style: { fillOpacity: 0.08, curveType: 'monotone' } }, line: { style: { lineWidth: 2, curveType: 'monotone' } }, point: { visible: false } }
  return <VChart spec={{ ...spec, theme } as never} options={OPTIONS} />
}

export function ShareChart({ totals, format }: { totals: ModelTotal[]; format: (n: number) => string }) {
  const theme = useChartTheme()
  const domain = totals.map((m) => m.model)
  const spec = {
    ...BASE,
    type: 'pie',
    data: [{ id: 'share', values: totals }],
    categoryField: 'model',
    valueField: 'value',
    innerRadius: 0.5,
    outerRadius: 0.8,
    padAngle: 0.6,
    color: colorScale(domain),
    pie: { style: { cornerRadius: 6 }, state: { hover: { outerRadius: 0.85, stroke: tokenColor('--fg'), lineWidth: 1 }, selected: { outerRadius: 0.85, stroke: tokenColor('--fg'), lineWidth: 1 } } },
    legends: { visible: true, orient: 'left' as const },
    label: { visible: true },
    tooltip: { mark: { content: [{ key: (d: ModelTotal) => d.model, value: (d: ModelTotal) => format(d.value) }] } },
    theme,
  }
  return <VChart spec={spec as never} options={OPTIONS} />
}

export function RankChart({ totals, format }: { totals: ModelTotal[]; format: (n: number) => string }) {
  const theme = useChartTheme()
  const domain = totals.map((m) => m.model)
  const spec = {
    ...BASE,
    type: 'bar',
    data: [{ id: 'rank', values: totals }],
    xField: 'model',
    yField: 'value',
    seriesField: 'model',
    color: colorScale(domain),
    legends: { visible: false },
    axes: [{ orient: 'left', label: { formatMethod: (v: number | string) => format(Number(v)) } }, { orient: 'bottom', type: 'band', label: { autoRotate: true, autoHide: true } }],
    bar: { state: { hover: { stroke: tokenColor('--fg'), lineWidth: 1 } } },
    tooltip: { mark: { content: [{ key: (d: ModelTotal) => d.model, value: (d: ModelTotal) => format(d.value) }] } },
    theme,
  }
  return <VChart spec={spec as never} options={OPTIONS} />
}

export function HourChart({ hours, seriesLabel, format }: { hours: number[]; seriesLabel: string; format: (n: number) => string }) {
  const theme = useChartTheme()
  const values = hours.map((value, hour) => ({ hour: String(hour).padStart(2, '0'), value, series: seriesLabel }))
  const spec = {
    ...BASE,
    type: 'bar',
    data: [{ id: 'hours', values }],
    xField: 'hour',
    yField: 'value',
    seriesField: 'series',
    color: colorScale([seriesLabel]),
    legends: { visible: false },
    bar: { state: { hover: { stroke: tokenColor('--fg'), lineWidth: 1 } } },
    tooltip: { mark: { content: [{ key: () => seriesLabel, value: (d: { value: number }) => format(d.value) }] } },
    theme,
  }
  return <VChart spec={spec as never} options={OPTIONS} />
}
