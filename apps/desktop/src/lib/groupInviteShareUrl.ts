// @@@1397 群邀请分享链接构造 —— 纯逻辑,与组件分离(便于单测 + 满足 react-refresh)。
// 复用现有 QR payload 编码(createGroupInviteQrPayload + createGuguQrScanUrl),只换承载基址:
// 把「仅 QR」扩成可粘贴的 web 链接。落地页(app.gugu.nextmind.space/invite)由运营侧 host,
// 点开后尝试拉起 gugu:// deeplink,未装则引导下载——它读的就是这里写进 ?gugu_qr= 的同一 payload。
import { createGroupInviteQrPayload, createGuguQrScanUrl } from '@gugu/core/shared/qrPayload'
import { inviteLandingBase } from './inviteLandingBase'

// 群邀请分享链接。public_id / join_token 缺失(未加载/无邀请权限)→ null,由调用方决定隐藏,
// 不展示半成品死链接。形态:<base>?gugu_qr=<payload>(payload 由 createGuguQrScanUrl 序列化)。
export function buildGroupInviteShareUrl(groupPublicId: number | null, joinToken: string | null): string | null {
  if (!groupPublicId || !joinToken) return null
  try {
    return createGuguQrScanUrl(createGroupInviteQrPayload(groupPublicId, joinToken), {
      downloadUrl: inviteLandingBase(),
    })
  } catch {
    return null
  }
}
