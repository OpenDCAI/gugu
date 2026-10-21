// 额度窗口面:取数 + 画条要的几何。窗口本身怎么推导(上限、余量、时长)在
// @gugu/core/billing —— 这里不重算,只把领域结果加上进度条需要的比例。
import { periodUsdFor, quotaSpendWindows, type QuotaWindows, type SpendWindow } from '@gugu/core/billing'
import { dataClient } from '../supabase'
import { getLocaleSnapshot, i18n, type SupportedLocale } from '@/i18n'
import enUS from '@/i18n/locales/en-US/settings'
import zhCN from '@/i18n/locales/zh-CN/settings'

export type { QuotaWindows }
// 「这一档合多少美元」的推导住在领域层:推导,从不存储。
// 这里只做转出,不在 renderer 里再写一遍除法 —— 再写一遍就又有两处会打架了。
export { periodUsdFor }

/**
 * 额度是只读投影,走 billing 自读 RPC(#2675)。签发与结算仍在 model-access —— 但"看一眼
 * 还剩多少"不该耦合到 relay 供给凭据,缺任一就 503。零参 current_quota_windows() 在函数体内
 * 用 auth.uid 自读,取代了那个带任意 UUID 参数、无 fence 的 SECURITY DEFINER 版本。
 */
export async function getQuotaWindows(): Promise<QuotaWindows> {
  const { data, error } = await dataClient.schema('billing').rpc('current_quota_windows')
  if (error) throw new Error(error.message)
  const windows = (Array.isArray(data) ? data[0] : data) as QuotaWindows | null
  if (!windows) throw new Error(quotaMessage().quotaUnavailable)
  return {
    ...windows,
    period_credits: numeric(windows.period_credits, 'period_credits'),
    period_used: numeric(windows.period_used, 'period_used'),
    outstanding_credits: numeric(windows.outstanding_credits, 'outstanding_credits'),
    // 刻度是**除数**(面板拿它把周期积分折成美元),所以校验比其余字段严一档:非正数一律当没有。
    // 0 也是有限数,`numeric` 会放它过去,除出来是 Infinity —— 界面上是一个荒谬的金额。
    // ❌ 不拿服务端那条 CHECK 约束替客户端校验背书:值经过一整条网络与序列化才到这里。
    //
    // 但**不为此抛错**:服务端配置缺失时这一列本来就是 NULL,而进度条不需要它。
    // 把一句文案的缺失升级成「整个额度面板报错」,是拿用户看得见的东西去赌一个装饰性字段。
    credits_per_usd: optionalPositive(windows.credits_per_usd),
  }
}

function numeric(value: unknown, field: string): number {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    // 字段名走 cause 不进 message,见 usage.ts 同处注释 (#4891)
    throw new Error(quotaMessage().quotaInvalidNumber, { cause: { field, value } })
  }
  return number
}

function optionalPositive(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function quotaMessage(locale: SupportedLocale = getLocaleSnapshot().resolvedLocale) {
  return (locale === 'zh-CN' ? zhCN : enUS).credits
}

/**
 * 一个窗口在 UI 上要显示的全部内容:领域量(已用/预留/上限/余量/时长/恢复时刻)之外,
 * 多两条只有进度条才用得上的比例。比例在这里而不在 core —— 「不超过轨道长度」是画条的规矩,
 * 不是额度的规矩。
 */
export interface QuotaWindowView extends SpendWindow {
  /** 0..1,已用占比;已用+预留超出上限时截到 1。 */
  usedRatio: number
  heldRatio: number
}

function withBarGeometry(window: SpendWindow): QuotaWindowView {
  const span = window.limit
  const usedRatio = span > 0 ? Math.min(1, window.used / span) : 0
  const heldRatio = span > 0 ? Math.min(1 - usedRatio, window.held / span) : 0
  return { ...window, usedRatio, heldRatio }
}

/** 把服务端窗口变成 UI 直接能画的一条,窗口长度和上限都来自返回值。 */
export function quotaWindowViews(w: QuotaWindows): { period: QuotaWindowView } {
  const { period } = quotaSpendWindows(w)
  return { period: withBarGeometry(period) }
}

/** 「30 天」这类窗口名由时长算出,配置改了文案自动跟着改。 */
export function quotaWindowLabel(
  hours: number,
  locale: SupportedLocale = getLocaleSnapshot().resolvedLocale,
): string {
  const t = i18n.getFixedT(locale, 'settings')
  if (hours >= 48 && hours % 24 === 0) {
    const days = hours / 24
    return t('credits.spending.windowDays', { count: days })
  }
  return t('credits.spending.windowHours', { count: hours })
}
