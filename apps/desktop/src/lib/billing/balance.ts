// 余额面:积分账户本身的进出 —— 读余额、邀请返利。
// @@@3189 余额 = 不过期积分(加量包买来的 + 注册礼包/邀请返利送来的)。换算率由服务端
// billing.pricing_settings 定,下单见 purchase.ts;客户端不持有任何换算常量。
// 读取走 RLS(owner-select 只见自己行)。无 billing 后端时(未部署 edge fn / 未配密钥)调用会
// 报错 → 调用方显式提示,不静默。
import { getCurrentAuthUserId, dataClient } from '../supabase'
import { i18n } from '@/i18n'

// 读当前用户积分余额。无 user_credits 行(从未充值/未开通云)→ 0。RLS 保证只读自己行。
export async function getCreditsBalance(): Promise<number> {
  const { data, error } = await dataClient
    .schema('billing')
    .from('user_credits')
    .select('balance_credits')
    .maybeSingle()
  if (error) throw new Error(error.message)
  const balance = Number(data?.balance_credits ?? 0)
  if (!Number.isFinite(balance)) throw new Error(i18n.t('credits.invalidBalance', { ns: 'settings' }))
  return balance
}

// @@@1511 邀请返利统计:读「我作为邀请人」的 referral_rewards 行 → 已邀请人数 + 已获得积分(sum credits_each)。
// RLS 授权 authenticated SELECT(referrer/invitee 任一是自己即可见);此处只取「我是邀请人」的行。
export interface ReferralStats {
  invitedCount: number   // 我成功邀请的人数(= 我作为 referrer 的 referral_rewards 行数)
  creditsEarned: number  // 我因邀请获得的积分总额(= sum credits_each)
}

export async function getReferralStats(): Promise<ReferralStats> {
  const uid = await getCurrentAuthUserId().catch(() => null)
  if (!uid) return { invitedCount: 0, creditsEarned: 0 }
  const { data, error } = await dataClient
    .schema('billing')
    .from('referral_rewards')
    .select('credits_each')
    .eq('referrer_user_id', uid)
  if (error) throw new Error(error.message)
  const rows = data ?? []
  return {
    invitedCount: rows.length,
    creditsEarned: rows.reduce((sum, r) => sum + (Number(r.credits_each) || 0), 0),
  }
}
