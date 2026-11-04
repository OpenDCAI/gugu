import { createClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { createCreditV2Reader } from '../../../../apps/desktop/src/lib/billing/v2/readers'
import { classifyCreditV2Error, createActiveCreditV2Reader, CreditV2StateError } from '../../../../apps/desktop/src/lib/billing/v2/active'
import { deriveSpendingPower, isLowBalance, periodUsdFor } from '@gugu/core/billing'
import { creditRatio } from '../../../../apps/desktop/src/lib/billing/creditGeometry'
import {
  CreditReadContractError, creditMeta, priceState, rpcRows, sameCreditMeta,
} from '../../../../apps/desktop/src/lib/billing/v2/contract'
import {
  addCreditDecimals, compareCreditDecimals, creditDecimal, formatCreditDecimal, subtractCreditDecimals,
} from '../../../../apps/desktop/src/lib/billing/v2/decimal'

const from = '2026-11-01T00:00:00+08:00'
const to = '2026-11-02T00:00:00+08:00'
const meta = {
  credit_unit_version: 2, active_credit_unit_version: 1, gateway_price_version: 1, gateway_currency: 'USD',
  fx_cny_per_usd: null, fx_source_url: null, fx_asof_date: null, fx_published_at_utc: null,
}
const active = {
  ...meta, active_credit_unit_version: 2, gateway_price_version: 2, gateway_currency: 'CNY',
  fx_cny_per_usd: '6.71800000', fx_source_url: 'https://example.test/published-rate',
  fx_asof_date: '2026-11-04', fx_published_at_utc: '2026-11-04T07:00:00+00:00',
}
const membership = {
  ...meta, plan_id: 'free', tier_key: 'free', monthly_price_cny: '0.00000000',
  period_credits: '7.50000000', balance_credits: '9007199254740993.00000001',
  topup_credits_per_cny: '1.00000000', period_hours: 720, subscription_expires_at: null,
}
const quota = {
  ...meta, plan_id: 'free', period_credits: '7.50000000', period_used: '0.00000001',
  outstanding_credits: '0.00000002', credits_per_usd: null, period_started_at: from, period_ends_at: to,
}
const daily = {
  ...meta, day: '2026-11-01', model: null, credits: '0.00000001', inputTokens: 2, outputTokens: 3, requests: 1,
}
const order = {
  ...meta, out_trade_no: 'order-1', order_kind: 'topup', plan_id: null, status: 'paid', period_months: null,
  amount_cny: '29.90000000', credited_credits: '100.00000001', paid_at: from, created_at: from,
  refund_status: null, refund_reason_code: null, original_credit_unit_version: 1,
  original_credited_credits: '30.00000000',
}

function harness(replies: Record<string, unknown>, errorStatus?: number) {
  const calls: { url: URL; headers: Headers; body: unknown }[] = []
  let token = 'first-fixture-user-token'
  const client = createClient('https://database.test.invalid', 'fixture-public-key', {
    accessToken: async () => token,
    global: { fetch: async (input, init) => {
      const url = new URL(String(input))
      calls.push({ url, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : null })
      const data = replies[url.pathname.replace('/rest/v1/', '')]
      if (data === undefined) throw new Error(`Unexpected fixture request ${url.pathname}`)
      return new Response(JSON.stringify(data), {
        status: errorStatus ?? 200, headers: { 'Content-Type': 'application/json', 'Content-Range': '0-0/1' },
      })
    } },
  })
  return { reader: createCreditV2Reader(client, async () => 'current-user'), client, calls, setToken: (value: string) => { token = value } }
}

describe('v2 decimal amounts', () => {
  it.each([
    ['0.00000000', '0'], ['0.00000001', '<0.01'], ['0.00999999', '<0.01'], ['0.01000000', '0.01'],
    ['1.00000000', '1'], ['9007199254740993.01500000', '9,007,199,254,740,993.02'],
    ['-12.34500000', '-12.35'], ['-0.01000000', '-0.01'],
  ])('formats %s exactly at the presentation boundary', (value, expected) => {
    for (const locale of ['en-US', 'zh-CN'] as const) expect(formatCreditDecimal(creditDecimal(value), locale)).toBe(expected)
  })

  it('adds and subtracts eight-decimal amounts without a Number intermediate', () => {
    const large = creditDecimal('9007199254740993.00000001')
    const tiny = creditDecimal('0.00000001')
    expect(addCreditDecimals(large, tiny)).toBe('9007199254740993.00000002')
    expect(subtractCreditDecimals(large, tiny)).toBe('9007199254740993')
    expect(compareCreditDecimals(large, creditDecimal('9007199254740993'))).toBe(1)
    expect(compareCreditDecimals(creditDecimal('-1'), tiny)).toBe(-1)
    expect(compareCreditDecimals(tiny, tiny)).toBe(0)
  })

  it.each([null, undefined, 1, NaN, Infinity, '', ' ', '1e3', 'NaN', 'Infinity', '1.000000001', '10000000000000000000000'])('rejects a non-contract amount %s', (value) => {
    expect(() => creditDecimal(value)).toThrow()
  })
})

describe('v2 activation metadata', () => {
  it('keeps an installed but inactive v2 projection distinct from active pricing', () => {
    expect(priceState(creditMeta(meta))).toBe('v2-projection-v1-pricing')
    expect(priceState(creditMeta(active))).toBe('v2-active')
    expect(creditMeta(active).fx_published_at_utc).toBe('2026-11-04T07:00:00+00:00')
  })

  it.each([
    { ...meta, active_credit_unit_version: undefined }, { ...meta, fx_source_url: undefined },
    { ...meta, gateway_price_version: 2 }, { ...meta, gateway_currency: 'CNY' },
    { ...meta, credit_unit_version: 1 }, { ...meta, fx_cny_per_usd: 6.718 },
  ])('rejects missing or inconsistent metadata rather than synthesizing zero', (row) => {
    expect(() => creditMeta(row)).toThrow(CreditReadContractError)
  })

  it('does not infer activation from an empty result or accept a non-array RPC response', () => {
    expect(rpcRows([], () => 'unused')).toEqual({ rows: [], meta: null })
    expect(() => rpcRows({ data: [] }, () => 'unused')).toThrow(CreditReadContractError)
  })

  it('rejects metadata conflicts within rows and between independently fetched/cached reads', () => {
    expect(() => rpcRows([meta, active], () => 'row')).toThrow(CreditReadContractError)
    expect(() => sameCreditMeta([rpcRows([meta], () => 'a'), rpcRows([active], () => 'b')])).toThrow(CreditReadContractError)
    expect(sameCreditMeta([rpcRows([], () => 'empty'), rpcRows([meta], () => 'row')])).toEqual(creditMeta(meta))
  })
})

describe('exact downstream credit derivation', () => {
  it('keeps tiny held amounts and large balances exact through both pools', () => {
    const power = deriveSpendingPower(creditDecimal('9007199254740993.00000001'), {
      plan_id: 'free', period_credits: creditDecimal('7.5'), period_used: creditDecimal('0.00000001'),
      outstanding_credits: creditDecimal('0.00000002'), credits_per_usd: creditDecimal('3.33333333'),
      period_started_at: from, period_ends_at: to,
    })
    expect(power.periodCredits).toBe('7.49999999')
    expect(power.period.remaining).toBe('7.49999997')
    expect(power.spendable).toBe('9007199254741000.49999998')
    expect(power.held).toBe('0.00000002')
    expect(power.blockedBy).toBeNull()
  })

  it('uses the unchanged threshold on exact values and never reinterprets the v2 compatibility scale as USD', () => {
    expect(isLowBalance(creditDecimal('0.99999999'))).toBe(true)
    expect(isLowBalance(creditDecimal('1'))).toBe(false)
    expect(isLowBalance(creditDecimal('0'))).toBe(false)
    expect(periodUsdFor({ period_credits: creditDecimal('7.5'), credits_per_usd: creditDecimal('3.33333333') })).toBeNull()
  })

  it('normalizes only drawing geometry, keeping exact source values separate', () => {
    expect(creditRatio(creditDecimal('2.25'), creditDecimal('7.5'))).toBe(0.3)
    expect(creditRatio(creditDecimal('100'), creditDecimal('7.5'))).toBe(1)
    expect(creditRatio(creditDecimal('-1'), creditDecimal('7.5'))).toBe(0)
    expect(creditRatio(creditDecimal('1'), creditDecimal('0'))).toBe(0)
  })
})

describe('actual PostgREST request builders', () => {
  it('uses all four v2 RPC names, exact arguments, the billing profile and the current coordinated user token', async () => {
    const h = harness({ 'rpc/current_membership_v2': [membership], 'rpc/current_quota_windows_v2': [quota],
      'rpc/my_daily_credit_usage_v2': [daily], 'rpc/my_orders_v2': [order] })
    const m = await h.reader.membership()
    h.setToken('second-fixture-user-token')
    const q = await h.reader.quota()
    const d = await h.reader.dailyUsage({ from, to, timeZone: 'Asia/Shanghai' })
    const o = await h.reader.orders(25)
    expect(m.rows[0].balanceCredits).toBe('9007199254740993.00000001')
    expect(q.rows[0].periodCredits).toBe('7.5')
    expect(q.rows[0].creditsPerUsd).toBeNull()
    expect(d.rows[0].credits).toBe('0.00000001')
    expect(o.rows[0]).toMatchObject({ amountCny: '29.9', creditedCredits: '100.00000001', originalCreditUnitVersion: 1, originalCreditedCredits: '30' })
    expect(h.calls.map((call) => call.body)).toEqual([{}, {}, { p_from: from, p_to: to, p_tz: 'Asia/Shanghai' }, { p_limit: 25 }])
    for (const call of h.calls) {
      expect(call.headers.get('x-gugu-credit-unit-version')).toBe('2')
      expect(call.headers.get('Content-Profile')).toBe('billing')
      expect(call.headers.get('apikey')).toBe('fixture-public-key')
      expect(call.body).not.toHaveProperty('user_id')
    }
    expect(h.calls[0].headers.get('Authorization')).toBe('Bearer first-fixture-user-token')
    expect(h.calls[1].headers.get('Authorization')).toBe('Bearer second-fixture-user-token')
  })

  it('versions all three table reads, keeps numeric fields as presentation numbers and does not leak the header to unrelated reads', async () => {
    const h = harness({
      user_credits: { balance_credits: 0.001, credit_unit_version: 2 },
      referral_rewards: [{ id: 1, credits_each: 0.01, credit_unit_version: 2 }],
      usage_events: [{ id: 'event-1', model: 'model', agent_user_id: null, credits_charged: 0.0001,
        input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_creation_tokens: 4, created_at: from, credit_unit_version: 2 }],
      unrelated: [],
    })
    expect(await h.reader.balance()).toBe(0.001)
    expect(await h.reader.referralRewards()).toEqual([{ id: 1, creditsEach: 0.01 }])
    const ledger = await h.reader.ledger({ page: 2, pageSize: 10, from, to, model: 'a%_\\b' })
    expect(ledger.rows[0].creditsCharged).toBe(0.0001)
    expect(ledger.total).toBe(1)
    expect(h.calls[1].url.searchParams.get('referrer_user_id')).toBe('eq.current-user')
    expect(h.calls[2].url.searchParams.get('order')).toBe('created_at.desc,id.desc')
    expect(h.calls[2].url.searchParams.get('offset')).toBe('10')
    expect(h.calls[2].url.searchParams.get('limit')).toBe('10')
    expect(h.calls[2].url.searchParams.get('model')).toBe('ilike.%a\\%\\_\\\\b%')
    expect(h.calls[2].url.searchParams.getAll('created_at')).toEqual([`gte.${from}`, `lt.${to}`])
    for (const call of h.calls) {
      expect(call.headers.get('x-gugu-credit-unit-version')).toBe('2')
      expect(call.headers.get('Accept-Profile')).toBe('billing')
    }
    await h.client.from('unrelated').select('*')
    expect(h.calls.at(-1)?.headers.has('x-gugu-credit-unit-version')).toBe(false)
  })

  it.each(['period_credits', 'period_used', 'outstanding_credits'])('rejects null required quota amount %s', async (field) => {
    const h = harness({ 'rpc/current_quota_windows_v2': [{ ...quota, [field]: null }] })
    await expect(h.reader.quota()).rejects.toBeInstanceOf(CreditReadContractError)
  })

  it('does not silently parse a numeric RPC amount or accept a v1 table row', async () => {
    const h = harness({ 'rpc/current_membership_v2': [{ ...membership, period_credits: 7.5 }], user_credits: { balance_credits: 1, credit_unit_version: 1 } })
    await expect(h.reader.membership()).rejects.toBeInstanceOf(CreditReadContractError)
    await expect(h.reader.balance()).rejects.toBeInstanceOf(CreditReadContractError)
  })

  it('preserves missing RPC/auth/permission errors; it does not automatically fall back per read', async () => {
    const h = harness({ 'rpc/current_membership_v2': { code: 'PGRST202', message: 'RPC not installed' } }, 404)
    await expect(h.reader.membership()).rejects.toMatchObject({ cause: { code: 'PGRST202' } })
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].url.pathname).toBe('/rest/v1/rpc/current_membership_v2')
  })

  it('keeps empty membership and quota results explicit, without inventing metadata or zero balances', async () => {
    const h = harness({ 'rpc/current_membership_v2': [], 'rpc/current_quota_windows_v2': [], user_credits: null })
    expect(await h.reader.membership()).toEqual({ rows: [], meta: null })
    expect(await h.reader.quota()).toEqual({ rows: [], meta: null })
    expect(await h.reader.balance()).toBeNull()
  })
})

describe('no-fallback active v2 reads', () => {
  it('reports installed-but-inactive pricing instead of serving the projected balance or reading v1', async () => {
    const h = harness({ 'rpc/current_membership_v2': [membership] })
    const activeReader = createActiveCreditV2Reader(h.reader, async () => 'current-user')
    await expect(activeReader.rows(() => h.reader.membership())).rejects.toMatchObject({ state: 'not-active' })
    expect(h.calls).toHaveLength(1)
  })

  it('publishes exact balance and quota only as one consistent account tuple', async () => {
    const h = harness({ 'rpc/current_membership_v2': [{ ...membership, ...active }], 'rpc/current_quota_windows_v2': [{ ...quota, ...active }] })
    const result = await createActiveCreditV2Reader(h.reader, async () => 'current-user').account()
    expect(result.balance).toBe('9007199254740993.00000001')
    expect(result.windows.period_credits).toBe('7.5')
    expect(result.meta.active_credit_unit_version).toBe(2)
    expect(h.calls).toHaveLength(2)
  })

  it('rejects account rows across different price versions', async () => {
    const h = harness({ 'rpc/current_membership_v2': [{ ...membership, ...active }], 'rpc/current_quota_windows_v2': [quota] })
    await expect(createActiveCreditV2Reader(h.reader, async () => 'current-user').account()).rejects.toBeInstanceOf(CreditReadContractError)
  })

  it('does not turn empty RPCs or an empty pricing probe into active zero', async () => {
    const h = harness({ 'rpc/current_membership_v2': [], 'rpc/public_pricing_v2': [] })
    await expect(createActiveCreditV2Reader(h.reader, async () => 'current-user').rows(() => h.reader.membership())).rejects.toMatchObject({ state: 'unknown' })
  })

  it('discards a result if the signed-in account changed while it was in flight', async () => {
    const h = harness({ 'rpc/current_membership_v2': [{ ...membership, ...active }] })
    let user = 'first'
    const activeReader = createActiveCreditV2Reader(h.reader, async () => user)
    await expect(activeReader.rows(async () => {
      user = 'second'
      return h.reader.membership()
    })).rejects.toMatchObject({ state: 'account-changed' })
  })

  it('rejects a table batch when the version tuple changed around it', async () => {
    const replies = { 'rpc/public_pricing_v2': [active] }
    const h = harness(replies)
    await expect(createActiveCreditV2Reader(h.reader, async () => 'current-user').table(async () => {
      replies['rpc/public_pricing_v2'] = [{ ...active, fx_cny_per_usd: '6.70000000' }]
      return 123
    })).rejects.toBeInstanceOf(CreditReadContractError)
  })

  it('classifies only a missing v2 RPC or invalid contract, preserving permission and transport errors', () => {
    expect(classifyCreditV2Error(new Error('missing', { cause: { code: 'PGRST202' } }))).toMatchObject({ state: 'not-installed' })
    expect(classifyCreditV2Error(new CreditReadContractError('field'))).toMatchObject({ state: 'inconsistent' })
    for (const error of [new Error('permission', { cause: { code: '42501' } }), new Error('Failed to fetch')]) {
      expect(classifyCreditV2Error(error)).toBe(error)
    }
    const pending = new CreditV2StateError('not-active')
    expect(classifyCreditV2Error(pending)).toBe(pending)
  })
})
