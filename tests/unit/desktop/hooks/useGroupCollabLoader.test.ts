// @vitest-environment jsdom
import { act, createElement, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import type { AccountRevisionListener } from '../../../../apps/desktop/src/lib/accountRevisionCoordinator'
import type { GroupCollabSnapshot } from '@gugu/core/shared/types/chat'
const readGroupRoster = vi.fn()
const replaceGroupRoster = vi.fn().mockResolvedValue(undefined)
const getGroupCollab = vi.fn()
vi.mock('../../../../apps/desktop/src/lib/imRepository', () => ({
  readGroupRoster,
  replaceGroupRoster,
  persistableGroupRoster: (_chatId: string, value: GroupCollabSnapshot) => value,
}))
class GroupCollabEmptyError extends Error {}
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({
  chatService: { getGroupCollab },
  GroupCollabEmptyError,
}))
const { useGroupCollabLoader, EMPTY_GROUP_COLLAB } = await import('../../../../apps/desktop/src/hooks/useGroupCollabLoader')
const { useRoomCollab } = await import('../../../../apps/desktop/src/hooks/useRoomCollab')
const snapshot: GroupCollabSnapshot = {
  scheduler: { chat_id: 'group-1', paused: false, queue_count: 0, blocked_count: 0, summary: null, updated_at: new Date(0).toISOString() },
  humans: [{ id: 'owner-1', role: 'owner', type: 'human', account_status: null }],
  agents: [{ id: 'agent-1', role: 'member', type: 'agent', account_status: null, client: null, model_source: null, tools: [], permission_scope: null, current_task_id: null, current_task_title: null, last_action: null, last_active_at: null, listen_mode: 'active' }],
  tasks: [],
  outputs: [],
}
let load: (() => Promise<void>) | undefined
let chatKind: string | undefined
let activeChatId: string | undefined
let currentError: 'not-participant' | 'failed' | null
let published: GroupCollabSnapshot[]
function Probe() {
  const cacheRef = useRef(new Map<string, GroupCollabSnapshot>())
  const result = useGroupCollabLoader({
    activeChatId,
    isRoomChat: true,
    chatKind,
    userId: 'owner-1',
    getImRepository: async () => ({ accountId: 'owner-1', snapshot: () => ({ membership: [] }), transaction: vi.fn() } as never),
    setGroupCollabSnapshot: (next) => {
      const value = typeof next === 'function' ? next(EMPTY_GROUP_COLLAB) : next
      published.push(value)
    },
    groupRosterMemoryCacheRef: cacheRef,
  })
  load = result.loadGroupCollab
  currentError = result.error
  return null
}
describe('useGroupCollabLoader authoritative publication', () => {
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(async () => {
    published = []
    chatKind = undefined
    activeChatId = 'group-1'
    readGroupRoster.mockReset().mockReturnValue(null)
    getGroupCollab.mockReset().mockResolvedValue({ snapshot, identities: [] })
    replaceGroupRoster.mockReset().mockResolvedValue(undefined)
    harness = createReactHarness()
    await harness.render(createElement(Probe))
  })
  afterEach(() => {
    harness.cleanup()
    vi.useRealTimers()
  })
  it('continues authoritative publication when no cached roster version is available', async () => {
    await act(async () => { await load?.() })
    expect(getGroupCollab).toHaveBeenCalledWith('group-1')
    expect(published.at(-1)?.humans.map((member) => member.id)).toEqual(['owner-1'])
    expect(published.at(-1)?.agents.map((member) => member.id)).toEqual(['agent-1'])
  })
  // @@@5856 找茬第九轮:「看得见这条话题但还不是参与者」是 spec 明文允许的**稳态**,不是 RLS 抖动。
  // 当成抖动的代价是 30 次全量快照读、跨约 16 秒,末尾落一条 console.error —— 而屏幕上那句
  // 「关掉再打开一次」重开多少次都一样。
  it('话题里空名册是结论不是故障:不重试、不报错', async () => {
    chatKind = 'topic'
    await harness.render(createElement(Probe))
    getGroupCollab.mockReset().mockRejectedValue(new GroupCollabEmptyError('empty'))
    // 退避窗口用假时钟快进,不真睡 12s:这里断言的是「窗口里排没排重试」,不是墙钟 ——
    // 两条真睡曾让本文件独占 24s,是单测分片墙钟的下限(#6270)。
    vi.useFakeTimers()
    const errors: unknown[][] = []
    const realError = console.error
    console.error = (...args: unknown[]) => { errors.push(args) }
    try {
      await act(async () => { await load?.() })
      expect(errors, '空名册不是错误,不许上报').toEqual([])
      // 后台退避重试最长一档也在 10s 以内;等过它再看:调用次数必须还是 1(❌ 没有排队重试)。
      await act(async () => { await vi.advanceTimersByTimeAsync(12_000) })
      expect(getGroupCollab, '空名册不许排后台退避重试').toHaveBeenCalledTimes(1)
    } finally {
      console.error = realError
    }
  })

  it('群里名册 0 行只能是故障:照实报错', async () => {
    chatKind = 'group'
    await harness.render(createElement(Probe))
    getGroupCollab.mockReset().mockRejectedValue(new GroupCollabEmptyError('empty'))
    const errors: unknown[][] = []
    const realError = console.error
    console.error = (...args: unknown[]) => { errors.push(args) }
    try {
      await act(async () => { await load?.() })
      expect(errors.length, '群的空名册要报出来').toBeGreaterThan(0)
      expect(getGroupCollab).toHaveBeenCalledTimes(1)
    } finally {
      console.error = realError
    }
  })

  it('读失败:留着缓存的名册、照实报错,❌ 后台退避重试(下一条成员 / 修订事件再读)', async () => {
    readGroupRoster.mockReturnValue(snapshot)
    getGroupCollab.mockReset().mockRejectedValue(new Error('boom'))
    vi.useFakeTimers()
    const errors: unknown[][] = []
    const realError = console.error
    console.error = (...args: unknown[]) => { errors.push(args) }
    try {
      await act(async () => { await load?.() })
      await act(async () => { await vi.advanceTimersByTimeAsync(12_000) })
      expect(getGroupCollab).toHaveBeenCalledTimes(1)
      // 缓存那份已经画上去,失败没有把它换成空的。
      expect(published.at(-1)?.humans.map((member) => member.id)).toEqual(['owner-1'])
      expect(errors.length, '读失败要报出来').toBeGreaterThan(0)
    } finally {
      console.error = realError
    }
  })

  it('keeps malformed repository reads loud and does not fall through to cloud', async () => {
    readGroupRoster.mockImplementationOnce(() => { throw new Error('malformed membership row') })
    await act(async () => { await load?.() })
    expect(getGroupCollab).not.toHaveBeenCalled()
    expect(published).toEqual([])
  })

  it('does not replace a warm authoritative snapshot with the reduced disk roster while refreshing', async () => {
    const rich = { ...snapshot, agents: snapshot.agents.map((agent) => ({ ...agent, client: 'Codex', model_source: 'Luna' })) }
    getGroupCollab.mockResolvedValueOnce({ snapshot: rich, identities: [] })
    await act(async () => { await load?.() })
    published = []
    readGroupRoster.mockReturnValue(snapshot)
    let resolve!: (value: { snapshot: GroupCollabSnapshot; identities: [] }) => void
    getGroupCollab.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    let refreshing!: Promise<void>
    await act(async () => { refreshing = load!(); await Promise.resolve() })
    expect(published).toEqual([])
    await act(async () => { resolve({ snapshot: rich, identities: [] }); await refreshing })
    expect(published.at(-1)?.agents[0]?.model_source).toBe('Luna')
  })

  it('does not attribute the previous chat failure to a new chat before its effects run', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    getGroupCollab.mockRejectedValueOnce(new Error('unavailable'))
    await act(async () => { await load?.() })
    expect(currentError!).toBe('failed')
    activeChatId = 'group-2'
    await harness.render(createElement(Probe))
    expect(currentError!).toBeNull()
    activeChatId = undefined
    await harness.render(createElement(Probe))
    expect(currentError!).toBeNull()
  })
})

describe('topic conversation owns the member drawer roster', () => {
  let harness: ReturnType<typeof createReactHarness>
  let listener: AccountRevisionListener | undefined
  let room: ReturnType<typeof useRoomCollab>
  function Room() { room = useRoomCollab('group-1', 'topic'); return null }
  beforeEach(async () => {
    readGroupRoster.mockReset().mockReturnValue(null)
    replaceGroupRoster.mockReset().mockResolvedValue(undefined)
    getGroupCollab.mockReset().mockResolvedValue({ snapshot, identities: [] })
    harness = createReactHarness()
    await renderWithAppProviders(harness, createElement(Room), { auth: { id: 'owner-1' }, chat: {
      getImRepository: async () => ({ accountId: 'owner-1' }) as never,
      subscribeAccountRevision: (_event, next) => { listener = next; return () => { listener = undefined } },
    } })
  })
  afterEach(() => harness.cleanup())
  it('refreshes only for this topic membership revision and keeps the prior data on refresh failure', async () => {
    expect(room!.snapshot?.humans[0]?.id).toBe('owner-1')
    const before = getGroupCollab.mock.calls.length
    await act(async () => { listener!([{ revision: '1', event: 'chat_members_changed', payload: { chat_id: 'other-topic' } }]) })
    expect(getGroupCollab).toHaveBeenCalledTimes(before)
    getGroupCollab.mockRejectedValueOnce(new Error('network unavailable'))
    await act(async () => { listener!([{ revision: '2', event: 'chat_members_changed', payload: { chat_id: 'group-1' } }]) })
    expect(getGroupCollab).toHaveBeenCalledTimes(before + 1)
    expect(room!.snapshot?.humans[0]?.id).toBe('owner-1')
    expect(room!.error).toBe('failed')
  })
})
