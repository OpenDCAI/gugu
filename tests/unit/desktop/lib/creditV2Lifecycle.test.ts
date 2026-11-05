// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { creditDecimal } from '@gugu/core/billing/creditAmount'
import { useSpendingPower, refreshSpendingPower } from '../../../../apps/desktop/src/lib/billing/useSpendingPower'
import { useCreditData } from '../../../../apps/desktop/src/components/usage/useUsageData'
import { fetchCreditDays } from '../../../../apps/desktop/src/lib/usage/cloud'
import type { CreditUsageDay } from '@gugu/core/shared/usage/dailyUsage'
import { readCreditV2Account } from '../../../../apps/desktop/src/lib/billing/v2/runtime'
vi.mock('../../../../apps/desktop/src/lib/billing/v2/runtime', () => ({ readCreditV2Account: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/usage/cloud', async original => ({ ...(await original<typeof import('../../../../apps/desktop/src/lib/usage/cloud')>()), fetchCreditDays: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/realtimeChannel', () => ({ subscribePrivateUserEventBus: vi.fn(() => ({})), unsubscribePrivateUserEventBus: vi.fn() }))

type Account = Awaited<ReturnType<typeof readCreditV2Account>>
function account(balance = '7.50000000'): Account {
  const d = creditDecimal
  return {
    balance: d(balance), balanceError: null, windowsError: null,
    plan: { planId: 'free', tierKey: 'free', monthlyPriceCny: d('0'), periodCredits: d('7.5'), balanceCredits: d(balance), topupCreditsPerCny: d('1'), periodHours: 720, expiresAt: null },
    windows: { plan_id: 'free', period_credits: d('7.5'), period_used: d('0'), outstanding_credits: d('0'), credits_per_usd: null,
      period_started_at: '2026-11-01T00:00:00Z', period_ends_at: '2026-12-01T00:00:00Z' },
    meta: { credit_unit_version: 2, active_credit_unit_version: 2, gateway_price_version: 2, gateway_currency: 'CNY', fx_cny_per_usd: d('6.718'),
      fx_source_url: 'https://example.test/rate', fx_asof_date: '2026-11-04', fx_published_at_utc: '2026-11-04T07:00:00Z' },
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function Probe({ userId }: { userId: string | null }) {
  const state = useSpendingPower(userId ? { id: userId } : null)
  return createElement('pre', null, JSON.stringify(state))
}
let harness: ReturnType<typeof createReactHarness>
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
const state = () => JSON.parse(harness.container.querySelector('pre')!.textContent!)
beforeEach(() => { vi.clearAllMocks(); harness = createReactHarness(); vi.mocked(readCreditV2Account).mockResolvedValue(account()) })
afterEach(() => { harness.cleanup() })

describe('shared v2 account ownership and invalidation', () => {
  it('shares one exact account snapshot across subscribers', async () => {
    await harness.render(createElement('div', null, createElement(Probe, { userId: 'u1' }), createElement(Probe, { userId: 'u1' })))
    await flush()
    expect(readCreditV2Account).toHaveBeenCalledOnce()
    const states = [...harness.container.querySelectorAll('pre')].map(el => JSON.parse(el.textContent!))
    expect(states[0]).toEqual(states[1])
    expect(states[0].power.spendable).toBe('15')
  })
  it('clears a failed pool instead of combining a new balance with cached quota', async () => {
    await harness.render(createElement(Probe, { userId: 'u1' })); await flush()
    vi.mocked(readCreditV2Account).mockResolvedValue({ ...account('9007199254740993.00000001'), windows: null, windowsError: new Error('quota permission denied') })
    await act(async () => { refreshSpendingPower() }); await flush()
    expect(state()).toMatchObject({ balance: '9007199254740993.00000001', windows: null, power: null, windowsError: 'quota permission denied' })
  })
  it('a failed account read drops the whole account and says why, instead of keeping the last balance', async () => {
    await harness.render(createElement(Probe, { userId: 'u1' })); await flush()
    expect(state().balance).toBe('7.5')
    vi.mocked(readCreditV2Account).mockRejectedValue(new Error('permission denied'))
    await act(async () => { refreshSpendingPower() }); await flush()
    expect(state()).toMatchObject({ balance: null, windows: null, membership: null, creditVersion: null, power: null,
      balanceError: 'permission denied', windowsError: 'permission denied' })
  })
  it('starts a fresh request after an unmounted pending subscriber returns with the same user', async () => {
    const pending = deferred<Account>()
    vi.mocked(readCreditV2Account).mockReturnValueOnce(pending.promise)
    await harness.render(createElement(Probe, { userId: 'u1' }))
    await harness.render(null)
    await harness.render(createElement(Probe, { userId: 'u1' })); await flush()
    expect(readCreditV2Account).toHaveBeenCalledTimes(2)
    expect(state().balance).toBe('7.5')
    await act(async () => { pending.resolve(account('999')) }); await flush()
    expect(state().balance).toBe('7.5')
  })
  it('does not accept an old request after account A to B to A', async () => {
    const oldA = deferred<Account>(), oldB = deferred<Account>()
    vi.mocked(readCreditV2Account).mockReturnValueOnce(oldA.promise).mockReturnValueOnce(oldB.promise).mockResolvedValueOnce(account('3'))
    await harness.render(createElement(Probe, { userId: 'a' }))
    await harness.render(createElement(Probe, { userId: 'b' }))
    await harness.render(createElement(Probe, { userId: 'a' })); await flush()
    expect(state().balance).toBe('3')
    await act(async () => { oldA.resolve(account('111')); oldB.resolve(account('222')) }); await flush()
    expect(state().balance).toBe('3')
  })
  it('coalesces invalidations during a request and publishes only the fresh batch', async () => {
    const pending = deferred<Account>()
    vi.mocked(readCreditV2Account).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(account('2'))
    await harness.render(createElement(Probe, { userId: 'u1' }))
    await act(async () => { refreshSpendingPower(); refreshSpendingPower() })
    await act(async () => { pending.resolve(account('111')) }); await flush()
    expect(readCreditV2Account).toHaveBeenCalledTimes(2)
    expect(state().balance).toBe('2')
  })
})

function CreditProbe({ userId }: { userId: string }) {
  return createElement('pre', null, JSON.stringify(useCreditData(userId)))
}
function usage(credits = '0.00000001'): CreditUsageDay[] {
  return [{ day: '2026-11-01', model: 'model', credits: creditDecimal(credits), inputTokens: 1, outputTokens: 2, requests: 1 }]
}
it('does not publish an earlier account usage request after switching accounts', async () => {
  const old = deferred<CreditUsageDay[]>()
  vi.mocked(readCreditV2Account).mockReturnValue(new Promise(() => {}))
  vi.mocked(fetchCreditDays).mockReturnValueOnce(old.promise).mockResolvedValue(usage('2'))
  await harness.render(createElement(CreditProbe, { userId: 'a' }))
  await harness.render(createElement(CreditProbe, { userId: 'b' })); await flush()
  expect(state().credits.value[0].credits).toBe('2')
  await act(async () => { old.resolve(usage('111')) }); await flush()
  expect(state().credits.value[0].credits).toBe('2')
})
it('hides a cached usage total when account metadata changes and waits for the new version', async () => {
  vi.mocked(fetchCreditDays).mockResolvedValue(usage('1'))
  await harness.render(createElement(CreditProbe, { userId: 'u1' })); await flush()
  expect(state().credits.value[0].credits).toBe('1')
  const next = deferred<CreditUsageDay[]>()
  vi.mocked(fetchCreditDays).mockReturnValue(next.promise)
  const value = account(); value.meta.fx_cny_per_usd = creditDecimal('6.7')
  vi.mocked(readCreditV2Account).mockResolvedValue(value)
  await act(async () => { refreshSpendingPower() }); await flush()
  expect(state().credits).toEqual({ status: 'loading' })
  await act(async () => { next.resolve(usage('2')) }); await flush()
  expect(state().credits.value[0].credits).toBe('2')
})
it('keeps an actual usage read failure explicit instead of rendering an empty total', async () => {
  vi.mocked(fetchCreditDays).mockRejectedValue(new Error('RLS denied'))
  await harness.render(createElement(CreditProbe, { userId: 'u1' })); await flush()
  expect(state().credits).toEqual({ status: 'error', error: 'RLS denied' })
})
