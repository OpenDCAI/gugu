// #6704「新的请求」照微信「新的朋友」:收到的与我发出的混排成一张历史,每行带状态。
// 判据:① 等我处理的在前,其余按申请时间倒序;② 同一对人同一方向只留最新一条;③ 六种收发 × 状态各有自己的状态文案。
import { describe, expect, it } from 'vitest'
import { friendRequestEntries, friendRequestStatusKey, pendingFirst } from '../../../apps/desktop/src/lib/requestHistory'
import type { FriendRequest } from '../../../packages/core/src/shared/types/contacts'

function request(id: string, sender_id: string, receiver_id: string, status: FriendRequest['status'], created_at: string): FriendRequest {
  return { id, sender_id, receiver_id, message: null, status, created_at }
}

describe('#6704 friendRequestEntries', () => {
  it('收到·待处理在最上,其余(含我发出的)按申请时间倒序', () => {
    const entries = friendRequestEntries(
      [request('in-old-pending', 'a', 'me', 'pending', '2026-09-01T00:00:00Z'), request('in-accepted', 'b', 'me', 'accepted', '2026-09-03T00:00:00Z')],
      [request('out-pending', 'me', 'c', 'pending', '2026-09-04T00:00:00Z'), request('out-rejected', 'me', 'd', 'rejected', '2026-09-02T00:00:00Z')],
    )
    expect(entries.map((entry) => entry.request.id)).toEqual(['in-old-pending', 'out-pending', 'in-accepted', 'out-rejected'])
    expect(entries.map((entry) => entry.direction)).toEqual(['received', 'sent', 'received', 'sent'])
  })

  it('被拒后重新申请:同一对人同一方向只留最新那条;反方向的另算一行', () => {
    const entries = friendRequestEntries(
      [request('again', 'a', 'me', 'pending', '2026-09-05T00:00:00Z'), request('first', 'a', 'me', 'rejected', '2026-09-01T00:00:00Z')],
      [request('mine', 'me', 'a', 'pending', '2026-09-02T00:00:00Z')],
    )
    expect(entries.map((entry) => entry.request.id)).toEqual(['again', 'mine'])
  })
})

describe('#6704 friendRequestStatusKey', () => {
  it('收到·待处理没有状态(是按钮);其余五格各有文案', () => {
    const key = (direction: 'received' | 'sent', status: FriendRequest['status']) =>
      friendRequestStatusKey({ direction, request: request('r', 'x', 'y', status, '2026-09-01T00:00:00Z') })
    expect(key('received', 'pending')).toBeNull()
    expect(key('received', 'accepted')).toBe('friendRequests.statusAdded')
    expect(key('received', 'rejected')).toBe('friendRequests.statusIgnored')
    expect(key('sent', 'pending')).toBe('friendRequests.waiting')
    expect(key('sent', 'accepted')).toBe('friendRequests.statusAdded')
    expect(key('sent', 'rejected')).toBe('friendRequests.statusDeclined')
  })
})

describe('#6704 pendingFirst(入群申请 / 群邀请)', () => {
  it('被重新申请而复活的旧行(created_at 早)仍排在已处理的新行前面', () => {
    const rows = [
      { id: 'decided-new', status: 'accepted', created_at: '2026-09-05T00:00:00Z' },
      { id: 'revived-old', status: 'pending', created_at: '2026-09-01T00:00:00Z' },
      { id: 'decided-old', status: 'rejected', created_at: '2026-09-02T00:00:00Z' },
    ]
    expect([...rows].sort(pendingFirst).map((row) => row.id)).toEqual(['revived-old', 'decided-new', 'decided-old'])
  })
})
