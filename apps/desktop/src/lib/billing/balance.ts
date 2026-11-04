// 余额面:积分账户本身的进出 —— 读余额、邀请返利。
// @@@3189 余额 = 不过期积分(加量包买来的 + 注册礼包/邀请返利送来的)。换算率由服务端
// billing.pricing_settings 定,下单见 purchase.ts;客户端不持有任何换算常量。
// 读取走 RLS(owner-select 只见自己行)。无 billing 后端时(未部署 edge fn / 未配密钥)调用会
// 报错 → 调用方显式提示,不静默。
import { activeCreditV2, creditV2, creditV2Read } from './v2/runtime'
import { CreditV2StateError } from './v2/active'

// Read the projected JSON-number balance for display. Missing rows remain unknown; RLS is authoritative.
export async function getCreditsBalance(): Promise<number> {
  return creditV2Read(async () => {
    const balance = await activeCreditV2.table(() => creditV2.balance())
    if (balance === null) throw new CreditV2StateError('unknown')
    return balance
  })
}

// @@@1511 邀请返利统计:读「我作为邀请人」的 referral_rewards 行 → 已邀请人数 + 已获得积分(sum credits_each)。
// RLS 授权 authenticated SELECT(referrer/invitee 任一是自己即可见);此处只取「我是邀请人」的行。
export interface ReferralStats {
  invitedCount: number   // 我成功邀请的人数(= 我作为 referrer 的 referral_rewards 行数)
  creditsEarned: number  // 我因邀请获得的积分总额(= sum credits_each)
}

export async function getReferralStats(): Promise<ReferralStats> {
  return creditV2Read(async () => {
    const rows = await activeCreditV2.table(() => creditV2.referralRewards())
    // JSON-number rewards support this two-decimal display statistic, not exact accounting.
    return { invitedCount: rows.length, creditsEarned: rows.reduce((sum, row) => sum + row.creditsEach, 0) }
  })
}
