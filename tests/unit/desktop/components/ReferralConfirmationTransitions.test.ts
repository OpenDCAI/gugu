// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ReferralCard } from '../../../../apps/desktop/src/components/usage/ReferralCard'
import { useSpendingPower, refreshSpendingPower } from '../../../../apps/desktop/src/lib/billing/useSpendingPower'
import { readCreditV2Account } from '../../../../apps/desktop/src/lib/billing/v2/runtime'
import { getReferralStats, type ReferralStats } from '../../../../apps/desktop/src/lib/billing/balance'
import { CreditV2StateError } from '../../../../apps/desktop/src/lib/billing/v2/active'
import { creditDecimal as d } from '@gugu/core/billing/creditAmount'
import { createReactHarness, renderWithAppProviders, clickElement } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/lib/billing/v2/runtime', () => ({ readCreditV2Account: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/billing/balance', async original => ({ ...(await original<typeof import('../../../../apps/desktop/src/lib/billing/balance')>()), getReferralStats: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/realtimeChannel', () => ({ subscribePrivateUserEventBus: vi.fn(() => ({})), unsubscribePrivateUserEventBus: vi.fn() }))
const user = { id: 'transition-user', email: 'transition@example.test', nickname: 'Transition', gugu_number: 100693 }
type Account = Awaited<ReturnType<typeof readCreditV2Account>>
function account(): Account {
  return {
    balance: d('7.5'), balanceError: null, windowsError: null,
    windows: { plan_id: 'free', period_credits: d('7.5'), period_used: d('0'), outstanding_credits: d('0'), credits_per_usd: null,
      period_started_at: '2026-11-01T00:00:00Z', period_ends_at: '2026-12-01T00:00:00Z' },
    plan: { planId: 'free', tierKey: 'free', monthlyPriceCny: d('0'), periodCredits: d('7.5'), balanceCredits: d('7.5'), topupCreditsPerCny: d('1'), periodHours: 720, expiresAt: null },
    meta: { credit_unit_version: 2, active_credit_unit_version: 2, gateway_price_version: 2, gateway_currency: 'CNY',
      fx_cny_per_usd: null, fx_source_url: null, fx_asof_date: null, fx_published_at_utc: null },
  }
}
function Probe({ owner }: { owner: typeof user }) { return createElement('pre', null, JSON.stringify(useSpendingPower(owner))) }
let harness: ReturnType<typeof createReactHarness>
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
const earned = () => harness.container.querySelector('[data-testid="settings-quota-credits-earned"]')?.textContent ?? ''
const confirmation = () => JSON.parse(harness.container.querySelector('pre')!.textContent!).creditConfirmation
const failed = () => expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain('邀请信息加载失败')
async function render(owner = user) {
  await renderWithAppProviders(harness, createElement('div', null, createElement(Probe, { owner }), createElement(ReferralCard)), { auth: owner })
  await flush()
}
beforeEach(() => {
  vi.resetAllMocks(); harness = createReactHarness()
  vi.mocked(readCreditV2Account).mockResolvedValue(account())
  vi.mocked(getReferralStats).mockResolvedValue({ invitedCount: 1, creditsEarned: 7.5 })
})
afterEach(() => { harness.cleanup() })

const failures = [
  { name: 'not-active', error: new CreditV2StateError('not-active'), state: 'not-active' },
  { name: 'missing RPC', error: new Error('translated missing contract', { cause: new CreditV2StateError('not-installed') }), state: 'contract-missing' },
  { name: 'conflicting Meta', error: new CreditV2StateError('inconsistent'), state: 'contract-missing' },
  { name: 'missing Meta', error: new CreditV2StateError('unknown'), state: 'contract-missing' },
  { name: 'network failure', error: new Error('CORS network failed'), state: 'unconfirmed' },
  { name: 'RLS failure', error: new Error('permission denied'), state: 'unconfirmed' },
]
it.each(failures)('initial confirmation failure: $name cancels the earlier statistics response', async ({ error, state }) => {
  const pendingAccount = Promise.withResolvers<Account>(), old = Promise.withResolvers<ReferralStats>()
  vi.mocked(readCreditV2Account).mockReturnValue(pendingAccount.promise)
  vi.mocked(getReferralStats).mockReturnValueOnce(old.promise).mockRejectedValue(error)
  await render()
  expect(confirmation()).toEqual({ state: 'unconfirmed', revision: 0 })
  await act(async () => { pendingAccount.reject(error) }); await flush()
  expect(confirmation()).toEqual({ state, revision: 1 })
  expect(getReferralStats).toHaveBeenCalledTimes(2)
  await act(async () => { old.resolve({ invitedCount: 1, creditsEarned: 777 }) }); await flush()
  expect(earned()).not.toContain('777'); failed()
})

it('confirms active2 after an unconfirmed read without accepting the old reply', async () => {
  const pendingAccount = Promise.withResolvers<Account>(), old = Promise.withResolvers<ReferralStats>()
  vi.mocked(readCreditV2Account).mockReturnValue(pendingAccount.promise)
  vi.mocked(getReferralStats).mockReturnValueOnce(old.promise).mockResolvedValue({ invitedCount: 2, creditsEarned: 8.5 })
  await render()
  await act(async () => { pendingAccount.resolve(account()) }); await flush()
  expect(confirmation()).toEqual({ state: 'active2', revision: 1 })
  expect(earned()).toContain('8.5')
  await act(async () => { old.resolve({ invitedCount: 1, creditsEarned: 777 }) }); await flush()
  expect(earned()).toContain('8.5'); expect(earned()).not.toContain('777')
})

it('recovers referral statistics after not-active becomes active2', async () => {
  const error = new CreditV2StateError('not-active')
  vi.mocked(readCreditV2Account).mockRejectedValue(error)
  vi.mocked(getReferralStats).mockRejectedValue(error)
  await render(); failed()
  vi.mocked(readCreditV2Account).mockResolvedValue(account())
  vi.mocked(getReferralStats).mockResolvedValue({ invitedCount: 2, creditsEarned: 8.5 })
  await act(async () => { refreshSpendingPower() }); await flush()
  expect(confirmation()).toEqual({ state: 'active2', revision: 2 })
  expect(earned()).toContain('8.5'); expect(harness.container.querySelector('[role="alert"]')).toBeNull()
})

it.each(failures)('invalidates active referral statistics on $name', async ({ error, state }) => {
  await render(); expect(earned()).toContain('7.5')
  vi.mocked(readCreditV2Account).mockRejectedValue(error)
  vi.mocked(getReferralStats).mockRejectedValue(error)
  await act(async () => { refreshSpendingPower() }); await flush()
  expect(confirmation()).toEqual({ state, revision: 2 })
  expect(earned()).not.toContain('7.5'); failed()
})

it('invalidates again when the same account failure repeats without changing its confirmation tag', async () => {
  const error = new Error('network failed')
  vi.mocked(readCreditV2Account).mockRejectedValue(error)
  vi.mocked(getReferralStats).mockRejectedValue(error)
  await render(); failed()
  const count = vi.mocked(getReferralStats).mock.calls.length
  const old = Promise.withResolvers<ReferralStats>()
  vi.mocked(getReferralStats).mockReturnValueOnce(old.promise).mockRejectedValue(error)
  await act(async () => { refreshSpendingPower() }); await flush()
  expect(confirmation()).toEqual({ state: 'unconfirmed', revision: 2 })
  await act(async () => { refreshSpendingPower() }); await flush()
  expect(confirmation()).toEqual({ state: 'unconfirmed', revision: 3 })
  expect(vi.mocked(getReferralStats).mock.calls.length).toBe(count + 2)
  await act(async () => { old.resolve({ invitedCount: 1, creditsEarned: 777 }) }); await flush()
  expect(earned()).not.toContain('777'); failed()
})

it('refreshes referral statistics on shared focus activity while the account read is still pending', async () => {
  await render(); expect(earned()).toContain('7.5')
  vi.mocked(readCreditV2Account).mockReturnValue(new Promise(() => {}))
  vi.mocked(getReferralStats).mockResolvedValue({ invitedCount: 2, creditsEarned: 8.5 })
  await act(async () => { window.dispatchEvent(new Event('focus')) }); await flush()
  expect(earned()).toContain('8.5')
})

it('isolates referral reads across account A to B to A, including late replies', async () => {
  vi.mocked(readCreditV2Account).mockReturnValue(new Promise(() => {}))
  const oldA = Promise.withResolvers<ReferralStats>(), oldB = Promise.withResolvers<ReferralStats>()
  vi.mocked(getReferralStats).mockReturnValueOnce(oldA.promise).mockReturnValueOnce(oldB.promise).mockResolvedValue({ invitedCount: 3, creditsEarned: 9.5 })
  await render()
  await render({ ...user, id: 'other-user', gugu_number: 2000 })
  await render(); expect(earned()).toContain('9.5')
  await act(async () => { oldA.resolve({ invitedCount: 1, creditsEarned: 777 }); oldB.resolve({ invitedCount: 1, creditsEarned: 888 }) }); await flush()
  expect(earned()).toContain('9.5'); expect(harness.container.textContent).not.toMatch(/777|888/)
})

// Exercise every confirmation-tag pair through the real store, with an old statistics request pending.
const tags = ['unconfirmed', 'active2', 'not-active', 'contract-missing'] as const
function accountResult(tag: typeof tags[number]): Promise<Account> {
  if (tag === 'active2') return Promise.resolve(account())
  return Promise.reject(tag === 'unconfirmed' ? new Error('account transport failed')
    : new CreditV2StateError(tag === 'not-active' ? 'not-active' : 'not-installed'))
}
it.each(tags.flatMap(from => tags.map(to => ({ from, to }))))('confirmation $from -> $to retires the pending previous generation', async ({ from, to }) => {
  const readFailed = new Error('invitation statistics unavailable')
  vi.mocked(readCreditV2Account).mockImplementation(() => accountResult(from))
  vi.mocked(getReferralStats).mockRejectedValue(readFailed)
  await render(); failed()
  expect(confirmation()).toEqual({ state: from, revision: 1 })
  const old = Promise.withResolvers<ReferralStats>()
  vi.mocked(getReferralStats).mockReturnValueOnce(old.promise).mockRejectedValue(readFailed)
  await clickElement(harness.container.querySelector('[role="alert"] button')!); await flush()
  vi.mocked(readCreditV2Account).mockImplementation(() => accountResult(to))
  if (to === 'active2') vi.mocked(getReferralStats).mockResolvedValue({ invitedCount: 2, creditsEarned: 8.5 })
  const reads = vi.mocked(getReferralStats).mock.calls.length
  await act(async () => { refreshSpendingPower() }); await flush()
  expect(confirmation()).toEqual({ state: to, revision: 2 })
  expect(getReferralStats).toHaveBeenCalledTimes(reads + 1)
  await act(async () => { old.resolve({ invitedCount: 1, creditsEarned: 777 }) }); await flush()
  expect(earned()).not.toContain('777')
  if (to === 'active2') {
    expect(earned()).toContain('8.5'); expect(harness.container.querySelector('[role="alert"]')).toBeNull()
  } else failed()
})
