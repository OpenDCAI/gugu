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

// billing 模块拆开后,会走网络的读取分别落在 balance / quota / usage 三个数据访问面;
// 领域推导与共享订阅点保持真实,替换的只有网络那一层。
vi.mock('../../../../apps/desktop/src/lib/billing/balance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../apps/desktop/src/lib/billing/balance')>()),
  getCreditsBalance: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/lib/billing/quota', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../apps/desktop/src/lib/billing/quota')>()),
  getQuotaWindows: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/lib/usage/cloud', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../apps/desktop/src/lib/usage/cloud')>()),
  fetchLedgerPage: vi.fn(),
}))
import { getCreditsBalance } from '../../../../apps/desktop/src/lib/billing/balance'
import { getQuotaWindows } from '../../../../apps/desktop/src/lib/billing/quota'
import { fetchLedgerPage, type LedgerRow } from '../../../../apps/desktop/src/lib/usage/cloud'

const ledger = (rows: LedgerRow[]) => ({ rows, total: rows.length })
const RANGE = { from: '2026-08-25', to: '2026-09-23', days: 30 }
const props = { credits: { status: 'ready' as const, value: [] }, guguTokens: { status: 'ready' as const, value: 0 }, range: RANGE }
vi.mock('../../../../apps/desktop/src/lib/billing/membership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../apps/desktop/src/lib/billing/membership')>()),
  getMembership: vi.fn(),
}))
import { getMembership, type Membership } from '../../../../apps/desktop/src/lib/billing/membership'

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

function windows(overrides: Partial<Awaited<ReturnType<typeof getQuotaWindows>>> = {}) {
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

const flush = () => act(async () => {
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
})

async function render() {
  const harness = createReactHarness()
  await renderWithAppProviders(
    harness,
    createNode(UsageCredits, props),
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
  vi.mocked(getCreditsBalance).mockResolvedValue(570)
  vi.mocked(getQuotaWindows).mockResolvedValue(windows())
  vi.mocked(fetchLedgerPage).mockResolvedValue(ledger([]))
  vi.mocked(getMembership).mockResolvedValue(membership({ expiresAt: new Date(Date.now() + 40 * 24 * hour) }))
})

describe('#2503 用量页积分段的诚实性', () => {
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

  it('额度接口挂了不该把用量流水一起吞掉(两条链路各自落地)', async () => {
    vi.mocked(getQuotaWindows).mockRejectedValue(new Error('quota unavailable'))
    vi.mocked(fetchLedgerPage).mockResolvedValue(ledger([
      { id: 'e1', model: 'glm-5.2-codex', agent_user_id: null, credits_charged: 7,
        input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0, created_at: new Date().toISOString() },
    ]))
    const harness = await render()
    try {
      expect(document.querySelector('[data-testid="usage-credits-error"]')).not.toBeNull()
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

  it('周期额度耗尽但还有不过期积分 → 照样报能花多少,❌ 不说「已用完」', async () => {
    // 会员额度用尽只是换个池子出钱(先周期额度、后不过期积分),不是花不出去。
    // 旧口径在这里报「30 天额度已用完」,而这位用户账上还有 570 积分,充值也解决不了 —— 他压根没被挡住。
    vi.mocked(getQuotaWindows).mockResolvedValue(windows({ period_used: 45 }))
    const harness = await render()
    try {
      const summary = document.querySelector('[data-testid="usage-credits-window-summary"]')
      expect(summary).not.toBeNull()
      expect(summary!.textContent).toBe('30 天内最多能花 570 积分')
      expect(summary!.textContent).not.toContain('已用完')
      // 两种积分各剩多少要分得出:周期额度 0、不过期积分 570。
      // 两个池子各一格(New API 余额面板的两个小格),各自标名、各自报数。
      expect(document.querySelector('[data-testid="usage-credits-period-credits"]')!.textContent).toBe('0')
      expect(document.querySelector('[data-testid="usage-credits-wallet-credits"]')!.textContent).toBe('570')
      expect(document.querySelector('[data-testid="usage-credits-breakdown"]')!.textContent).toContain('不过期积分')
    } finally {
      harness.cleanup()
    }
  })

  it('两个池子都空了 → 才说「都已用完」,并把两条出路一起说', async () => {
    vi.mocked(getCreditsBalance).mockResolvedValue(0)
    vi.mocked(getQuotaWindows).mockResolvedValue(windows({ period_used: 45 }))
    const harness = await render()
    try {
      const summary = document.querySelector('[data-testid="usage-credits-window-summary"]')
      expect(summary!.textContent).toContain('都已用完')
      expect(summary!.textContent).toContain('充值加量包可立即恢复')
      expect(summary!.textContent).not.toContain('最多能花')
    } finally {
      harness.cleanup()
    }
  })

  it('❌ 不再画短窗那条 —— 概念已撤销,留着就是留一条永远说不清的进度条', async () => {
    vi.mocked(getQuotaWindows).mockResolvedValue(windows())
    const harness = await render()
    try {
      expect(document.querySelector('[data-testid="usage-credits-period"]')).toBeNull()
      expect(document.querySelector('[data-testid="usage-credits-period-credits"]')).not.toBeNull()
      expect(document.querySelector('[data-testid="usage-credits-burst"]')).toBeNull()
      expect(document.body.textContent).not.toContain('5 小时')
    } finally {
      harness.cleanup()
    }
  })

  it('两个池子都有 → 报合计,不误报已用完', async () => {
    const harness = await render()
    try {
      const summary = document.querySelector('[data-testid="usage-credits-window-summary"]')
      // 不过期积分 570 + 周期额度余 45−20=25 → 595。两个池子相加,❌ 不取小(旧口径答 25)。
      expect(summary!.textContent).toBe('30 天内最多能花 595 积分')
      expect(summary!.textContent).not.toContain('已用完')
      // 两个池子各一格(New API 余额面板的两个小格),各自标名、各自报数。
      expect(document.querySelector('[data-testid="usage-credits-period-credits"]')!.textContent).toBe('25')
      expect(document.querySelector('[data-testid="usage-credits-wallet-credits"]')!.textContent).toBe('570')
      expect(document.querySelector('[data-testid="usage-credits-breakdown"]')!.textContent).toContain('不过期积分')
    } finally {
      harness.cleanup()
    }
  })

  it('#986 用量不再显示会员段，但保留积分数字和充值入口', async () => {
    const harness = await render()
    try {
      expect(document.querySelector('[data-testid="usage-credits-membership"]')).toBeNull()
      expect(document.querySelector('[data-testid="usage-credits-balance"]')?.textContent).toBe('595')
      expect(document.querySelector('a[data-testid="membership-open-web"]')?.getAttribute('href')).toMatch(/^https:/)
      expect(getMembership).not.toHaveBeenCalled()
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
    vi.mocked(getMembership).mockResolvedValue(membership({ planId: 'default', tier: 'free', expiresAt: null }))
    const harness = await renderMembership()
    try {
      const row = document.querySelector('[data-testid="subscription-row-gugu"]')!
      expect(row.querySelector('.subscription-plan-badge')?.textContent).toBe('Free')
      expect(row.querySelector('.subscription-service-identity')?.textContent).toBe('无到期日')
    } finally { harness.cleanup() }
  })

  it('会员行回到前台后重读网页刚开通的档位', async () => {
    vi.mocked(getMembership).mockResolvedValue(membership({ planId: 'default', tier: 'free', expiresAt: null }))
    const harness = await renderMembership()
    try {
      const badge = () => document.querySelector('.subscription-plan-badge')?.textContent
      expect(badge()).toBe('Free')
      vi.mocked(getMembership).mockResolvedValue(membership({ expiresAt: new Date(Date.now() + 30 * 24 * hour) }))
      await act(async () => { window.dispatchEvent(new Event('focus')) })
      await flush()
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
      expect(badge()).toBe('Pro')
    } finally { harness.cleanup() }
  })

  it('会员行读取失败不能冒充免费档', async () => {
    vi.mocked(getMembership).mockRejectedValue(new Error('membership down'))
    const harness = await renderMembership()
    try {
      const row = document.querySelector('[data-testid="subscription-row-gugu"]')!
      expect(row.textContent).toContain('membership down')
      expect(row.querySelector('.subscription-plan-badge')).toBeNull()
    } finally { harness.cleanup() }
  })

  it('额度还没回来时占位,不是整段消失(状态覆盖:loading)', async () => {
    // 面板打开 → 余额下面空一块 → 条突然弹出。下面「动态」一直有「加载中…」,
    // 同一个面板不能两套规矩。
    type Windows = Awaited<ReturnType<typeof getQuotaWindows>>
    let release: (w: Windows) => void = () => {}
    vi.mocked(getQuotaWindows).mockReturnValue(new Promise<Windows>((resolve) => { release = resolve }))
    const harness = createReactHarness()
    try {
      await renderWithAppProviders(
        harness,
        createNode(UsageCredits, props),
        { auth: { id: 'u1', email: 'u@e.com', nickname: 'U' } },
      )
      await flush()
      expect(document.querySelector('[data-testid="usage-credits-windows-loading"]')).not.toBeNull()

      release(windows())
      await flush()
      expect(document.querySelector('[data-testid="usage-credits-windows-loading"]')).toBeNull()
      expect(document.querySelector('[data-testid="usage-credits-period"]')).toBeNull()
      expect(document.querySelector('[data-testid="usage-credits-period-credits"]')).not.toBeNull()
    } finally {
      harness.cleanup()
    }
  })
})
