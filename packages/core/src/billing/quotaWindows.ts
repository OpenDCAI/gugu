// 平台额度的领域模型:只有推导,没有取数、没有渲染。
//
// 积分是唯一的货币,而且**一个积分就是一美元的模型牌价用量**(官方计价口径)。
// 充值、赠送、邀请返利都进同一个 billing.user_credits.balance_credits;每一次模型用量按积分
// 从同一个余额扣走(billing.charge_usage,由 model_access_settle 调用)。
//
// 额度窗口**不是第二种货币**,而是这笔积分的花费上限:**一个订阅周期一个池子**,池子里怎么花
// 是用户的事。❌ 没有窗中窗 —— 5 小时短窗已于 owner 2026-08-17 撤销,两条理由:
//   ① 防刷动机不成立(转卖赚不到钱);而且短窗是**按用户**的,
//      供给耗尽是**总量**现象,它从来就不是供给护栏。
//   ② 7 天周期装不进 30 天付费周期 —— 按周续杯在 30 天里落 5 次,用户拿几份取决于哪天订阅。
// ❌ 别再加回来。要限速就在网关侧做**总量**限流,不是给每个人套一个窗。
//
// 政策的每一个数字都来自服务端(档位字段在 billing.quota_plans,积分刻度在 billing.pricing_settings),
// 客户端不许内置其中任何一个 —— 周期长度、周期积分、积分刻度都会变,运营改一次配置不该要发一版客户端。

/** 服务端 billing.current_quota_windows() 一行的原样投影(#2675 起由客户端自读,不再经转发)。 */
export interface QuotaWindows {
  plan_id: string
  period_credits: number
  period_used: number
  period_started_at: string
  period_ends_at: string
  /** 已发出但尚未结算的预留,窗口和余额都要扣。 */
  outstanding_credits: number
  /**
   * 积分刻度:1 美元上游用量折多少积分。全系统唯一来源是 billing.pricing_settings 的那一行。
   *
   * **可能为 null** —— 服务端用 LEFT JOIN 取它,配置缺失时窗口照常返回、只有这一列为空。
   * 进度条不需要刻度(它只喂「合多少美元」那一句文案),所以额度视图必须在没有它的时候
   * 照常工作:把一句文案的缺失升级成「用户看不到自己还剩多少额度」是不可接受的。
   */
  credits_per_usd: number | null
}

/** 一个窗口在这一刻允许什么。画条用的几何(比例)属于 renderer,不在这里。 */
export interface SpendWindow {
  /** 已结算并计入本窗口的用量。 */
  used: number
  /** 已发出、尚未结算的预留。 */
  held: number
  /** 本窗口的上限。 */
  limit: number
  /** 还能花的:上限扣掉已用和预留,不会为负。 */
  remaining: number
  /** 窗口长度(小时),由服务端两个时间戳算出,不写死。 */
  hours: number
  /** 本窗口恢复容量的时刻。 */
  freesAt: Date
}

const MILLIS_PER_HOUR = 3_600_000

function requireFiniteNumber(value: number, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`额度配置不可用：${what} 不是有效数值（${String(value)}）`)
  }
  return value
}

function requireInstant(value: string, what: string): Date {
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) {
    throw new Error(`额度信息不可用：${what} 不是有效时间（${String(value)}）`)
  }
  return at
}

/**
 * 这一档的周期额度合多少美元 = 周期积分 ÷ 刻度。**从不存储** —— 存下来就多出一个能和
 * pricing_settings 打架的地方,而那正是 reference_usd 那一列被删掉的原因。
 *
 * 刻度落到 1 之后这个数与积分数相等,但**不能因此省掉它**:刻度是运营参数,改回非 1 时
 * 省掉的那一步会变成一个静默错掉的金额。
 *
 * 刻度不可用时返回 null,不返回 0、不抛错 —— 调用方据此**不渲染那句文案**即可,
 * 进度条不需要这个值。把一句文案的缺失升级成整个额度面板报错是不划算的。
 */
export function periodUsdFor(windows: Pick<QuotaWindows, 'period_credits' | 'credits_per_usd'>): number | null {
  const scale = windows.credits_per_usd
  if (scale === null || !Number.isFinite(scale) || scale <= 0) return null
  return windows.period_credits / scale
}

/** 窗口长度(小时)由服务端的起止时间算出,不写死。 */
export function windowHours(startedAt: string, endsAt: string): number {
  const start = requireInstant(startedAt, '窗口起点')
  const end = requireInstant(endsAt, '窗口终点')
  return Math.round((end.getTime() - start.getTime()) / MILLIS_PER_HOUR)
}

export function deriveSpendWindow(input: {
  used: number
  held: number
  limit: number
  startedAt: string
  endsAt: string
  freesAt: string
}): SpendWindow {
  const used = requireFiniteNumber(input.used, '窗口已用')
  const held = requireFiniteNumber(input.held, '窗口预留')
  const limit = Math.max(0, requireFiniteNumber(input.limit, '窗口上限'))
  return {
    used,
    held,
    limit,
    remaining: Math.max(0, limit - used - held),
    hours: windowHours(input.startedAt, input.endsAt),
    freesAt: requireInstant(input.freesAt, '窗口恢复时刻'),
  }
}

/**
 * 服务端一行 → 这个周期的池子。
 *
 * 只剩一个窗。返回值仍然包成 `{ period }` 而不是直接返回 SpendWindow:调用方按名字取,
 * 将来真要再加别的约束(比如网关侧的总量限流投影)时不必改每一个调用点。
 */
export function quotaSpendWindows(
  windows: QuotaWindows,
): { period: SpendWindow } {
  const held = requireFiniteNumber(windows.outstanding_credits, '预留积分')
  return {
    period: deriveSpendWindow({
      used: windows.period_used,
      held,
      limit: windows.period_credits,
      startedAt: windows.period_started_at,
      endsAt: windows.period_ends_at,
      freesAt: windows.period_ends_at,
    }),
  }
}
