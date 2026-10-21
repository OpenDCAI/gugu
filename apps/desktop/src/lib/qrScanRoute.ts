import { parseGuguQrPayload } from '@gugu/core/shared/qrPayload'

// @@@scan-route (#537-A) - a camera scan is just another way to produce the string a user would
// @@@1169 (b) - a group_invite QR resolves to a direct token-gated JOIN intent (publicId + joinToken),
// NOT a 数字群号 search. The bare-群号 enumeration search is retired (#653); the scanned/pasted invite
// carries the unguessable token and goes straight to the join-confirm (a /join/:inviteCode route).
export type QrScanRoute =
  // @@@add-friend-unify 扫码一个人的联系人 QR = 加人意图 → add_friend 搜索面（不是「新的请求」收件箱）。
  | { nav: 'add_friend'; query: string }
  | { nav: 'group_join'; publicId: number; joinToken?: string }

export function resolveQrScanRoute(raw: string): QrScanRoute | null {
  const payload = parseGuguQrPayload(raw)
  if (!payload) return null
  if (payload.kind === 'contact') return { nav: 'add_friend', query: String(payload.gugu_number) }
  if (payload.kind === 'group_invite') return { nav: 'group_join', publicId: payload.group_public_id, joinToken: payload.join_token }
  return null
}
