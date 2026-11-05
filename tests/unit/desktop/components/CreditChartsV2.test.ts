// @vitest-environment jsdom
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { creditDecimal as d, type CreditAmount } from '@gugu/core/billing/creditAmount'
import { creditAmounts, rankModels, stackedPoints } from '../../../../apps/desktop/src/lib/usage/charts'
import { creditChartScale } from '../../../../apps/desktop/src/lib/usage/creditChartScale'
import { formatCreditDecimal } from '../../../../apps/desktop/src/lib/billing/v2/decimal'
import { quotaWindowLabel } from '../../../../apps/desktop/src/lib/billing/quota'
import { CreditStackedChart, StackedChart } from '../../../../apps/desktop/src/components/usage/UsageCharts'
const chart = vi.hoisted(() => ({ spec: null as unknown }))
// Only the canvas renderer is replaced: these assertions exercise the real chart's
// mapping, exact amounts and tooltip configuration. VChart belongs to the desktop
// workspace, so the mock must resolve there too; a root-only mock misses it in a
// clean pnpm layout and loads the dependency's Node-incompatible ESM entry.
vi.mock('../../../../apps/desktop/node_modules/@visactor/react-vchart', () => ({ VChart: (props: { spec: unknown }) => { chart.spec = props.spec; return null } }))
const range = { from: '2026-11-01', to: '2026-11-02', days: 2 }
const format = (value: CreditAmount) => typeof value === 'string' ? formatCreditDecimal(value, 'en-US') : String(value)
const data = [
  { day: range.from, model: 'first', value: d('9007199254740993.00000001') },
  { day: range.from, model: 'second', value: d('9007199254740993.00000002') },
  { day: range.to, model: null, value: d('0.00000001') },
]

describe('exact credit chart aggregation', () => {
  it('sorts beyond Number precision, preserves missing-day buckets and sums other exactly', () => {
    expect(rankModels(data, range, 1, 'Other')).toEqual([
      { model: 'second', value: '9007199254740993.00000002' }, { model: 'Other', value: '9007199254740993.00000002' },
    ])
    const stacked = stackedPoints(data, range, 1, 'Other')
    expect(stacked.total).toBe('18014398509481986.00000004')
    expect(stacked.points).toEqual([
      { time: '11-01', model: 'second', value: '9007199254740993.00000002' },
      { time: '11-01', model: 'Other', value: '9007199254740993.00000001' },
      { time: '11-02', model: 'second', value: 0 }, { time: '11-02', model: 'Other', value: '0.00000001' },
    ])
  })
  it('can sum more than a single NUMERIC(30,8) row without rounding', () => {
    const row = { day: range.from, model: 'a', value: d('9999999999999999999999.99999999') }
    expect(stackedPoints([row, row], range, 5, 'Other').total).toBe('19999999999999999999999.99999998')
  })
  it('keeps non-billing counts numeric and passes monetary text untouched', () => {
    const [amount] = creditAmounts([{ day: range.from, model: 'a', credits: d('0.00000001'), inputTokens: 1, outputTokens: 2, requests: 3 }], 'credits')
    expect(amount.value).toBe('0.00000001')
    expect(stackedPoints([{ ...amount, value: 3 }], range, 5, 'Other').total).toBe(3)
  })
  it('does not turn empty, zero, negative or out-of-range points into positive expenditure', () => {
    const rows = [{ day: range.from, model: 'a', value: d('0') }, { day: range.to, model: 'b', value: d('-1') }, { day: '2020-01-01', model: 'c', value: d('99') }]
    expect(stackedPoints(rows, range, 5, 'Other')).toMatchObject({ total: 0, domain: [] })
  })
  it('normalizes only geometry and keeps positive sub-unit axis ticks explicit', () => {
    const scale = creditChartScale([d('0.00000001')])
    expect(scale.coordinate(d('0.00000001'))).toBe(1)
    expect(scale.formatCoordinate(0.1, format)).toBe('<0.01')
    expect(scale.formatCoordinate(0, format)).toBe('0')
    expect(() => scale.coordinate(NaN)).toThrow()
  })
})

type Datum = { time: string; model: string; value: number; amount: CreditAmount }
type TooltipItem = { key: string; value: string | number; datum?: Datum }
type Spec = {
  data: { values: Datum[] }[];
  axes: { label?: { formatMethod: (value: number | string) => string } }[];
  tooltip: { mark: { content: { value: (value: Datum) => string }[] }; dimension: { updateContent: (items: TooltipItem[]) => TooltipItem[] } };
}
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })
it('uses original monetary text for actual chart tooltip, totals and axis labels', async () => {
  const points = data.map(row => ({ time: row.day, model: row.model ?? 'Other', value: row.value }))
  await harness.render(createElement(CreditStackedChart, { mode: 'bar', points, domain: ['first', 'second', 'Other'], format, totalLabel: 'Total', otherLabel: 'Other' }))
  const spec = chart.spec as Spec
  const values = spec.data[0].values
  expect(values.every(row => Number.isFinite(row.value))).toBe(true)
  expect(values[0].amount).toBe('9007199254740993.00000001')
  expect(spec.tooltip.mark.content[0].value(values[2])).toBe('<0.01')
  const tooltip = spec.tooltip.dimension.updateContent(values.map(row => ({ key: row.model, value: row.value, datum: row })))
  expect(tooltip[0]).toMatchObject({ key: 'Total', value: '18,014,398,509,481,986' })
  expect(tooltip[1].key).toBe('second')
  expect(tooltip[3]).toMatchObject({ key: 'Other', value: '<0.01' })
  expect(spec.axes[0].label!.formatMethod(1)).toBe('9,007,199,254,740,993')
})
it('does not read axis coordinates as a monetary tooltip value when a non-data item appears', async () => {
  await harness.render(createElement(CreditStackedChart, { mode: 'area', points: [{ time: '11-01', model: 'a', value: d('0.01') }], domain: ['a'], format, totalLabel: 'Total', otherLabel: 'Other' }))
  expect((chart.spec as Spec).tooltip.dimension.updateContent([{ key: 'axis', value: 0.5 }])).toEqual([])
})
it('preserves numeric token and request chart semantics', async () => {
  await harness.render(createElement(StackedChart, { mode: 'bar', points: [{ time: '11-01', model: 'a', value: 42 }], domain: ['a'], format: String, totalLabel: 'Total', otherLabel: 'Other' }))
  const spec = chart.spec as Spec
  expect(spec.data[0].values[0]).toMatchObject({ value: 42, amount: 42 })
  expect(spec.tooltip.mark.content[0].value(spec.data[0].values[0])).toBe('42')
})

it('names a quota window in days from two whole days up, in hours below', () => {
  expect(quotaWindowLabel(720, 'en-US')).toBe('30 days')
  expect(quotaWindowLabel(24, 'en-US')).toBe('24 hours')
})
