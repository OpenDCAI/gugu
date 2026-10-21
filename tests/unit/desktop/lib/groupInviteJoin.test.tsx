// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  directJoin: vi.fn(),
  requestJoin: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock('../../../../apps/desktop/src/lib/contacts', () => ({
  contactsService: {
    joinPublicGroup: mocks.directJoin,
    requestGroupJoin: mocks.requestJoin,
  },
  GroupJoinRefusedError: class GroupJoinRefusedError extends Error {
    constructor(public readonly reason: 'invite_only' | 'invite_link_closed') {
      super(reason)
    }
  },
}))
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({
  useChatStore: () => ({ refreshChats: mocks.refresh }),
}))

import {
  GroupInviteJoinUnavailableError,
  joinGroupByInvite,
  useGroupInviteJoin,
  type GroupInviteJoinGroup,
  type GroupInviteJoinState,
} from '../../../../apps/desktop/src/lib/groupInviteJoin'

function group(overrides: Partial<GroupInviteJoinGroup> = {}): GroupInviteJoinGroup {
  return {
    public_id: 778899,
    join_mode: 'open',
    is_member: false,
    join_request_status: null,
    invite_link_enabled: true,
    ...overrides,
  }
}

describe('joinGroupByInvite (#3303)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('open 群只走 join_public_group，approval 群只走 request_group_join', async () => {
    mocks.directJoin.mockResolvedValue({ status: 'joined', group: group({ is_member: true }) })
    mocks.requestJoin.mockResolvedValue({ status: 'pending', group: group({ join_mode: 'approval', join_request_status: 'pending' }) })

    await expect(joinGroupByInvite(group(), ' token ')).resolves.toMatchObject({ status: 'joined' })
    await expect(joinGroupByInvite(group({ join_mode: 'approval' }), ' token ')).resolves.toMatchObject({ status: 'pending' })

    expect(mocks.directJoin).toHaveBeenCalledTimes(1)
    expect(mocks.directJoin).toHaveBeenCalledWith(778899, 'token')
    expect(mocks.requestJoin).toHaveBeenCalledTimes(1)
    expect(mocks.requestJoin).toHaveBeenCalledWith(778899, 'token')
  })

  it.each([
    ['already_joined', { is_member: true }],
    ['pending', { join_request_status: 'pending' as const }],
    ['invite_only', { join_mode: 'invite_only' as const }],
    ['invite_link_closed', { invite_link_enabled: false }],
  ])('%s 在 RPC 前即拒绝', async (code, overrides) => {
    await expect(joinGroupByInvite(group(overrides), 'token')).rejects.toMatchObject({ code })
    expect(mocks.directJoin).not.toHaveBeenCalled()
    expect(mocks.requestJoin).not.toHaveBeenCalled()
  })

  it.each([
    ['invite_only' as const],
    ['invite_link_closed' as const],
  ])('快照过时:服务端拒成 %s ⇒ 与前置拒绝同一种结果', async (reason) => {
    const { GroupJoinRefusedError } = await import('../../../../apps/desktop/src/lib/contacts')
    mocks.directJoin.mockRejectedValue(new GroupJoinRefusedError(reason))
    await expect(joinGroupByInvite(group(), 'token')).rejects.toMatchObject({ code: reason })
  })

  it('其余失败原样上抛(正对照:不是一切错误都被翻成「仅邀请」)', async () => {
    const boom = new Error('network down')
    mocks.directJoin.mockRejectedValue(boom)
    await expect(joinGroupByInvite(group(), 'token')).rejects.toBe(boom)
  })

  it('空 token fail loud 且不发 RPC', async () => {
    await expect(joinGroupByInvite(group(), '  ')).rejects.toBeInstanceOf(GroupInviteJoinUnavailableError)
    expect(mocks.directJoin).not.toHaveBeenCalled()
    expect(mocks.requestJoin).not.toHaveBeenCalled()
  })
})

describe('useGroupInviteJoin (#3303)', () => {
  let container: HTMLDivElement
  let root: Root
  let current: GroupInviteJoinState

  function Harness() {
    current = useGroupInviteJoin()
    return null
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root.render(createElement(Harness)) })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('只在 joined 后刷新群列表；pending 不刷新', async () => {
    mocks.directJoin.mockResolvedValue({ status: 'joined', group: group({ is_member: true }) })
    await act(async () => { await current.join(group(), 'token') })
    expect(mocks.refresh).toHaveBeenCalledTimes(1)

    mocks.requestJoin.mockResolvedValue({ status: 'pending', group: group({ join_mode: 'approval', join_request_status: 'pending' }) })
    await act(async () => { await current.join(group({ join_mode: 'approval' }), 'token') })
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
  })

  it('把 RPC 失败收敛成同一条可展示错误，同时保留原始异常', async () => {
    const originalError = new Error('群已满员')
    mocks.directJoin.mockRejectedValue(originalError)

    let thrown: unknown
    await act(async () => {
      try {
        await current.join(group(), 'token')
      } catch (error) {
        thrown = error
      }
    })

    expect(current.joinError).toContain('群已满员')
    expect(thrown).toMatchObject({ message: current.joinError, originalError })
  })
})
