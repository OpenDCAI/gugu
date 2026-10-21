// 用量页的云端读写(product spec)。表与函数定义在 gugu-supabase:
//   public.usage_daily            一台设备一天一引擎一行(本机汇总后 upsert,RLS 只见自己)
//   public.my_usage_daily()       跨设备合并后的 UsageDay[](一次返回一个 jsonb,绕开 PostgREST 的行数上限)
//   public.my_usage_devices()     有用量记录的设备
//   billing.my_daily_credit_usage() 积分按天×模型
import type { CreditUsageDay, UsageDay } from '@gugu/core/shared/usage/dailyUsage'
import type { UsageDailyRow } from './rows'
import { dataClient } from '../supabase'
import type { UsageActivityRow } from '../billing/usage'

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
  const { data, error } = await dataClient.schema('billing').rpc('my_daily_credit_usage', {
    p_from: new Date(fy, fm - 1, fd).toISOString(),
    p_to: new Date(ty, tm - 1, td + 1).toISOString(),
    p_tz: timeZone,
  })
  if (error) fail(error)
  return (Array.isArray(data) ? data : []).map((raw) => {
    const row = raw as Record<string, unknown>
    return {
      day: String(row.day),
      model: row.model == null ? null : String(row.model),
      credits: num(row.credits),
      inputTokens: num(row.inputTokens),
      outputTokens: num(row.outputTokens),
      requests: num(row.requests),
    }
  })
}

/** 使用日志的一行:网关记的输入 / 输出之外,再带缓存读 / 写(gugu#6660)。扣费按四者算,只看输入对不上。 */
export type LedgerRow = UsageActivityRow & { cache_read_tokens: number; cache_creation_tokens: number }

/**
 * 积分明细,按页取(页码 + 每页行数 + 精确总数)。
 * 模型名称是包含匹配,大小写不敏感。
 */
export async function fetchLedgerPage(options: { page: number; pageSize: number; model: string | null }): Promise<{ rows: LedgerRow[]; total: number }> {
  const from = (options.page - 1) * options.pageSize
  let query = dataClient
    .schema('billing')
    .from('usage_events')
    .select('id, model, agent_user_id, credits_charged, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(from, from + options.pageSize - 1)
  const model = options.model?.trim()
  if (model) query = query.ilike('model', `%${model.replace(/[%_\\]/g, (c) => `\\${c}`)}%`)
  const { data, error, count } = await query
  if (error) fail(error)
  const rows = (data ?? []).map((row) => ({
    ...row,
    credits_charged: num(row.credits_charged),
    input_tokens: num(row.input_tokens),
    output_tokens: num(row.output_tokens),
    cache_read_tokens: num(row.cache_read_tokens),
    cache_creation_tokens: num(row.cache_creation_tokens),
  })) as LedgerRow[]
  return { rows, total: count ?? rows.length }
}

// ── 写:本机汇总 → 云端这台设备的那几行 ──

const UPSERT_CHUNK = 500
const READ_PAGE = 500

/**
 * 把这台设备 [from, to] 这段的云端行替换成本机这一次算出来的样子:先 upsert,再删掉这段里
 * 本机已经没有的 (day, engine) —— 否则某天的数据被重算成 0 后,云端会永远留着旧数字。
 */
export async function replaceDeviceRows(rows: UsageDailyRow[], deviceId: string, from: string, to: string): Promise<void> {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const { error } = await dataClient
      .from('usage_daily')
      .upsert(rows.slice(i, i + UPSERT_CHUNK), { onConflict: 'user_id,device_id,day,engine' })
    if (error) fail(error)
  }
  const keep = new Set(rows.map((r) => `${r.day}|${r.engine}`))
  // 分页取:PostgREST 每次最多回 max-rows 行,首次同步 400 天 × 几家引擎会超过它;一次取完会静默截断,
  // 截掉的那部分陈旧行就永远删不掉。
  const existing: { day: string; engine: string }[] = []
  for (let offset = 0; ; offset += READ_PAGE) {
    const { data, error } = await dataClient
      .from('usage_daily')
      .select('day, engine')
      .eq('device_id', deviceId)
      .gte('day', from)
      .lte('day', to)
      .order('day')
      .order('engine')
      .range(offset, offset + READ_PAGE - 1)
    if (error) fail(error)
    existing.push(...(data ?? []))
    if (!data || data.length < READ_PAGE) break
  }
  const stale = existing.filter((r) => !keep.has(`${r.day}|${r.engine}`))
  for (const r of stale) {
    const { error: delError } = await dataClient
      .from('usage_daily')
      .delete()
      .eq('device_id', deviceId)
      .eq('day', r.day)
      .eq('engine', r.engine)
    if (delError) fail(delError)
  }
}
