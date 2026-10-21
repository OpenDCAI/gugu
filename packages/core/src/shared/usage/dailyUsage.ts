/**
 * 用量页(product spec)的数据契约 —— 本机汇总、云端汇总表、用量页三方共用这一份形状。
 *
 * 数据流:本机(electron 主进程)从本地库与各家 CLI 的日志按「天 × 引擎」汇总成 {@link LocalUsageSnapshot}
 * → 渲染层按行 upsert 进云端 `public.usage_daily`(一台设备一份)→ 用量页读云端
 * `public.my_usage_daily` 把所有设备(或筛选的那一台)合成 {@link UsageDay}[]。
 * 手机没有本地库,只读不写。
 *
 * 「天」是**产生数据那台设备的本地日历日**(YYYY-MM-DD)。不同时区的两台设备同一个 UTC 时刻
 * 可能落在不同的天 —— 这是有意的:用户说的「那天」是他当时手表上的那天。
 */

/** 本机一天里某一家引擎的量。 */
export type EngineDailyUsage = {
  /** 设备本地日历日 YYYY-MM-DD。 */
  day: string
  /** 引擎 id,与本地 `conversations.provider` 相同(claude / codex / opencode …)。 */
  engine: string
  /** 这一天新开的会话数(按会话创建时刻归天)。 */
  sessions: number
  /** 这一天里这家引擎的会话处于「在干活」的总秒数(多个会话叠加,不去重)。 */
  runSeconds: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** 模型 id → 这一天在这个模型上的 token 总数(四类相加)。 */
  models: Record<string, number>
  /**
   * {@link models} 里走咕咕自营模型(扣积分)的那部分,同样按模型。
   * 来源按会话在那一刻的计费路判定;判定不了的只算进 models,两边都不进(用量页写「未区分」)。
   */
  guguModels: Record<string, number>
  /** {@link models} 里走用户自己账号(订阅 / 自己的 key,即 BYOK)的那部分。 */
  byokModels: Record<string, number>
  /** 长度恒为 24:这一天每个本地钟点新开的会话数。 */
  hours: number[]
}

/** 本机一天里与引擎无关的量(并行是跨引擎的)。 */
export type DeviceDailyUsage = {
  day: string
  /** 两个及以上会话同时在干活的总秒数。 */
  parallelSeconds: number
  /** 这一天同时在干活的会话数的峰值。 */
  peakConcurrency: number
}

export type LocalUsageSnapshot = {
  /** 含。 */
  from: string
  /** 含。 */
  to: string
  engines: EngineDailyUsage[]
  device: DeviceDailyUsage[]
}

/** 主进程 RPC:`usage.localDaily`。 */
export type LocalUsageRequest = { from: string; to: string }

/** 云端 `public.usage_daily` 里代表「整台设备」那一行的 engine 值(承载并行与峰值)。 */
export const DEVICE_ROW_ENGINE = '*'

/**
 * 云端 `public.my_usage_daily(p_from, p_to, p_device_id)` 的返回(jsonb 数组,已跨设备合并):
 * 每个 (day, engine) 一条;engine = {@link DEVICE_ROW_ENGINE} 的那条只带 parallelSeconds / peakConcurrency。
 * 合并口径:计数与秒数相加;models / guguModels / byokModels 按键相加;hours 按位相加;peakConcurrency 取各设备最大值。
 */
export type UsageDay = {
  day: string
  engine: string
  sessions: number
  runSeconds: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  models: Record<string, number>
  guguModels: Record<string, number>
  byokModels: Record<string, number>
  hours: number[]
  parallelSeconds: number
  peakConcurrency: number
}

/** 云端 `billing.my_daily_credit_usage(p_from, p_to, p_tz)` 的返回:每个 (day, model) 一条。 */
export type CreditUsageDay = {
  day: string
  /** 扣费记录上没有模型时为 null。 */
  model: string | null
  credits: number
  inputTokens: number
  outputTokens: number
  requests: number
}
