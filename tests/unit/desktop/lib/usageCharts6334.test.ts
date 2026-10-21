// #6334 用量页图表的取数与分页页码(前 N 名 + 其他、空日子留柱位、页码首尾恒在)。
import { describe, expect, it } from 'vitest'
import { buckets, perMinute, rankModels, stackedPoints, type ModelAmount } from '../../../../apps/desktop/src/lib/usage/charts'
import { pageNumbers } from '../../../../apps/desktop/src/lib/usage/table'

const range = { from: '2026-09-01', to: '2026-09-07', days: 7 }
const a = (day: string, model: string | null, value: number): ModelAmount => ({ day, model, value })

describe('rankModels', () => {
  it('降序、超出上限与无模型名的并进「其他」垫底,范围外不计', () => {
    const out = rankModels([a('2026-09-01', 'x', 1), a('2026-09-02', 'y', 5), a('2026-09-03', 'z', 3), a('2026-09-03', null, 2), a('2026-08-01', 'y', 99)], range, 2, '其他')
    expect(out).toEqual([{ model: 'y', value: 5 }, { model: 'z', value: 3 }, { model: '其他', value: 3 }])
  })
})

describe('stackedPoints', () => {
  it('每个桶都有点(空日子记 0),总计等于范围内合计', () => {
    const { points, domain, total } = stackedPoints([a('2026-09-02', 'm', 4), a('2026-09-05', 'n', 1)], range, 10, '其他')
    expect(domain).toEqual(['m', 'n'])
    expect(points).toHaveLength(7 * 2)
    expect(new Set(points.map((p) => p.time)).size).toBe(7)
    expect(total).toBe(5)
  })
  it('完全没数据也留 7 个柱位', () => {
    expect(stackedPoints([], range, 10, '其他').points).toHaveLength(7)
  })
  it('一年档按周成桶', () => {
    expect(buckets({ from: '2025-09-24', to: '2026-09-23', days: 365 })).toHaveLength(53)
  })
})

describe('perMinute', () => {
  it('今天只算到此刻', () => {
    const now = new Date(2026, 8, 1, 0, 10)
    expect(perMinute(20, { from: '2026-09-01', to: '2026-09-01' }, now)).toBeCloseTo(2)
  })
})

describe('pageNumbers', () => {
  it('≤5 页全列', () => expect(pageNumbers(2, 5)).toEqual([1, 2, 3, 4, 5]))
  it('靠前', () => expect(pageNumbers(2, 20)).toEqual([1, 2, 3, 4, 'ellipsis', 20]))
  it('居中', () => expect(pageNumbers(10, 20)).toEqual([1, 'ellipsis', 9, 10, 11, 'ellipsis', 20]))
  it('靠后', () => expect(pageNumbers(19, 20)).toEqual([1, 'ellipsis', 17, 18, 19, 20]))
})
