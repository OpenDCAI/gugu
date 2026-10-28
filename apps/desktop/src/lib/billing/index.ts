// 计费/积分/配额在 renderer 这一侧的**唯一**入口。
//
// 三层分工:
//   - 领域(积分怎么算、窗口怎么推、还能不能花)在 @gugu/core/billing —— 无 React、无取数;
//   - 这一层只做数据访问 + view-model:按职责分成余额 / 窗口 / 充值 / 用量四个面,外加一个
//     全应用共用的订阅点 useSpendingPower 和唯一的一套说法 describeSpendingPower;
//   - 组件只消费 view-model,不再各自拼装。
//
// 积分是唯一的货币,额度窗口是它的花费速率上限 —— 不是两套并行体系。新体系(model-access /
// quota_windows)建在旧体系(user_credits / usage_events / payment_orders / referral_rewards)
// 之上并强依赖它。
//
// @@@3189 会员落地后:周期额度的唯一来源是用户所在的档位,每日赠送那套与档位并行的第二份
// 周期发放已退役(库侧 claim_daily_gift 已 DROP)。注册礼包与邀请返利保留 —— 它们只发一次、
// 只进不过期积分,不构成第二套周期额度。
export {
  getCreditsBalance,
  getReferralStats,
  type ReferralStats,
} from './balance'
export {
  daysUntilExpiry,
  getMembership,
  type Membership,
  type MembershipTier,
} from './membership'
export {
  getQuotaWindows,
  periodUsdFor,
  quotaWindowLabel,
  quotaWindowViews,
  type QuotaWindowView,
  type QuotaWindows,
} from './quota'
export type { UsageActivityRow } from './usage'
export {
  creditCount,
  describeSpendingPower,
  formatCredits,
  formatUsageCredits,
  formatUntil,
  type SpendingPowerCopy,
} from './spendingPowerCopy'
export {
  refreshSpendingPower,
  useSpendingPower,
  type SpendingSnapshot,
} from './useSpendingPower'
export {
  isLowBalance,
  LOW_BALANCE_CREDITS,
  type SpendBlockReason,
  type SpendingPower,
  type SpendWindow,
} from '@gugu/core/billing'
