import type { SupabaseClient } from '@supabase/supabase-js'
import type { CreditDecimal } from './decimal'
import {
  CreditReadContractError, count, decimal, instant, nullableText, record,
  rpcRows, tableAmount, text, type CreditRead,
} from './contract'

const VERSION_HEADER = 'x-gugu-credit-unit-version'

export interface MembershipV2 {
  planId: string
  tierKey: string
  monthlyPriceCny: CreditDecimal
  periodCredits: CreditDecimal
  balanceCredits: CreditDecimal
  topupCreditsPerCny: CreditDecimal
  periodHours: number
  expiresAt: string | null
}

export interface QuotaWindowsV2 {
  planId: string
  periodCredits: CreditDecimal
  periodUsed: CreditDecimal
  outstandingCredits: CreditDecimal
  creditsPerUsd: CreditDecimal | null
  startedAt: string
  endsAt: string
}

export interface CreditUsageDayV2 {
  day: string
  model: string | null
  credits: CreditDecimal
  inputTokens: number
  outputTokens: number
  requests: number
}

export interface OrderV2 {
  tradeNumber: string
  kind: string
  planId: string | null
  status: string
  periodMonths: number | null
  amountCny: CreditDecimal
  creditedCredits: CreditDecimal
  paidAt: string | null
  createdAt: string
  refundStatus: string | null
  refundReason: string | null
  originalCreditUnitVersion: 1 | 2
  originalCreditedCredits: CreditDecimal
}

function throwReadError(error: { message: string; code?: string } | null): void {
  if (error) throw new Error(error.message, { cause: error })
}

function array(data: unknown): Record<string, unknown>[] {
  if (!Array.isArray(data)) throw new CreditReadContractError('table rows')
  return data.map(record)
}

function single<T>(read: CreditRead<T>): CreditRead<T> {
  if (read.rows.length > 1) throw new CreditReadContractError('singleton RPC')
  return read
}

/**
 * Opt-in transport only. The production v1 callers remain in place until the rollout/fallback
 * policy is chosen. All requests reuse the caller's coordinated user token; the version header
 * belongs to this request builder, never the shared Supabase client.
 */
export function createCreditV2Reader(client: Pick<SupabaseClient, 'schema'>, currentUserId: () => Promise<string>) {
  return {
    async pricingMetadata(): Promise<CreditRead<null>> {
      const { data, error } = await client.schema('public').rpc('public_pricing_v2').setHeader(VERSION_HEADER, '2')
      throwReadError(error)
      return rpcRows(data, () => null)
    },

    async balance(): Promise<number | null> {
      const { data, error } = await client.schema('billing').from('user_credits')
        .select('balance_credits,credit_unit_version').setHeader(VERSION_HEADER, '2').maybeSingle()
      throwReadError(error)
      return data === null ? null : tableAmount(record(data), 'balance_credits')
    },

    /** Return rows, not a binary-float accounting sum of rewards. */
    async referralRewards(): Promise<{ id: number; creditsEach: number }[]> {
      const uid = text(await currentUserId(), 'current user')
      const { data, error } = await client.schema('billing').from('referral_rewards')
        .select('id,credits_each,credit_unit_version').eq('referrer_user_id', uid).setHeader(VERSION_HEADER, '2')
      throwReadError(error)
      return array(data).map((row) => ({ id: count(row.id, 'id'), creditsEach: tableAmount(row, 'credits_each') }))
    },

    async ledger(options: { page: number; pageSize: number; from: string; to: string; model: string | null }) {
      const page = count(options.page, 'page'), pageSize = count(options.pageSize, 'pageSize')
      if (page === 0 || pageSize === 0) throw new CreditReadContractError('pagination')
      const offset = (page - 1) * pageSize
      if (!Number.isSafeInteger(offset + pageSize)) throw new CreditReadContractError('pagination')
      let query = client.schema('billing').from('usage_events')
        .select('id,model,agent_user_id,credits_charged,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,created_at,credit_unit_version', { count: 'exact' })
        .setHeader(VERSION_HEADER, '2')
        .gte('created_at', instant(options.from, 'from')).lt('created_at', instant(options.to, 'to'))
        .order('created_at', { ascending: false }).order('id', { ascending: false })
        .range(offset, offset + pageSize - 1)
      const model = options.model?.trim()
      if (model) query = query.ilike('model', `%${model.replace(/[%_\\]/g, (c) => `\\${c}`)}%`)
      const { data, error, count: total } = await query
      throwReadError(error)
      return {
        rows: array(data).map((row) => ({
          id: text(row.id, 'id'), model: nullableText(row.model, 'model'),
          agentUserId: nullableText(row.agent_user_id, 'agent_user_id'),
          creditsCharged: tableAmount(row, 'credits_charged'),
          inputTokens: count(row.input_tokens, 'input_tokens'), outputTokens: count(row.output_tokens, 'output_tokens'),
          cacheReadTokens: count(row.cache_read_tokens, 'cache_read_tokens'),
          cacheCreationTokens: count(row.cache_creation_tokens, 'cache_creation_tokens'),
          createdAt: instant(row.created_at, 'created_at'),
        })),
        total: total === null ? null : count(total, 'total'),
      }
    },

    async membership(): Promise<CreditRead<MembershipV2>> {
      const { data, error } = await client.schema('billing').rpc('current_membership_v2').setHeader(VERSION_HEADER, '2')
      throwReadError(error)
      return single(rpcRows(data, (row) => ({
        planId: text(row.plan_id, 'plan_id'), tierKey: text(row.tier_key, 'tier_key'),
        monthlyPriceCny: decimal(row.monthly_price_cny, 'monthly_price_cny'),
        periodCredits: decimal(row.period_credits, 'period_credits'), balanceCredits: decimal(row.balance_credits, 'balance_credits'),
        topupCreditsPerCny: decimal(row.topup_credits_per_cny, 'topup_credits_per_cny'),
        periodHours: count(row.period_hours, 'period_hours'),
        expiresAt: row.subscription_expires_at === null ? null : instant(row.subscription_expires_at, 'subscription_expires_at'),
      })))
    },

    async quota(): Promise<CreditRead<QuotaWindowsV2>> {
      const { data, error } = await client.schema('billing').rpc('current_quota_windows_v2').setHeader(VERSION_HEADER, '2')
      throwReadError(error)
      return single(rpcRows(data, (row) => ({
        planId: text(row.plan_id, 'plan_id'), periodCredits: decimal(row.period_credits, 'period_credits'),
        periodUsed: decimal(row.period_used, 'period_used'), outstandingCredits: decimal(row.outstanding_credits, 'outstanding_credits'),
        creditsPerUsd: row.credits_per_usd === null ? null : decimal(row.credits_per_usd, 'credits_per_usd'),
        startedAt: instant(row.period_started_at, 'period_started_at'), endsAt: instant(row.period_ends_at, 'period_ends_at'),
      })))
    },

    async dailyUsage(options: { from: string; to: string; timeZone: string }): Promise<CreditRead<CreditUsageDayV2>> {
      const from = instant(options.from, 'from'), to = instant(options.to, 'to')
      if (Date.parse(from) >= Date.parse(to)) throw new CreditReadContractError('date range')
      try { new Intl.DateTimeFormat('en-US', { timeZone: options.timeZone }).format() }
      catch { throw new CreditReadContractError('timeZone') }
      const { data, error } = await client.schema('billing').rpc('my_daily_credit_usage_v2', {
        p_from: from, p_to: to, p_tz: options.timeZone,
      }).setHeader(VERSION_HEADER, '2')
      throwReadError(error)
      return rpcRows(data, (row) => ({
        day: text(row.day, 'day'), model: nullableText(row.model, 'model'), credits: decimal(row.credits, 'credits'),
        inputTokens: count(row.inputTokens, 'inputTokens'), outputTokens: count(row.outputTokens, 'outputTokens'),
        requests: count(row.requests, 'requests'),
      }))
    },

    async orders(limit = 50): Promise<CreditRead<OrderV2>> {
      if (!Number.isSafeInteger(limit)) throw new CreditReadContractError('limit')
      const { data, error } = await client.schema('billing').rpc('my_orders_v2', { p_limit: limit }).setHeader(VERSION_HEADER, '2')
      throwReadError(error)
      return rpcRows(data, (row) => {
        if (row.original_credit_unit_version !== 1 && row.original_credit_unit_version !== 2) {
          throw new CreditReadContractError('original_credit_unit_version')
        }
        return {
          tradeNumber: text(row.out_trade_no, 'out_trade_no'), kind: text(row.order_kind, 'order_kind'),
          planId: nullableText(row.plan_id, 'plan_id'), status: text(row.status, 'status'),
          periodMonths: row.period_months === null ? null : count(row.period_months, 'period_months'),
          amountCny: decimal(row.amount_cny, 'amount_cny'), creditedCredits: decimal(row.credited_credits, 'credited_credits'),
          paidAt: row.paid_at === null ? null : instant(row.paid_at, 'paid_at'), createdAt: instant(row.created_at, 'created_at'),
          refundStatus: nullableText(row.refund_status, 'refund_status'), refundReason: nullableText(row.refund_reason_code, 'refund_reason_code'),
          originalCreditUnitVersion: row.original_credit_unit_version,
          originalCreditedCredits: decimal(row.original_credited_credits, 'original_credited_credits'),
        }
      })
    },
  }
}
