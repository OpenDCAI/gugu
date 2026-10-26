// @vitest-environment jsdom
//
// @@@6418 入群申请归通讯录「新的请求 → 群聊」,与好友申请同一种表达。判据:
//   ① 申请在群聊页签里出现,说明行写清「申请加入哪个群」,附言跟在后面;
//   ② 同意/拒绝真的调到 decide_group_join,处理完重读申请与群列表;
//   ③ 库里按当下事实拒绝(如人数已满)时,产品文案原样显示在这条申请下 —— ❌ 静默;
//   ④ 打开「新的请求」就补读一次入群申请(库里没有实时推送)。
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NewFriendsPanel } from '../../../../apps/desktop/src/components/NewFriendsPanel'
import { chatService } from '../../../../apps/desktop/src/lib/chat'
import type { ManagedGroupJoinRequest } from '../../../../apps/desktop/src/lib/groupJoinRequests'
import { clickElement, createNode, createReactHarness, displayIdentity, renderWithAppProviders } from '../../../support/testHarness'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })

function joinRequest(overrides: Partial<ManagedGroupJoinRequest> = {}): ManagedGroupJoinRequest {
  return {
    id: 'join-1',
    chat_id: 'group-1',
    requester_user_id: 'applicant-1',
    requester_type: 'human',
    requested_by_user_id: null,
    message: '想一起验收',
    status: 'pending',
    created_at: '2026-09-24T00:00:00.000Z',
    group: { id: 'group-1', name: '产品组', avatar_url: null },
    ...overrides,
  }
}

async function renderPanel(contacts: Record<string, unknown>, refreshChats?: () => Promise<void>) {
  await renderWithAppProviders(harness, createNode(NewFriendsPanel, {}), {
    chat: { identitiesById: { 'applicant-1': displayIdentity('applicant-1', { display_name: '申请人甲' }) }, ...(refreshChats ? { refreshChats } : {}) },
    contacts,
  })
}
const groupTab = () => [...harness.container.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent?.includes('群聊')) as HTMLElement | undefined
const joinRow = () => harness.container.querySelector('[data-testid="group-join-request"]') as HTMLElement | null

describe('#6418 通讯录「新的请求」里的入群申请', () => {
  it('出现在群聊页签:谁、申请加入哪个群、附言;打开面板时补读一次', async () => {
    const refreshGroupJoinRequests = vi.fn(async () => {})
    await renderPanel({ groupJoinRequests: [joinRequest()], refreshGroupJoinRequests })
    expect(refreshGroupJoinRequests).toHaveBeenCalledTimes(1)
    expect(groupTab()).toBeTruthy()
    await clickElement(groupTab()!)
    const row = joinRow()
    expect(row?.textContent).toContain('申请人甲')
    expect(row?.textContent).toContain('申请加入「产品组」')
    expect(row?.textContent).toContain('想一起验收')
  })

  it('反例:没有申请时群聊页签里没有入群申请这一组;两类都空时只给一句合并的空态', async () => {
    await renderPanel({ groupJoinRequests: [] })
    await clickElement(groupTab()!)
    expect(harness.container.querySelector('[data-testid="group-join-requests"]')).toBeNull()
    expect(harness.container.textContent).toContain('暂无新的入群申请或群邀请')
    expect(harness.container.textContent).not.toContain('暂无待处理的群邀请')
  })

  it('有入群申请、没有群邀请:不再在下面挂一个空的「群邀请」', async () => {
    await renderPanel({ groupJoinRequests: [joinRequest()] })
    await clickElement(groupTab()!)
    const pane = harness.container.querySelector('#gg-req-panel-groups')
    expect(pane?.textContent).toContain('入群申请')
    expect(pane?.textContent).not.toContain('群邀请')
    expect(pane?.textContent).not.toContain('暂无')
  })

  it('同意:调 decide_group_join,然后重读申请与群列表', async () => {
    const decide = vi.spyOn(chatService, 'decideGroupJoin').mockResolvedValue('accepted')
    const refreshGroupJoinRequests = vi.fn(async () => {})
    const refreshChats = vi.fn(async () => {})
    await renderPanel({ groupJoinRequests: [joinRequest()], refreshGroupJoinRequests }, refreshChats)
    await clickElement(groupTab()!)
    refreshGroupJoinRequests.mockClear()
    await clickElement(harness.container.querySelector('[data-testid="group-join-request-accept"]') as HTMLElement)
    await act(async () => { await Promise.resolve() })
    expect(decide).toHaveBeenCalledWith('join-1', true)
    expect(refreshGroupJoinRequests).toHaveBeenCalledTimes(1)
    expect(refreshChats).toHaveBeenCalledTimes(1)
  })

  it('库里拒绝(人数已满):把产品文案显示在这条申请下,不重读', async () => {
    vi.spyOn(chatService, 'decideGroupJoin').mockRejectedValue(new Error('群成员已满，先调高人数上限再处理'))
    const refreshGroupJoinRequests = vi.fn(async () => {})
    await renderPanel({ groupJoinRequests: [joinRequest()], refreshGroupJoinRequests })
    await clickElement(groupTab()!)
    refreshGroupJoinRequests.mockClear()
    await clickElement(harness.container.querySelector('[data-testid="group-join-request-accept"]') as HTMLElement)
    await act(async () => { await Promise.resolve() })
    expect(joinRow()?.querySelector('[role="alert"]')?.textContent).toContain('群成员已满')
    expect(refreshGroupJoinRequests).not.toHaveBeenCalled()
  })

  it('#6704 已处理的申请留在列表里:行尾是灰字状态、没有按钮;页签角标只数待审', async () => {
    await renderPanel({ groupJoinRequests: [
      joinRequest(),
      joinRequest({ id: 'join-2', status: 'accepted' }),
      joinRequest({ id: 'join-3', status: 'rejected' }),
    ] })
    await clickElement(groupTab()!)
    const rows = [...harness.container.querySelectorAll('[data-testid="group-join-request"]')] as HTMLElement[]
    const byId = (id: string) => rows.find((row) => row.dataset.joinRequestId === id)!
    expect(byId('join-1').querySelector('[data-testid="group-join-request-accept"]')).not.toBeNull()
    expect(byId('join-2').textContent).toContain('已同意')
    expect(byId('join-3').textContent).toContain('已拒绝')
    for (const id of ['join-2', 'join-3']) expect(byId(id).querySelector('button')).toBeNull()
    expect(groupTab()!.querySelector('.gg-segtab-badge')?.textContent).toBe('1')
  })

  it('替别人拉 Agent 的申请:说明行写的是谁要把 Agent 拉进哪个群', async () => {
    await renderWithAppProviders(harness, createNode(NewFriendsPanel, {}), {
      chat: { identitiesById: {
        'agent-1': displayIdentity('agent-1', { type: 'agent', display_name: '写代码的' }),
        'member-1': displayIdentity('member-1', { display_name: '成员乙' }),
      } },
      contacts: { groupJoinRequests: [joinRequest({ requester_user_id: 'agent-1', requester_type: 'agent', requested_by_user_id: 'member-1', message: null })] },
    })
    await clickElement(groupTab()!)
    expect(joinRow()?.textContent).toContain('写代码的')
    expect(joinRow()?.textContent).toContain('成员乙 申请把这个 Agent 拉进「产品组」')
  })
})
