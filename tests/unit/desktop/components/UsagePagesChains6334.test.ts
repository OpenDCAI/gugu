// @vitest-environment jsdom
// #986 合并用量与活跃,保留 #6334 的来源区分与独立失败状态。
// 各页取数失败各自说「取不到」,❌ 画成 0;「活跃」页把 token 分成咕咕模型与自己账号(BYOK)两格。
import { act, createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreditUsageDay, UsageDay } from '../../../../packages/core/src/shared/usage/dailyUsage'
import { createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import type { Loadable, UsageData } from '../../../../apps/desktop/src/components/usage/useUsageData'
import { localDay } from '../../../../apps/desktop/src/lib/usage/derive'

const state = vi.hoisted(() => ({
  activity: null as unknown as UsageData,
  credits: { status: 'loading' } as Loadable<CreditUsageDay[]>,
  accountUsage: [] as UsageDay[],
  selectedUsage: [] as UsageDay[],
}))
vi.mock('../../../../apps/desktop/src/components/usage/useUsageData', () => ({
  useUsageData: ({ deviceId }: { deviceId: string | null }) => deviceId
    ? { ...state.activity, usage: { status: 'ready', value: state.selectedUsage } }
    : state.activity,
  useCreditData: () => ({ today: localDay(new Date()), credits: state.credits, usage: { status: 'ready', value: state.accountUsage } }),
}))
// 余额/会员/明细各自取数,与这里要钉的汇总链路无关 —— 积分段内部的取数换成空壳。
vi.mock('../../../../apps/desktop/src/components/usage/UsageCredits', () => ({
  UsageCredits: ({ credits, range, guguTokens }: { credits: Loadable<CreditUsageDay[]>; range: { days: number }; guguTokens: Loadable<number> }) =>
    createElement('div', { 'data-testid': 'credit-probe' }, `${credits.status === 'error' ? 'credits-error' : credits.status === 'ready' ? 'credits-ready' : 'credits-loading'}|${range.days}|${guguTokens.status === 'ready' ? guguTokens.value : '?'}`),
}))

import { ActivitySection } from '../../../../apps/desktop/src/components/usage/ActivitySection'
import { UsageSection } from '../../../../apps/desktop/src/components/usage/UsageSection'

const today = localDay(new Date())
const usageDay = (over: Partial<UsageDay>): UsageDay => ({
  day: today, engine: 'claude', sessions: 0, runSeconds: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
  cacheWriteTokens: 0, models: {}, guguModels: {}, byokModels: {}, hours: Array.from({ length: 24 }, () => 0),
  parallelSeconds: 0, peakConcurrency: 0, ...over,
})
const activity = (over: Partial<UsageData>): UsageData => ({
  today, usage: { status: 'loading' }, previousYear: null, devices: [], syncing: false, syncError: null, ...over,
})

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
async function render(component: () => unknown) {
  const harness = createReactHarness()
  await renderWithAppProviders(harness, createNode(component as never, {}), { auth: { id: 'u1', email: 'u@e.com', nickname: 'U' } })
  await flush()
  return harness
}
const renderActivity = () => createNode(ActivitySection, { preset: '30d' })
const tile = (key: string) => document.querySelector(`[data-testid="usage-tile-${key}"]`)?.textContent ?? ''

describe('#6334「活跃」页', () => {
  beforeEach(() => { state.activity = activity({}) })

  it('token 分两格:咕咕模型与自己账号,各按来源求和', async () => {
    state.activity = activity({ usage: { status: 'ready', value: [usageDay({
      sessions: 2, inputTokens: 1500, models: { a: 1500 }, guguModels: { a: 1000 }, byokModels: { a: 500 },
    })] } })
    const harness = await render(renderActivity)
    try {
      expect(tile('gugu-tokens')).toContain('1000')
      expect(tile('byok-tokens')).toContain('500')
      expect(tile('sessions')).toContain('2')
    } finally { harness.cleanup() }
  })

  it('汇总挂了 → 格子写「暂时取不到」,热力图不画成全灰', async () => {
    state.activity = activity({ usage: { status: 'error', error: 'rpc down' } })
    const harness = await render(renderActivity)
    try {
      expect(tile('sessions')).toContain('暂时取不到')
      expect(tile('gugu-tokens')).toContain('暂时取不到')
      expect(document.querySelector('[data-testid="usage-heatmap-grid"]')).toBeNull()
    } finally { harness.cleanup() }
  })

  it('还在路上 → 占位,❌ 先画一张全灰的热力图', async () => {
    const harness = await render(renderActivity)
    try {
      expect(document.querySelector('[data-testid="usage-heatmap-grid"]')).toBeNull()
      expect(document.querySelector('[data-testid="usage-loading"]')).not.toBeNull()
    } finally { harness.cleanup() }
  })

  it('不含积分:积分那一段在「用量」页', async () => {
    state.activity = activity({ usage: { status: 'ready', value: [] } })
    const harness = await render(renderActivity)
    try {
      expect(document.body.textContent).not.toContain('credits-')
      expect(document.querySelector('[data-testid="usage-tile-credits"]')).toBeNull()
    } finally { harness.cleanup() }
  })
})

describe('#6334「用量」页', () => {
  beforeEach(() => {
    state.activity = activity({ usage: { status: 'ready', value: [] } })
    state.accountUsage = []
    state.selectedUsage = []
  })
  it('积分那条链路原样交给积分段(挂了由它自己说取不到)', async () => {
    state.credits = { status: 'error', error: 'billing down' }
    const harness = await render(UsageSection)
    try {
      expect(document.body.textContent).toContain('credits-error')
      expect(document.querySelector('[data-testid="usage-tile-sessions"]')).not.toBeNull()
    } finally { harness.cleanup() }
  })

  it('#986 共用一套时间段，同时改变积分与活跃统计', async () => {
    const old = new Date(); old.setDate(old.getDate() - 10)
    state.accountUsage = [usageDay({ sessions: 2, guguModels: { a: 1000 } }), usageDay({ day: localDay(old), sessions: 3, guguModels: { a: 500 } })]
    state.activity = activity({ usage: { status: 'ready', value: state.accountUsage } })
    const harness = await render(UsageSection)
    try {
      expect(document.querySelectorAll('[data-testid^="usage-range-"]')).toHaveLength(4)
      expect(tile('sessions')).toContain('5')
      expect(document.querySelector('[data-testid="credit-probe"]')?.textContent).toContain('|30|1500')
      await act(async () => (document.querySelector('[data-testid="usage-range-7d"]') as HTMLButtonElement).click())
      expect(tile('sessions')).toContain('2')
      expect(document.querySelector('[data-testid="credit-probe"]')?.textContent).toContain('|7|1000')
    } finally { harness.cleanup() }
  })

  it('#986 活跃设备筛选不改变账户积分统计', async () => {
    state.accountUsage = [usageDay({ sessions: 5, guguModels: { a: 1000 } })]
    state.selectedUsage = [usageDay({ sessions: 1, guguModels: { a: 100 } })]
    state.activity = activity({ usage: { status: 'ready', value: state.accountUsage }, devices: [{ deviceId: 'a' }, { deviceId: 'b' }] as UsageData['devices'] })
    const harness = await render(UsageSection)
    try {
      const filter = document.querySelector('[data-testid="usage-device-filter"]') as HTMLSelectElement
      expect(filter).not.toBeNull()
      await act(async () => { filter.value = 'a'; filter.dispatchEvent(new Event('change', { bubbles: true })) })
      expect(tile('sessions')).toContain('1')
      expect(tile('gugu-tokens')).toContain('100')
      expect(document.querySelector('[data-testid="credit-probe"]')?.textContent).toContain('|30|1000')
    } finally { harness.cleanup() }
  })
})
