import { beforeEach, expect, it, vi } from 'vitest'

const control = vi.hoisted(() => ({ error: null as string | null, membership: [] as Record<string, unknown>[], calls: [] as { url: string; body: unknown; headers: Headers }[] }))
vi.mock('../../../../apps/desktop/src/lib/supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js')
  return {
    getCurrentAuthUserId: async () => 'ledger-user',
    dataClient: createClient('https://database.test.invalid', 'fixture-key', {
      accessToken: async () => 'fixture-user-token',
      global: { fetch: async (input, init) => {
        const url = String(input)
        control.calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init?.headers) })
        if (url.includes('/usage_events') && control.error) return new Response(JSON.stringify({ message: control.error, code: '42501' }), { status: 403 })
        const data = url.includes('/public_pricing_v2') ? [{
          credit_unit_version: 2, active_credit_unit_version: 2, gateway_price_version: 2, gateway_currency: 'CNY',
          fx_cny_per_usd: '6.71800000', fx_source_url: 'https://example.test/rate', fx_asof_date: '2026-11-04', fx_published_at_utc: '2026-11-04T07:00:00Z',
        }] : url.includes('/current_membership_v2') ? control.membership : []
        return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Range': '*/0' } })
      } },
    }),
  }
})
import { getMembership } from '../../../../apps/desktop/src/lib/billing/membership'
import { fetchCreditDays, fetchLedgerPage } from '../../../../apps/desktop/src/lib/usage/cloud'

beforeEach(() => { control.calls.length = 0; control.error = null; control.membership = [] })
const options = { page: 2, pageSize: 20, model: null, range: { from: '2026-10-01', to: '2026-10-30' } }
const ledgerCall = () => new URL(control.calls.find(call => new URL(call.url).pathname.endsWith('/usage_events'))!.url)

it('明细按用户本地日起止筛选，并保留分页', async () => {
  await fetchLedgerPage(options)
  expect(ledgerCall().searchParams.getAll('created_at')).toEqual([`gte.${new Date(2026, 9, 1).toISOString()}`, `lt.${new Date(2026, 9, 31).toISOString()}`])
  expect(ledgerCall().searchParams.get('offset')).toBe('20')
  expect(ledgerCall().searchParams.get('limit')).toBe('20')
  for (const call of control.calls) expect(call.headers.get('x-gugu-credit-unit-version')).toBe('2')
})
it('模型筛选仍按字面量转义百分号和下划线', async () => {
  await fetchLedgerPage({ ...options, model: 'a%_b' })
  expect(ledgerCall().searchParams.get('model')).toBe('ilike.%a\\%\\_b%')
})
it('明细失败仍抛出原错误，不冒充空记录', async () => {
  control.error = 'ledger offline'
  await expect(fetchLedgerPage(options)).rejects.toThrow('ledger offline')
})
it('积分汇总使用同一组本地日边界，仍然没有设备参数', async () => {
  await fetchCreditDays(options.range.from, options.range.to, 'Asia/Shanghai')
  const call = control.calls.find(call => call.url.endsWith('/rpc/my_daily_credit_usage_v2'))!
  expect(call.body).toEqual({ p_from: new Date(2026, 9, 1).toISOString(), p_to: new Date(2026, 9, 31).toISOString(), p_tz: 'Asia/Shanghai' })
  expect(control.calls.every(call => !new URL(call.url).pathname.endsWith('/my_daily_credit_usage'))).toBe(true)
})

it('keeps an authenticated empty membership unknown after confirming active pricing', async () => {
  await expect(getMembership()).rejects.toMatchObject({ cause: { state: 'unknown' } })
  expect(control.calls.map(call => new URL(call.url).pathname)).toEqual([
    '/rest/v1/rpc/current_membership_v2', '/rest/v1/rpc/public_pricing_v2',
  ])
})
it('still returns a confirmed free membership instead of confusing free with a missing row', async () => {
  control.membership = [{ plan_id: 'default', tier_key: 'free', monthly_price_cny: '0.00000000', period_credits: '7.50000000',
    balance_credits: '37.00000001', topup_credits_per_cny: '1.00000000', period_hours: 720, subscription_expires_at: null,
    credit_unit_version: 2, active_credit_unit_version: 2, gateway_price_version: 2, gateway_currency: 'CNY',
    fx_cny_per_usd: '6.71800000', fx_source_url: 'https://example.test/rate', fx_asof_date: '2026-11-04', fx_published_at_utc: '2026-11-04T07:00:00Z' }]
  await expect(getMembership()).resolves.toMatchObject({ tier: 'free', balanceCredits: '37.00000001', periodCredits: '7.5' })
  expect(control.calls).toHaveLength(1)
})
