// @@@1511 邀请返利前端搬运层。捕获邀请链接的 ?ref=<gugu_number> → 注册时塞进 signup metadata
// (referrer_gugu_number),由 DB 触发器 on_auth_user_created_referral 解析并给双方发积分。
// 前端只搬运 referrer + 生成链接,不判防刷(自邀/重复/inactive 全在 billing.grant_referral_reward 内)。
import { inviteLandingBase } from './inviteLandingBase'

const PENDING_REFERRER_KEY = 'pending_referrer_gugu_number'

// 启动时调:把 URL 的 ?ref=<纯数字 gugu_number> 暂存,待注册时用。非数字/无值/storage 不可用 → 静默忽略。
export function captureReferralFromUrl(
  search: string = typeof window !== 'undefined' ? window.location.search : '',
): void {
  try {
    const ref = new URLSearchParams(search).get('ref')
    if (ref && /^\d+$/.test(ref)) localStorage.setItem(PENDING_REFERRER_KEY, ref)
  } catch {
    /* URL/localStorage 不可用:忽略,绝不影响启动 */
  }
}

// 取暂存的 referrer gugu_number(纯数字串);无/非法 → null。只读,不清除。
export function consumePendingReferrer(): string | null {
  try {
    const v = localStorage.getItem(PENDING_REFERRER_KEY)
    return v && /^\d+$/.test(v) ? v : null
  } catch {
    return null
  }
}

// 注册/登录成功后清掉已用的邀请码(避免给后续在本机登录的人误带 referrer)。
export function clearPendingReferrer(): void {
  try {
    localStorage.removeItem(PENDING_REFERRER_KEY)
  } catch {
    /* 忽略 */
  }
}

// 用当前用户 gugu_number 构造个人邀请链接;无号(未加载)→ null,由调用方隐藏,不展示死链接。
export function buildReferralShareUrl(guguNumber: number | null | undefined): string | null {
  if (!guguNumber) return null
  return `${inviteLandingBase()}?ref=${guguNumber}`
}
