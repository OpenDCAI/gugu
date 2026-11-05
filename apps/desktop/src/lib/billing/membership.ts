// 会员面:用户当前在哪一档、到什么时候、加量包怎么换算。
//
// 与 quota.ts 的分工:那边答「本周还能花多少」(额度窗口),这边答「我买的是什么」(档位与订阅)。
// 两者都从服务端取,客户端不推导 —— 档位数值是运营配置,写进界面就等于调价要发版。
//
// 档位名称不入库:后端只给 tier_key(free/plus/pro/max),界面用它查本地化文案。
// 这样改文案不用跑迁移,加语言也不用动数据库。
import type { CreditAmount } from '@gugu/core/billing/creditAmount'
import { activeCreditV2, creditV2, creditV2Read } from './v2/runtime'
import { CreditV2StateError } from './v2/active'
import type { MembershipV2 } from './v2/readers'
import { i18n } from '@/i18n'

export type MembershipTier = 'free' | 'plus' | 'pro' | 'max'

const TIER_KEYS: readonly string[] = ['free', 'plus', 'pro', 'max']

export interface Membership {
  planId: string
  tier: MembershipTier
  /** 该档月价(元)。免费档为 0。 */
  monthlyPriceCny: CreditAmount
  /** 该档一个订阅周期的额度 —— 只有这一个池子,没有窗中窗。 */
  periodCredits: CreditAmount
  /** 周期时长(小时)。与订阅周期同长,所以 30 天里不会出现「第 5 个周」。 */
  periodHours: number
  /** 订阅到期时刻;免费档 / 未订阅为 null。 */
  expiresAt: Date | null
  /** 不过期积分余额(加量包与一次性赠送)。 */
  balanceCredits: CreditAmount
  /** 加量包换算:每人民币元多少积分。 */
  topupCreditsPerCny: CreditAmount
}

/** 档位解析。 */
export function toTier(value: unknown, field: string): MembershipTier {
  if (typeof value !== 'string' || !TIER_KEYS.includes(value)) {
    // 出现未知档位说明库里加了档而客户端不认识。报错而不是回落到 free:
    // 悄悄按免费档渲染会让付了钱的用户看见免费档的额度。
    // 档位名走 cause 不进 message,见 usage.ts 同处注释 (#4891)
    throw new Error(i18n.t('membership.invalidTier', { ns: 'settings' }), { cause: { field, value } })
  }
  return value as MembershipTier
}

/** 已登录用户的档位与订阅状态。空结果是未知，不能被消费方当成非会员。 */
export async function getMembership(): Promise<Membership | null> {
  return creditV2Read(async () => {
    const { rows } = await activeCreditV2.rows(() => creditV2.membership())
    if (!rows[0]) throw new CreditV2StateError('unknown')
    return membershipProjection(rows[0])
  })
}

export function membershipProjection(row: MembershipV2): Membership {
  return {
    planId: row.planId, tier: toTier(row.tierKey, 'tier_key'),
    monthlyPriceCny: row.monthlyPriceCny, periodCredits: row.periodCredits, periodHours: row.periodHours,
    expiresAt: row.expiresAt === null ? null : new Date(row.expiresAt),
    balanceCredits: row.balanceCredits, topupCreditsPerCny: row.topupCreditsPerCny,
  }
}

/**
 * 订阅剩余天数(向上取整)。到期或未订阅返回 null。
 * 向上取整是因为「还剩 0 天」在用户读来是「已经没了」,而此刻他其实还能用。
 */
export function daysUntilExpiry(expiresAt: Date | null, now: Date = new Date()): number | null {
  if (!expiresAt) return null
  const ms = expiresAt.getTime() - now.getTime()
  if (!Number.isFinite(ms) || ms <= 0) return null
  return Math.ceil(ms / 86_400_000)
}
