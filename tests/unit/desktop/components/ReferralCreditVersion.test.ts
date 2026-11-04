// @vitest-environment jsdom
import { act, createElement } from 'react'
import { expect, it, vi } from 'vitest'
import { ReferralCard } from '../../../../apps/desktop/src/components/usage/ReferralCard'
import { useSpendingPower, refreshSpendingPower } from '../../../../apps/desktop/src/lib/billing/useSpendingPower'
import { readCreditV2Account } from '../../../../apps/desktop/src/lib/billing/v2/runtime'
import { getReferralStats } from '../../../../apps/desktop/src/lib/billing/balance'
import { CreditV2StateError } from '../../../../apps/desktop/src/lib/billing/v2/active'
import { creditDecimal as d } from '@gugu/core/billing/creditAmount'
import { createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/lib/billing/v2/runtime', () => ({ readCreditV2Account: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/billing/balance', async original => ({ ...(await original<typeof import('../../../../apps/desktop/src/lib/billing/balance')>()), getReferralStats: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/realtimeChannel', () => ({ subscribePrivateUserEventBus: vi.fn(() => ({})), unsubscribePrivateUserEventBus: vi.fn() }))
const user = { id: 'review-user', email: 'review@example.test', nickname: 'Review', gugu_number: 100693 }
function Probe() { return createElement('pre', { id: 'review-state' }, JSON.stringify(useSpendingPower(user))) }
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

it('review: referral credits cannot keep the last active-v2 value after that user has a confirmed not-active account state', async () => {
  const harness = createReactHarness()
  try {
    vi.mocked(readCreditV2Account).mockResolvedValue({
      balance: d('7.5'), balanceError: null, windowsError: null,
      windows: { plan_id: 'free', period_credits: d('7.5'), period_used: d('0'), outstanding_credits: d('0'), credits_per_usd: null,
        period_started_at: '2026-11-01T00:00:00Z', period_ends_at: '2026-12-01T00:00:00Z' },
      plan: { planId: 'free', tierKey: 'free', monthlyPriceCny: d('0'), periodCredits: d('7.5'), balanceCredits: d('7.5'), topupCreditsPerCny: d('1'), periodHours: 720, expiresAt: null },
      meta: { credit_unit_version: 2, active_credit_unit_version: 2, gateway_price_version: 2, gateway_currency: 'CNY',
        fx_cny_per_usd: null, fx_source_url: null, fx_asof_date: null, fx_published_at_utc: null },
    })
    vi.mocked(getReferralStats).mockResolvedValue({ invitedCount: 1, creditsEarned: 7.5 })
    await renderWithAppProviders(harness, createElement('div', null, createElement(Probe), createElement(ReferralCard)), { auth: user })
    await flush()
    expect(harness.container.querySelector('[data-testid="settings-quota-credits-earned"]')?.textContent).toContain('7.5')
    const inactive = new CreditV2StateError('not-active')
    vi.mocked(readCreditV2Account).mockRejectedValue(inactive)
    vi.mocked(getReferralStats).mockRejectedValue(inactive)
    await act(async () => { refreshSpendingPower() }); await flush()
    const account = JSON.parse(harness.container.querySelector('#review-state')!.textContent!)
    const earned = harness.container.querySelector('[data-testid="settings-quota-credits-earned"]')?.textContent
    expect(account.creditVersion).toBeNull()
    expect(account.balanceError).toContain('not-active')
    // The existing failure state removes the stats nodes; absence must also reject stale credit text.
    expect(earned ?? '').not.toContain('7.5')
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain('邀请信息加载失败')
  } finally { harness.cleanup(); vi.clearAllMocks() }
})

function activeAccount(): Awaited<ReturnType<typeof readCreditV2Account>> {
  return {
    balance: d('7.5'), balanceError: null, windowsError: null,
    windows: { plan_id: 'free', period_credits: d('7.5'), period_used: d('0'), outstanding_credits: d('0'), credits_per_usd: null,
      period_started_at: '2026-11-01T00:00:00Z', period_ends_at: '2026-12-01T00:00:00Z' },
    plan: { planId: 'free', tierKey: 'free', monthlyPriceCny: d('0'), periodCredits: d('7.5'), balanceCredits: d('7.5'), topupCreditsPerCny: d('1'), periodHours: 720, expiresAt: null },
    meta: { credit_unit_version: 2, active_credit_unit_version: 2, gateway_price_version: 2, gateway_currency: 'CNY',
      fx_cny_per_usd: null, fx_source_url: null, fx_asof_date: null, fx_published_at_utc: null },
  }
}

it('discards a late old-version referral reply after showing the existing failure state', async () => {
  const harness = createReactHarness()
  try {
    vi.mocked(readCreditV2Account).mockResolvedValue(activeAccount())
    vi.mocked(getReferralStats).mockResolvedValue({ invitedCount: 1, creditsEarned: 7.5 })
    await renderWithAppProviders(harness, createElement(ReferralCard), { auth: user }); await flush()
    let release!: (value: { invitedCount: number; creditsEarned: number }) => void
    vi.mocked(getReferralStats).mockReturnValue(new Promise(resolve => { release = resolve }))
    await act(async () => { window.dispatchEvent(new Event('focus')) }); await flush()
    expect(harness.container.querySelector('[data-testid="settings-quota-credits-earned"]')?.textContent ?? '').not.toContain('7.5')
    const inactive = new CreditV2StateError('not-active')
    vi.mocked(readCreditV2Account).mockRejectedValue(inactive)
    vi.mocked(getReferralStats).mockRejectedValue(inactive)
    await act(async () => { refreshSpendingPower() }); await flush()
    await act(async () => { release({ invitedCount: 1, creditsEarned: 777 }) }); await flush()
    expect(harness.container.textContent).not.toContain('777')
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain('邀请信息加载失败')
  } finally { harness.cleanup(); vi.clearAllMocks() }
})

it('refreshes referral statistics when active metadata changes and on the shared activity revision', async () => {
  const harness = createReactHarness()
  try {
    vi.mocked(readCreditV2Account).mockResolvedValue(activeAccount())
    vi.mocked(getReferralStats).mockResolvedValue({ invitedCount: 1, creditsEarned: 7.5 })
    await renderWithAppProviders(harness, createElement(ReferralCard), { auth: user }); await flush()
    const before = vi.mocked(getReferralStats).mock.calls.length
    const next = activeAccount(); next.meta.fx_cny_per_usd = d('6.7')
    vi.mocked(readCreditV2Account).mockResolvedValue(next)
    vi.mocked(getReferralStats).mockResolvedValue({ invitedCount: 2, creditsEarned: 8.5 })
    await act(async () => { refreshSpendingPower() }); await flush()
    expect(vi.mocked(getReferralStats).mock.calls.length).toBeGreaterThan(before)
    expect(harness.container.querySelector('[data-testid="settings-quota-credits-earned"]')?.textContent).toContain('8.5')
    vi.mocked(getReferralStats).mockResolvedValue({ invitedCount: 3, creditsEarned: 9.5 })
    await act(async () => { window.dispatchEvent(new Event('focus')) }); await flush()
    expect(harness.container.querySelector('[data-testid="settings-quota-credits-earned"]')?.textContent).toContain('9.5')
  } finally { harness.cleanup(); vi.clearAllMocks() }
})
