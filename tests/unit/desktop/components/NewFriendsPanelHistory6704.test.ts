// @vitest-environment jsdom
//
// #6704「新的请求」的好友页签是一张历史:收到的与我发出的混排,每行行尾是按钮(等我处理)或灰字状态。
// 判据:① 六种收发 × 状态都在,各自的状态文案对;② 点一行打开详情,看得到完整附言与咕咕号,在详情里同意;
// ③ 同意一条真人好友请求(RPC 回 DM 的 chat_id、kind 为空)不再抛错、不跳进群。
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NewFriendsPanel } from '../../../../apps/desktop/src/components/NewFriendsPanel'
import { friendRequestEntries } from '../../../../apps/desktop/src/lib/requestHistory'
import type { FriendRequest } from '../../../../packages/core/src/shared/types/contacts'
import { clickElement, contact, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })

const me = contact({ id: 'me', display_name: '我' })
function request(id: string, peerName: string, direction: 'received' | 'sent', status: FriendRequest['status'], created_at: string, message: string | null = null): FriendRequest {
  const peer = contact({ id: `peer-${id}`, display_name: peerName, gugu_number: 200123 })
  return direction === 'received'
    ? { id, sender_id: peer.id, receiver_id: me.id, sender: peer, receiver: me, message, status, created_at }
    : { id, sender_id: me.id, receiver_id: peer.id, sender: me, receiver: peer, message, status, created_at }
}
const received = [
  request('in-pending', '林小雨', 'received', 'pending', '2026-09-28T04:29:06Z', '你好,我是林小雨,想加你为联系人'),
  request('in-accepted', '陈默', 'received', 'accepted', '2026-09-28T04:28:59Z'),
  request('in-rejected', '周以宁', 'received', 'rejected', '2026-09-28T04:29:01Z'),
]
const sent = [
  request('out-pending', '赵青禾', 'sent', 'pending', '2026-09-28T04:29:05Z', '赵老师好'),
  request('out-accepted', '何冬', 'sent', 'accepted', '2026-09-28T04:29:02Z'),
  request('out-rejected', '孙明远', 'sent', 'rejected', '2026-09-28T04:29:03Z'),
]
const rows = () => [...harness.container.querySelectorAll('#gg-req-panel-friends .nfp-reqrow')] as HTMLElement[]
const row = (name: string) => rows().find((element) => element.textContent?.includes(name))!

describe('#6704 好友页签 = 请求历史', () => {
  it('六种收发 × 状态同在一张列表,等我处理的在最上;页签角标只数它', async () => {
    await renderWithAppProviders(harness, createNode(NewFriendsPanel, {}), { contacts: { friendRequests: friendRequestEntries(received, sent) } })
    expect(rows().map((element) => element.querySelector('.nfp-name')?.textContent)).toEqual(['林小雨', '赵青禾', '孙明远', '何冬', '周以宁', '陈默'])
    expect(row('林小雨').querySelector('[data-testid="contacts-pending-request-accept-button"]')).not.toBeNull()
    expect(row('陈默').textContent).toContain('已添加')
    expect(row('周以宁').textContent).toContain('已忽略')
    expect(row('赵青禾').textContent).toContain('我：赵老师好')
    expect(row('赵青禾').textContent).toContain('等待验证')
    expect(row('何冬').textContent).toContain('已添加')
    expect(row('孙明远').textContent).toContain('未通过')
    for (const name of ['陈默', '周以宁', '赵青禾', '何冬', '孙明远']) expect(row(name).querySelector('button')).toBeNull()
    expect(harness.container.textContent).not.toContain('已发出的申请')
    const friendsTab = harness.container.querySelector('[role="tab"]') as HTMLElement
    expect(friendsTab.querySelector('.gg-segtab-badge')?.textContent).toBe('1')
  })

  it('点一行打开详情:完整附言与咕咕号;在详情里同意,详情收起', async () => {
    const acceptRequest = vi.fn(async () => ({ chatId: null, name: null, kind: null, created: false, member_count: null }))
    await renderWithAppProviders(harness, createNode(NewFriendsPanel, {}), { contacts: { friendRequests: friendRequestEntries(received, sent), acceptRequest } })
    expect(document.querySelector('[data-testid="request-detail"]')).toBeNull()
    await clickElement(row('林小雨'))
    const detail = document.querySelector('[data-testid="request-detail"]') as HTMLElement
    expect(detail.textContent).toContain('你好,我是林小雨,想加你为联系人')
    expect(detail.textContent).toContain('咕咕号 200123')
    await clickElement([...detail.querySelectorAll('button')].find((button) => button.textContent === '同意')!)
    await act(async () => { await Promise.resolve() })
    expect(acceptRequest).toHaveBeenCalledWith('in-pending')
    expect(document.querySelector('[data-testid="request-detail"]')).toBeNull()
  })

  it('已处理的行也能点开,详情底部是同一句状态、没有操作', async () => {
    await renderWithAppProviders(harness, createNode(NewFriendsPanel, {}), { contacts: { friendRequests: friendRequestEntries(received, sent) } })
    await clickElement(row('孙明远'))
    const detail = document.querySelector('[data-testid="request-detail"]') as HTMLElement
    expect(detail.querySelector('[data-testid="request-detail-status"]')?.textContent).toBe('未通过')
    expect([...detail.querySelectorAll('button')].some((button) => button.textContent === '同意')).toBe(false)
  })

  it('同意真人好友请求:RPC 回 DM 的 chat_id、kind 为空 —— 不抛错、不跳进群', async () => {
    const acceptRequest = vi.fn(async () => ({ chatId: 'dm-1', name: null, kind: null, created: false, member_count: 2 }))
    const onOpenGroupChat = vi.fn()
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      await renderWithAppProviders(harness, createNode(NewFriendsPanel, { onOpenGroupChat }), { contacts: { friendRequests: friendRequestEntries(received, sent), acceptRequest } })
      await clickElement(row('林小雨').querySelector('[data-testid="contacts-pending-request-accept-button"]') as HTMLElement)
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    } finally {
      process.off('unhandledRejection', unhandled)
    }
    expect(acceptRequest).toHaveBeenCalledWith('in-pending')
    expect(onOpenGroupChat).not.toHaveBeenCalled()
    expect(unhandled).not.toHaveBeenCalled()
  })
})
