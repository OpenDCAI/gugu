// @vitest-environment jsdom
// @@@2503 积分段不许说不成立的话(原积分小面板已并入用量页的「积分」段,product spec;断言原样搬过来)。两条都是审查时发现的真缺陷:
//  1. 用量流水取失败被折成空数组 → 一次网络故障渲染成「未找到日志」,
//     一个明明被扣过费的人会被告知自己从没花过钱。
//  2. 窗口小结只报短窗 → 周期耗尽而短窗空闲时,已经开不了会话的人看到
//     「5 小时内还剩 200 积分」。
// 断言里带了修复前会渲染出的那句原话的反向断言,回归时会立刻响。
import { act } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from '../../../../apps/desktop/src/session/renderer/lib/query-client'
import { GuguSubscriptionRow } from '../../../../apps/desktop/src/session/renderer/features/settings/subscriptions/GuguSubscriptionRow'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UsageCredits } from '../../../../apps/desktop/src/components/usage/UsageCredits'
import { createNode, createReactHarness, renderWithAppProviders, typeInto } from '../../../support/testHarness'

// Keep the shared store and components real; replace only the v2 network batch boundary.
vi.mock('../../../../apps/desktop/src/lib/billing/v2/runtime', () => ({ readCreditV2Account: vi.fn() }))
import { readCreditV2Account } from '../../../../apps/desktop/src/lib/billing/v2/runtime'
import { creditDecimal } from '@gugu/core/billing/creditAmount'
import type { QuotaWindows } from '@gugu/core/billing'
vi.mock('../../../../apps/desktop/src/lib/usage/cloud', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../apps/desktop/src/lib/usage/cloud')>()),
  fetchLedgerPage: vi.fn(),
}))
import { fetchLedgerPage, type LedgerRow } from '../../../../apps/desktop/src/lib/usage/cloud'

// Keep the real card, totals and format callback; the chart canvas is irrelevant to amount text.
// The package is installed only under apps/desktop: the bare name does not resolve from tests/, so a mock
// registered under it never matches the product import, and the lazily loaded real chart fails in Node.
vi.mock('../../../../apps/desktop/node_modules/@visactor/react-vchart', () => ({ VChart: () => null }))

const ledger = (rows: LedgerRow[]) => ({ rows, total: rows.length })
const RANGE = { from: '2026-08-25', to: '2026-09-23', days: 30 }
const props = { credits: { status: 'ready' as const, value: [] }, range: RANGE }
import type { Membership } from '../../../../apps/desktop/src/lib/billing/membership'

vi.mock('../../../../apps/desktop/src/platform', async importOriginal => {
  const original = await importOriginal<typeof import('../../../../apps/desktop/src/platform')>()
  return { ...original, platform: { ...original.platform, readDeviceFreeCreditsStatus: async () => 'device_full' } }
})

const hour = 3_600_000

function membership(overrides: Partial<Membership> = {}): Membership {
  return {
    planId: 'pro',
    tier: 'pro',
    monthlyPriceCny: 100,
    periodCredits: 45,
    periodHours: 720,
    expiresAt: null,
    balanceCredits: 570,
    topupCreditsPerCny: 10,
    ...overrides,
  }
}

function windows(overrides: Partial<QuotaWindows> = {}) {
  const now = Date.now()
  return {
    plan_id: 'pro',
    period_credits: 45,
    period_used: 20,
    period_started_at: new Date(now - hour).toISOString(),
    period_ends_at: new Date(now + 719 * hour).toISOString(),
    outstanding_credits: 0,
    credits_per_usd: 1,
    ...overrides,
  }
}

function account(options: { balance?: string; windows?: QuotaWindows; member?: Membership; balanceError?: Error; windowsError?: Error } = {}): Awaited<ReturnType<typeof readCreditV2Account>> {
  const member = options.member ?? membership({ expiresAt: new Date(Date.now() + 40 * 24 * hour) })
  const d = (value: string | number) => creditDecimal(String(value))
  return {
    balance: options.balanceError ? null : d(options.balance ?? '570'),
    windows: options.windowsError ? null : options.windows ?? windows(),
    plan: options.balanceError ? null : {
      planId: member.planId, tierKey: member.tier, expiresAt: member.expiresAt?.toISOString() ?? null,
      monthlyPriceCny: d(member.monthlyPriceCny), periodCredits: d(member.periodCredits),
      balanceCredits: d(options.balance ?? '570'), topupCreditsPerCny: d(member.topupCreditsPerCny), periodHours: member.periodHours,
    },
    meta: { credit_unit_version: 2, active_credit_unit_version: 2, gateway_price_version: 2, gateway_currency: 'CNY',
      fx_cny_per_usd: d('6.718'), fx_source_url: 'https://example.test/rate', fx_asof_date: '2026-11-04', fx_published_at_utc: '2026-11-04T07:00:00Z' },
    balanceError: options.balanceError ?? null, windowsError: options.windowsError ?? null,
  }
}

const flush = () => act(async () => {
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
})

async function render(credits?: number) {
  const harness = createReactHarness()
  await renderWithAppProviders(
    harness,
    createNode(UsageCredits, credits === undefined ? props : { ...props, credits: { status: 'ready', value: [{
      day: RANGE.from, model: 'display-fixture', credits, inputTokens: 0, outputTokens: 0, requests: 1,
    }] } }),
    { auth: { id: 'u1', email: 'u@e.com', nickname: 'U' } },
  )
  await flush()
  return harness
}

async function renderMembership() {
  const harness = createReactHarness()
  await renderWithAppProviders(harness, createNode(QueryClientProvider, { client: queryClient }, createNode(GuguSubscriptionRow, {})), { auth: { id: 'u1', email: 'u@e.com', nickname: 'U' } })
  await flush()
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return harness
}

beforeEach(() => {
  vi.clearAllMocks()
  queryClient.clear()
  // 余额不再由调用方以 prop 传进来:面板与侧栏、设置页读同一个共享订阅点。
  vi.mocked(readCreditV2Account).mockResolvedValue(account())
  vi.mocked(fetchLedgerPage).mockResolvedValue(ledger([]))
})

describe('#2503 用量与订阅积分的诚实性', () => {
  it('keeps tiny available, reserved, period and wallet credits visible in the shared subscription row', async () => {
    vi.mocked(readCreditV2Account).mockResolvedValue(account({ balance: '0.0001', windows: windows({ period_credits: creditDecimal('0.0004'), period_used: creditDecimal('0.0001'), outstanding_credits: creditDecimal('0.0001') }) }))
    const harness = await renderMembership()
    try {
      for (const field of ['subscription-credits-balance', 'subscription-period-credits', 'subscription-wallet-credits']) {
        expect(harness.container.querySelector(`[data-testid="${field}"]`)?.textContent?.trim()).toBe('<0.01')
      }
      expect(harness.container.querySelector('.subscription-credit-summary')?.textContent).toContain('预留 <0.01')
      expect(harness.container.querySelector('[data-testid="subscription-period"]')?.textContent).toContain('/ <0.01')
    } finally { harness.cleanup() }
  })

  it('shows the same nonzero tiny amount in the consumption total and ledger', async () => {
    vi.mocked(fetchLedgerPage).mockResolvedValue(ledger([{
      id: 'tiny', model: 'display-fixture', agent_user_id: null, credits_charged: 0.0001,
      input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0,
      created_at: new Date().toISOString(),
    }]))
    const harness = await render(0.0001)
    try {
      expect(harness.container.querySelector('[data-testid="usage-consumption"]')?.textContent).toContain('<0.01')
      expect(harness.container.querySelector('[data-field="cost"]')?.textContent).toBe('<0.01')
    } finally { harness.cleanup() }
  })

  it('#986 用量只保留消耗与流水，撤余额卡、邀请和五项总统计', async () => {
    const harness = await render()
    try {
      expect(document.querySelector('[data-testid="usage-credits-overview"]')).toBeNull()
      expect(document.querySelector('[data-testid="usage-credit-stats"]')).toBeNull()
      expect(document.querySelector('[data-testid="usage-referral"]')).toBeNull()
      expect(document.body.textContent).not.toContain('邀请好友')
      expect(document.querySelector('[data-testid="usage-consumption"]')).not.toBeNull()
      expect(document.querySelector('[data-testid="usage-ledger"]')).not.toBeNull()
    } finally { harness.cleanup() }
  })

  it('#986 切换时间段重置明细页码，并保留模型筛选', async () => {
    vi.mocked(fetchLedgerPage).mockResolvedValue({ rows: [], total: 80 })
    const harness = await render()
    try {
      await typeInto(document.querySelector('[data-testid="usage-ledger-model"]') as HTMLInputElement, 'claude')
      await act(async () => (document.querySelector('[data-testid="usage-ledger-search"]') as HTMLButtonElement).click())
      await flush()
      const second = [...document.querySelectorAll('[data-testid="usage-pager"] button')].find(button => button.textContent === '2') as HTMLButtonElement
      await act(async () => second.click())
      await flush()
      expect(fetchLedgerPage).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2, model: 'claude' }))
      const range = { from: '2026-09-17', to: RANGE.to, days: 7 }
      await renderWithAppProviders(harness, createNode(UsageCredits, { ...props, range }), { auth: { id: 'u1', email: 'u@e.com', nickname: 'U' } })
      await flush()
      expect(fetchLedgerPage).toHaveBeenLastCalledWith({ page: 1, pageSize: 20, model: 'claude', range: { from: range.from, to: range.to } })
      expect((document.querySelector('[data-testid="usage-ledger-model"]') as HTMLInputElement).value).toBe('claude')
    } finally { harness.cleanup() }
  })
  it('用量流水取失败 → 说取不到,不谎报「未找到日志」', async () => {
    vi.mocked(fetchLedgerPage).mockRejectedValue(new Error('network down'))
    const harness = await render()
    try {
      const failed = document.querySelector('[data-testid="usage-ledger-error"]')
      expect(failed, '取不到时应有一条明说取不到的文案').not.toBeNull()
      expect(failed!.textContent).toContain('network down')
      // 修复前这里渲染的正是这句 —— 把故障说成「你从没用过」。
      expect(document.body.textContent).not.toContain('未找到日志')
    } finally {
      harness.cleanup()
    }
  })

  it('确实没有记录 → 才说「未找到日志」', async () => {
    const harness = await render()
    try {
      expect(document.body.textContent).toContain('未找到日志')
      expect(document.querySelector('[data-testid="usage-ledger-error"]')).toBeNull()
    } finally {
      harness.cleanup()
    }
  })

  it('用量流水不依赖已经移到订阅的额度读取', async () => {
    vi.mocked(readCreditV2Account).mockResolvedValue(account({ windowsError: new Error('quota unavailable') }))
    vi.mocked(fetchLedgerPage).mockResolvedValue(ledger([
      { id: 'e1', model: 'glm-5.2-codex', agent_user_id: null, credits_charged: 7,
        input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0, created_at: new Date().toISOString() },
    ]))
    const harness = await render()
    try {
      expect(document.body.textContent).toContain('glm-5.2-codex')
    } finally {
      harness.cleanup()
    }
  })

  it('#6660 缓存读写写在 Tokens 下面 —— 2 个输入扣 0.08 积分的那一行要看得出钱花在缓存写入上', async () => {
    // 2026-09-27 开发网关 log 58028 的读数:Claude 走 anthropic 语义,输入不含缓存,缓存写入 61,825。
    vi.mocked(fetchLedgerPage).mockResolvedValue(ledger([
      { id: 'e1', model: 'claude-sonnet-5', agent_user_id: null, credits_charged: 0.077328,
        input_tokens: 2, output_tokens: 9, cache_read_tokens: 0, cache_creation_tokens: 61825, created_at: new Date().toISOString() },
      { id: 'e2', model: 'gpt-5.6-sol', agent_user_id: null, credits_charged: 0.0092,
        input_tokens: 40869, output_tokens: 43, cache_read_tokens: 40592, cache_creation_tokens: 209, created_at: new Date().toISOString() },
      { id: 'e3', model: 'glm-5.2-codex', agent_user_id: null, credits_charged: 7,
        input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0, created_at: new Date().toISOString() },
    ]))
    const harness = await render()
    try {
      expect(document.body.textContent).toContain('glm-5.2-codex')
      const cache = [...document.querySelectorAll('[data-testid="usage-ledger-cache"]')].map((el) => el.textContent)
      expect(cache).toEqual(['缓存 ↑ 61,825', '缓存 ↓ 40,592 ↑ 209'])
    } finally {
      harness.cleanup()
    }
  })

  it('订阅卡周期耗尽仍显示不过期积分与真实总额', async () => {
    vi.mocked(readCreditV2Account).mockResolvedValue(account({ windows: windows({ period_used: 45 }) }))
    const harness = await renderMembership()
    try {
      expect(document.querySelector('[data-testid="subscription-credits-balance"]')?.textContent?.trim()).toBe('570')
      expect(document.querySelector('[data-testid="subscription-period-credits"]')?.textContent).toBe('0')
      expect(document.querySelector('[data-testid="subscription-wallet-credits"]')?.textContent).toBe('570')
      expect(document.body.textContent).not.toContain('已用完')
      expect(document.body.textContent).not.toContain('最多能花')
    } finally { harness.cleanup() }
  })

  it('订阅卡两个池子都空时显示真实零，充值仍可达', async () => {
    vi.mocked(readCreditV2Account).mockResolvedValue(account({ balance: '0', windows: windows({ period_used: 45 }) }))
    const harness = await renderMembership()
    try {
      expect(document.querySelector('[data-testid="subscription-credits-balance"]')?.textContent?.trim()).toBe('0')
      expect(document.querySelector('[data-testid="subscription-period-credits"]')?.textContent).toBe('0')
      expect(document.querySelector('[data-testid="subscription-wallet-credits"]')?.textContent).toBe('0')
      expect(document.querySelector('a[data-testid="membership-open-web"]')?.getAttribute('href')).toMatch(/^https:/)
      expect(document.body.textContent).not.toContain('最多能花')
    } finally { harness.cleanup() }
  })

  it('订阅卡只显示本期进度，不复活已撤销的短窗口径', async () => {
    const harness = await renderMembership()
    try {
      expect(document.querySelectorAll('[role="meter"]')).toHaveLength(1)
      expect(document.querySelector('[data-testid="subscription-period-credits"]')).not.toBeNull()
      expect(document.body.textContent).not.toContain('5 小时')
      expect(document.querySelector('[data-testid="subscription-billing-copy"]')).toBeNull()
    } finally { harness.cleanup() }
  })

  it('订阅卡两个池子都有时合计正确，且不夹带周期营销说明', async () => {
    const harness = await renderMembership()
    try {
      expect(document.querySelector('[data-testid="subscription-credits-balance"]')?.textContent?.trim()).toBe('595')
      expect(document.querySelector('[data-testid="subscription-period-credits"]')?.textContent).toBe('25')
      expect(document.querySelector('[data-testid="subscription-wallet-credits"]')?.textContent).toBe('570')
      expect(document.body.textContent).not.toContain('最多能花')
      expect(document.body.textContent).not.toContain('周期内怎么花')
    } finally { harness.cleanup() }
  })

  it('#986 用量不再读取余额或会员，充值入口只在订阅卡', async () => {
    const harness = await render()
    try {
      expect(document.querySelector('[data-testid="usage-credits-balance"]')).toBeNull()
      expect(document.querySelector('a[data-testid="membership-open-web"]')).toBeNull()
    } finally { harness.cleanup() }
  })

  it.each(['balance', 'quota'] as const)('订阅卡 %s 读取失败保留原因，不把未知合计画成零', async source => {
    if (source === 'balance') vi.mocked(readCreditV2Account).mockResolvedValue(account({ balanceError: new Error('balance unavailable') }))
    else vi.mocked(readCreditV2Account).mockResolvedValue(account({ windowsError: new Error('quota unavailable') }))
    const harness = await renderMembership()
    try {
      expect(document.querySelector('.subscription-error')?.textContent).toContain(`${source} unavailable`)
      expect(document.querySelector('[data-testid="subscription-credits-balance"]')?.textContent?.trim()).toBe('—')
      expect(document.querySelector('[data-testid="subscription-wallet-credits"]')?.textContent).toBe('—')
    } finally { harness.cleanup() }
  })

  it('会员行区分会员到期日与周期刷新日', async () => {
    const harness = await renderMembership()
    try {
      const row = document.querySelector('[data-testid="subscription-row-gugu"]')!
      expect(row.textContent).toContain('Pro')
      expect(row.textContent).toContain('到期')
      expect(row.textContent).toContain('刷新')
      expect(row.querySelector('[role="meter"]')).not.toBeNull()
    } finally { harness.cleanup() }
  })

  it('会员行免费档不编造到期日', async () => {
    vi.mocked(readCreditV2Account).mockResolvedValue(account({ member: membership({ planId: 'default', tier: 'free', expiresAt: null }) }))
    const harness = await renderMembership()
    try {
      const row = document.querySelector('[data-testid="subscription-row-gugu"]')!
      expect(row.querySelector('.subscription-plan-badge')?.textContent).toBe('Free')
      expect(row.querySelector('.subscription-service-identity')?.textContent).toBe('无到期日')
    } finally { harness.cleanup() }
  })

  it.each(['free', 'max'] as const)('设备领满时，只有确认 Free 会员才显示免费额度提示（%s）', async tier => {
    vi.mocked(readCreditV2Account).mockResolvedValue(account({ member: membership({ tier }) }))
    const harness = await renderMembership()
    try {
      const text = harness.container.querySelector('[data-testid="subscription-row-gugu"]')!.textContent ?? ''
      expect(text.includes('这台设备已有 5 个账号领过免费额度')).toBe(tier === 'free')
    } finally { harness.cleanup() }
  })

  it('会员档位正在读取时，不用设备领满提示冒充已确认 Free', async () => {
    vi.mocked(readCreditV2Account).mockReturnValue(new Promise(() => {}))
    const harness = await renderMembership()
    try {
      const row = harness.container.querySelector('[data-testid="subscription-row-gugu"]')!
      expect(row.querySelector('.subscription-plan-badge')).toBeNull()
      expect(row.textContent).not.toContain('这台设备已有 5 个账号领过免费额度')
    } finally { harness.cleanup() }
  })

  it('会员行回到前台后重读网页刚开通的档位', async () => {
    vi.mocked(readCreditV2Account).mockResolvedValue(account({ member: membership({ planId: 'default', tier: 'free', expiresAt: null }) }))
    const harness = await renderMembership()
    try {
      const badge = () => document.querySelector('.subscription-plan-badge')?.textContent
      expect(badge()).toBe('Free')
      vi.mocked(readCreditV2Account).mockResolvedValue(account({ member: membership({ expiresAt: new Date(Date.now() + 30 * 24 * hour) }) }))
      await act(async () => { window.dispatchEvent(new Event('focus')) })
      await flush()
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
      expect(badge()).toBe('Pro')
    } finally { harness.cleanup() }
  })

  it('会员行读取失败不能冒充免费档', async () => {
    vi.mocked(readCreditV2Account).mockResolvedValue(account({ balanceError: new Error('membership down') }))
    const harness = await renderMembership()
    try {
      const row = document.querySelector('[data-testid="subscription-row-gugu"]')!
      expect(row.textContent).toContain('membership down')
      expect(row.querySelector('.subscription-plan-badge')).toBeNull()
      expect(row.textContent).not.toContain('这台设备已有 5 个账号领过免费额度')
    } finally { harness.cleanup() }
  })

  it('额度还没回来时占位,不是整段消失(状态覆盖:loading)', async () => {
    // 面板打开 → 余额下面空一块 → 条突然弹出。下面「动态」一直有「加载中…」,
    // 同一个面板不能两套规矩。
    type Account = Awaited<ReturnType<typeof readCreditV2Account>>
    let release: (w: Account) => void = () => {}
    vi.mocked(readCreditV2Account).mockReturnValue(new Promise<Account>((resolve) => { release = resolve }))
    const harness = createReactHarness()
    try {
      await renderWithAppProviders(
        harness,
        createNode(QueryClientProvider, { client: queryClient }, createNode(GuguSubscriptionRow, {})),
        { auth: { id: 'u1', email: 'u@e.com', nickname: 'U' } },
      )
      await flush()
      expect(document.querySelector('[data-testid="subscription-credits-loading"]')).not.toBeNull()

      release(account())
      await flush()
      expect(document.querySelector('[data-testid="subscription-credits-loading"]')).toBeNull()
      expect(document.querySelectorAll('[role="meter"]')).toHaveLength(1)
      expect(document.querySelector('[data-testid="subscription-period-credits"]')).not.toBeNull()
    } finally {
      harness.cleanup()
    }
  })
})
