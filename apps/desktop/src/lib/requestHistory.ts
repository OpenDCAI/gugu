import type { FriendRequest } from '@gugu/core/shared/types/contacts'

export type FriendRequestEntry = { request: FriendRequest; direction: 'received' | 'sent' }

/** 等我处理 = 收到的、还待处理的;页签角标只数它。 */
export const awaitsMe = ({ request, direction }: FriendRequestEntry) => direction === 'received' && request.status === 'pending'

/** 「新的请求」各列表的顺序:等我处理的在前,其余按申请时间倒序。 */
function byActionThenTime<T>(actionable: (row: T) => boolean, createdAt: (row: T) => string | null) {
  return (a: T, b: T) => Number(actionable(b)) - Number(actionable(a)) || (createdAt(b) ?? '').localeCompare(createdAt(a) ?? '')
}

/** 入群申请与群邀请都由我来定:待处理即等我处理。 */
export const pendingFirst = byActionThenTime<{ status: string; created_at: string | null }>((row) => row.status === 'pending', (row) => row.created_at)

/**
 * 好友 / Agent 列表:收到的与我发出的混排成一张。
 * 同一对人、同一方向只留最新一条 —— 被拒后重新申请是新的一行,旧的那条不再单独列出。
 */
export function friendRequestEntries(received: readonly FriendRequest[], sent: readonly FriendRequest[]): FriendRequestEntry[] {
  const latest = new Map<string, FriendRequestEntry>()
  for (const [direction, rows] of [['received', received], ['sent', sent]] as const) {
    for (const request of rows) {
      const key = `${direction}:${request.sender_id}:${request.receiver_id}`
      const kept = latest.get(key)
      if (!kept || kept.request.created_at < request.created_at) latest.set(key, { request, direction })
    }
  }
  return [...latest.values()].sort(byActionThenTime(awaitsMe, (entry) => entry.request.created_at))
}

/** 行尾的灰字状态;收到·待处理没有状态(那一行是同意 / 忽略按钮)。 */
export function friendRequestStatusKey({ request, direction }: FriendRequestEntry): string | null {
  if (request.status === 'accepted') return 'friendRequests.statusAdded'
  if (direction === 'received') return request.status === 'rejected' ? 'friendRequests.statusIgnored' : null
  return request.status === 'pending' ? 'friendRequests.waiting' : 'friendRequests.statusDeclined'
}
