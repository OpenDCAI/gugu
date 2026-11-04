// 用量页的云端读写(product spec)。表与函数定义在 gugu-supabase:
//   public.usage_daily            一台设备一天一引擎一行(本机汇总后 upsert,RLS 只见自己)
//   public.my_usage_daily()       跨设备合并后的 UsageDay[](一次返回一个 jsonb,绕开 PostgREST 的行数上限)
//   public.my_usage_devices()     有用量记录的设备
//   billing.my_daily_credit_usage() 积分按天×模型
import type { CreditUsageDay, UsageDay } from '@gugu/core/shared/usage/dailyUsage'
import type { UsageDailyRow } from './rows'
import { replaceUsageDeviceRows } from '@gugu/core/cloud/usageDaily'
import { dataClient } from '../supabase'
import { activeCreditV2, creditV2, creditV2Read } from '../billing/v2/runtime'
import { CreditReadContractError } from '../billing/v2/contract'
import type { UsageActivityRow } from '../billing/usage'
import type { DayRange } from './derive'

function fail(error: { message: string } | null): never {
  throw new Error(error?.message ?? 'unknown error')
}

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function toUsageDay(raw: Record<string, unknown>): UsageDay {
  const hours = Array.isArray(raw.hours) ? raw.hours.map(num) : []
  const modelMap = (value: unknown): Record<string, number> => {
    const out: Record<string, number> = {}
    if (value && typeof value === 'object') {
      for (const [model, tokens] of Object.entries(value as Record<string, unknown>)) out[model] = num(tokens)
    }
    return out
  }
  return {
    day: String(raw.day),
    engine: String(raw.engine),
    sessions: num(raw.sessions),
    runSeconds: num(raw.runSeconds),
    inputTokens: num(raw.inputTokens),
    outputTokens: num(raw.outputTokens),
    cacheReadTokens: num(raw.cacheReadTokens),
    cacheWriteTokens: num(raw.cacheWriteTokens),
    models: modelMap(raw.models),
    guguModels: modelMap(raw.guguModels),
    byokModels: modelMap(raw.byokModels),
    hours: Array.from({ length: 24 }, (_, i) => hours[i] ?? 0),
    parallelSeconds: num(raw.parallelSeconds),
    peakConcurrency: num(raw.peakConcurrency),
  }
}

export async function fetchUsageDays(from: string, to: string, deviceId: string | null): Promise<UsageDay[]> {
  const { data, error } = await dataClient.rpc('my_usage_daily', { p_from: from, p_to: to, p_device_id: deviceId })
  if (error) fail(error)
  return (Array.isArray(data) ? data : []).map((row) => toUsageDay(row as Record<string, unknown>))
}

export type UsageDevice = { deviceId: string; firstDay: string; lastDay: string }

export async function fetchUsageDevices(): Promise<UsageDevice[]> {
  const { data, error } = await dataClient.rpc('my_usage_devices')
  if (error) fail(error)
  return (Array.isArray(data) ? data : []).map((raw) => {
    const row = raw as Record<string, unknown>
    return { deviceId: String(row.deviceId), firstDay: String(row.firstDay), lastDay: String(row.lastDay) }
  })
}

/** 积分按「用户本地日」归天:把时区交给库去切,免得客户端拿 UTC 行自己拼。 */
export async function fetchCreditDays(from: string, to: string, timeZone: string): Promise<CreditUsageDay[]> {
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  const { rows } = await creditV2Read(() => activeCreditV2.rows(() => creditV2.dailyUsage({
    from: new Date(fy, fm - 1, fd).toISOString(),
    to: new Date(ty, tm - 1, td + 1).toISOString(), timeZone,
  })))
  return rows
}

/** 使用日志的一行:网关记的输入 / 输出之外,再带缓存读 / 写(gugu#6660)。扣费按四者算,只看输入对不上。 */
export type LedgerRow = UsageActivityRow & { cache_read_tokens: number; cache_creation_tokens: number }

/**
 * 积分明细,按页取(页码 + 每页行数 + 精确总数)。
 * 模型名称是包含匹配,大小写不敏感。
 */
export async function fetchLedgerPage(options: { page: number; pageSize: number; model: string | null; range: Pick<DayRange, 'from' | 'to'> }): Promise<{ rows: LedgerRow[]; total: number }> {
  return creditV2Read(async () => {
    const [fy, fm, fd] = options.range.from.split('-').map(Number)
    const [ty, tm, td] = options.range.to.split('-').map(Number)
    const result = await activeCreditV2.table(() => creditV2.ledger({
      page: options.page, pageSize: options.pageSize, model: options.model,
      from: new Date(fy, fm - 1, fd).toISOString(), to: new Date(ty, tm - 1, td + 1).toISOString(),
    }))
    if (result.total === null) throw new CreditReadContractError('exact ledger count')
    return {
      total: result.total,
      rows: result.rows.map((row) => ({
        id: row.id, model: row.model, agent_user_id: row.agentUserId, credits_charged: row.creditsCharged,
        input_tokens: row.inputTokens, output_tokens: row.outputTokens, cache_read_tokens: row.cacheReadTokens,
        cache_creation_tokens: row.cacheCreationTokens, created_at: row.createdAt,
      })),
    }
  })
}

// ── 写:本机汇总 → 云端这台设备的那几行 ──

export function replaceDeviceRows(rows: UsageDailyRow[], deviceId: string, from: string, to: string): Promise<void> {
  return replaceUsageDeviceRows(dataClient, rows, deviceId, from, to)
}
