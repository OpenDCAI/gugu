import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentPresenceState } from '@/lib/agentPresenceStore'
import type { AgentStatusDetail } from '@gugu/core/shared/agentStatus'
const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }))
vi.mock('@/lib/supabase', () => ({
  dataClient: {
    schema: vi.fn(() => ({ rpc: rpcMock })),
  },
}))
import {
  getAgentPresenceSnapshot,
  recheckUnseenAgentPresence,
  refreshObservedAgentPresenceFromRevision,
  setLocalAgentStatus,
  setPresenceBusContext,
  type LocalAgentStatus,
  subscribeAgentPresence,
} from '@/lib/agentPresenceStore'
// @@@3841 批量 RPC 之后 data 的形状是 `{ results: { <id>: { status, presence } } }`。
const payload = (
  accountStatus: 'active' | 'removed',
  updatedAt: string,
  extra: Record<string, unknown> = {},
) => ({
  results: {
    'agent-1': {
      status: 'presence',
      presence: {
        agent_user_id: 'agent-1',
        account_status: accountStatus,
        runtime_status: accountStatus === 'removed' ? 'offline' : 'online',
        activity_status: 'idle',
        updated_at: updatedAt,
        ...extra,
      },
    },
  },
})
function answerAll(_method: string, args: { p_agent_user_ids: string[] }) {
  const result = payload('active', '2026-08-15T00:00:01Z').results['agent-1']
  return Promise.resolve({
    data: { results: Object.fromEntries(args.p_agent_user_ids.map((id) => [id, {
      ...result, presence: { ...result.presence, agent_user_id: id },
    }])) }, error: null,
  })
}
/** 本机宿主按 agent 的流里的一条(这台机器就是 agent-1 的宿主)。 */
const local = (
  status: 'idle' | 'working' | 'needs_user' | 'error',
  detail: AgentStatusDetail | null = null,
  life: LocalAgentStatus['life'] = null,
): LocalAgentStatus => ({
  sessionId: 'conversation-1',
  reading: { status, detail, running: status === 'working' || status === 'needs_user', background: null },
  unseen: status !== 'working',
  reviewGate: null,
  providerBlocker: null,
  statusSourceFault: null,
  life,
})
async function settle(): Promise<void> {
  await vi.dynamicImportSettled()
}
// #3839 presence 缓存按**账号**划界,并且刻意地跨视图卸载存活 —— 所以每条判据必须自建它自己的
// 账号边界。沿用同一个身份会让上一条判据留下的 entry 变成下一条的隐式前置(实测:留下的 removed
// 终态会让下一条读到它自己从没写过的 payload,而且不报错,只是安静地答错)。
let testAccountSeq = 0
beforeEach(() => {
  rpcMock.mockReset()
  setPresenceBusContext({ currentUserId: `owner-${++testAccountSeq}` })
})
describe('agent presence revision routing', () => {
  it('fetches only changed observed agents, once per id, without creating unknown entries', async () => {
    rpcMock.mockImplementation(answerAll)
    const offOne = subscribeAgentPresence('agent-1', () => undefined)
    const offTwo = subscribeAgentPresence('agent-2', () => undefined)
    try {
      await settle()
      rpcMock.mockClear()
      await refreshObservedAgentPresenceFromRevision([
        { agent_user_id: 'agent-1' }, { agent_user_id: 'agent-1' }, { agent_user_id: 'unknown' },
      ])
      expect(rpcMock).toHaveBeenCalledExactlyOnceWith('get_agent_presence_batch', { p_agent_user_ids: ['agent-1'] })
      expect(getAgentPresenceSnapshot('unknown')).toBeNull()
    } finally { offOne(); offTwo() }
  })

  it('splits more than 200 changed observed agents without omitting any id', async () => {
    rpcMock.mockImplementation(answerAll)
    const ids = Array.from({ length: 205 }, (_, i) => `changed-${i}`)
    const offs = ids.map((id) => subscribeAgentPresence(id, () => undefined))
    try {
      await settle()
      rpcMock.mockClear()
      await refreshObservedAgentPresenceFromRevision(ids.map((id) => ({ agent_user_id: id })))
      expect(rpcMock).toHaveBeenCalledTimes(2)
      const asked = rpcMock.mock.calls.flatMap((call) => call[1].p_agent_user_ids as string[])
      expect(asked.sort()).toEqual([...ids].sort())
      for (const call of rpcMock.mock.calls) expect(call[1].p_agent_user_ids.length).toBeLessThanOrEqual(200)
    } finally { for (const off of offs) off() }
  })

  it.each([null, [], {}, { agent_user_id: '' }, { agent_user_id: ' ' }, { agent_user_id: 1 }].map((raw) => ({ raw })))(
    'rejects malformed revision payload $raw before requesting a snapshot', async ({ raw }) => {
      await expect(refreshObservedAgentPresenceFromRevision([raw])).rejects.toThrow('requires agent_user_id')
      expect(rpcMock).not.toHaveBeenCalled()
    },
  )

  it('marks only the changed cooled entry dirty and refreshes it on re-entry', async () => {
    rpcMock.mockImplementation(answerAll)
    const offOne = subscribeAgentPresence('agent-1', () => undefined)
    const offTwo = subscribeAgentPresence('agent-2', () => undefined)
    await settle()
    offOne(); offTwo(); rpcMock.mockClear()
    await refreshObservedAgentPresenceFromRevision([{ agent_user_id: 'agent-1' }])
    expect(rpcMock).not.toHaveBeenCalled()
    const offUnchanged = subscribeAgentPresence('agent-2', () => undefined)
    await settle()
    expect(rpcMock).not.toHaveBeenCalled()
    const offChanged = subscribeAgentPresence('agent-1', () => undefined)
    try {
      await settle()
      expect(rpcMock).toHaveBeenCalledExactlyOnceWith('get_agent_presence_batch', { p_agent_user_ids: ['agent-1'] })
    } finally { offUnchanged(); offChanged() }
  })

  it.each([true, false])('does not let an older in-flight snapshot consume a change (observed=%s)', async (observed) => {
    let finish!: (value: { data: ReturnType<typeof payload>; error: null }) => void
    rpcMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
      .mockResolvedValueOnce({ data: payload('active', '2026-08-15T00:00:02Z', { activity_status: 'running' }), error: null })
    const off = subscribeAgentPresence('agent-1', () => undefined)
    await settle()
    if (!observed) off()
    const refresh = refreshObservedAgentPresenceFromRevision([{ agent_user_id: 'agent-1' }])
    expect(rpcMock).toHaveBeenCalledTimes(1)
    finish({ data: payload('active', '2026-08-15T00:00:01Z'), error: null })
    await refresh
    let offAgain: (() => void) | undefined
    try {
      if (!observed) {
        expect(rpcMock).toHaveBeenCalledTimes(1)
        offAgain = subscribeAgentPresence('agent-1', () => undefined)
        await settle()
      }
      expect(rpcMock).toHaveBeenCalledTimes(2)
      expect(getAgentPresenceSnapshot('agent-1')?.payload?.activityStatus).toBe('running')
    } finally { off(); offAgain?.() }
  })

  it('rejects a failed changed-agent snapshot so the coordinator can retry', async () => {
    rpcMock.mockResolvedValueOnce({ data: payload('active', '2026-08-15T00:00:01Z'), error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'snapshot failed' } })
      .mockResolvedValueOnce({ data: payload('active', '2026-08-15T00:00:02Z', { activity_status: 'running' }), error: null })
    const off = subscribeAgentPresence('agent-1', () => undefined)
    try {
      await settle()
      await expect(refreshObservedAgentPresenceFromRevision([{ agent_user_id: 'agent-1' }])).rejects.toThrow('snapshot failed')
      await refreshObservedAgentPresenceFromRevision([{ agent_user_id: 'agent-1' }])
      expect(getAgentPresenceSnapshot('agent-1')?.payload?.activityStatus).toBe('running')
    } finally { off() }
  })

  it('a wake refetches the visible agent; unsubscribing keeps the observed fact', async () => {
    rpcMock
      .mockResolvedValueOnce({ data: payload('active', '2026-08-15T00:00:01Z'), error: null })
      .mockResolvedValueOnce({ data: payload('active', '2026-08-15T00:00:02Z', { activity_status: 'running' }), error: null })
    const states: AgentPresenceState[] = []
    const unsubscribe = subscribeAgentPresence('agent-1', (state) => states.push(state))
    await settle()
    await refreshObservedAgentPresenceFromRevision([{ agent_user_id: 'agent-1' }])
    expect(rpcMock).toHaveBeenCalledTimes(2)
    expect(states.at(-1)?.payload?.activityStatus).toBe('running')
    unsubscribe()
    // #3839 退订不再抹掉已观测到的事实:这里原本断言 `toBeNull()`,那句话把「谁在看」和「我知道
    // 什么」绑成了一件事,正是切 tab 会重放「确认中」的根子。视图卸载只是没人看了,不是没发生过。
    const retained = getAgentPresenceSnapshot('agent-1')
    expect(retained?.payload?.activityStatus).toBe('running')
    expect(retained?.status).not.toBe('pending')
  })
  it('keeps removed terminal when a delayed active snapshot arrives later', async () => {
    rpcMock
      .mockResolvedValueOnce({ data: payload('removed', '2026-08-15T00:00:02Z'), error: null })
      .mockResolvedValueOnce({ data: payload('active', '2026-08-15T00:00:03Z'), error: null })
    const unsubscribe = subscribeAgentPresence('agent-1', () => undefined)
    await settle()
    await refreshObservedAgentPresenceFromRevision([{ agent_user_id: 'agent-1' }])
    expect(getAgentPresenceSnapshot('agent-1')?.status).toBe('removed')
    expect(getAgentPresenceSnapshot('agent-1')?.payload?.accountStatus).toBe('removed')
    unsubscribe()
  })
  it('the local host reading drives the display: needs you, then idle; removed wins over a stale local entry', async () => {
    rpcMock.mockResolvedValueOnce({
      data: payload('active', '2026-08-15T00:00:05Z', {
        device_id: 'device-1',
        device_status: 'online',
        device_last_seen_at: new Date().toISOString(),
        desired_status: 'online',
      }),
      error: null,
    })
    const unsubscribe = subscribeAgentPresence('agent-1', () => undefined)
    await settle()
    setLocalAgentStatus('agent-1', local('needs_user', 'approval'))
    expect(getAgentPresenceSnapshot('agent-1')?.status).toBe('needs_user')
    expect(getAgentPresenceSnapshot('agent-1')?.reading).toEqual({ status: 'needs_user', detail: 'approval' })
    // 单个 agent 的那一句按它在等什么写(与会话页、手机同一个 presentAgentStatus)。
    expect(getAgentPresenceSnapshot('agent-1')?.presentation).toMatchObject({ tone: 'needs_user', label: 'needsApproval' })
    setLocalAgentStatus('agent-1', local('idle', 'done'))
    expect(getAgentPresenceSnapshot('agent-1')?.status).toBe('idle')
    // 聊天侧没有「未读」这一轴:做完、可达 = 在线,不加粗。
    expect(getAgentPresenceSnapshot('agent-1')?.presentation).toMatchObject({ tone: 'online', label: 'online', emphasis: false })
    setLocalAgentStatus('agent-1', local('needs_user', 'question'))

    rpcMock.mockResolvedValueOnce({ data: payload('removed', '2026-08-15T00:00:06Z'), error: null })
    await refreshObservedAgentPresenceFromRevision([{ agent_user_id: 'agent-1' }])
    expect(getAgentPresenceSnapshot('agent-1')?.status, '终态必须压过陈旧的本机条目').toBe('removed')

    setLocalAgentStatus('agent-1', null)
    expect(getAgentPresenceSnapshot('agent-1')?.status).toBe('removed')
    unsubscribe()
  })
  // #6310 the chat avatar reads the same written status as the session page's red dot.
  it('shows the host-written error and clears it on the next reading; removed still wins', async () => {
    rpcMock.mockResolvedValueOnce({
      data: payload('active', '2026-08-15T00:00:05Z', {
        device_id: 'device-1',
        device_status: 'online',
        device_last_seen_at: new Date().toISOString(),
        desired_status: 'online',
      }),
      error: null,
    })
    const unsubscribe = subscribeAgentPresence('agent-1', () => undefined)
    try {
      await settle()
      expect(getAgentPresenceSnapshot('agent-1')?.status).toBe('idle')
      setLocalAgentStatus('agent-1', local('error'))
      expect(getAgentPresenceSnapshot('agent-1')?.status, 'task page shows red ⇒ chat avatar shows error').toBe('error')
      setLocalAgentStatus('agent-1', local('idle', 'plain'))
      expect(getAgentPresenceSnapshot('agent-1')?.status).toBe('idle')
      setLocalAgentStatus('agent-1', local('error'))
      rpcMock.mockResolvedValueOnce({ data: payload('removed', '2026-08-15T00:00:06Z'), error: null })
      await refreshObservedAgentPresenceFromRevision([{ agent_user_id: 'agent-1' }])
      expect(getAgentPresenceSnapshot('agent-1')?.status).toBe('removed')
    } finally {
      unsubscribe()
    }
  })
  it('a session-life session shows its lifecycle first: starting, failed, archived, then the activity', async () => {
    rpcMock.mockResolvedValueOnce({
      data: payload('active', '2026-08-15T00:00:05Z', {
        device_id: 'device-1',
        device_status: 'online',
        device_last_seen_at: new Date().toISOString(),
        desired_status: 'online',
      }),
      error: null,
    })
    const unsubscribe = subscribeAgentPresence('agent-1', () => undefined)
    try {
      await settle()
      const stage = { at: 'cli', index: 4, total: 7, since: 1 } as const
      setLocalAgentStatus('agent-1', local('working', 'running', { kind: 'starting', stage }))
      expect(getAgentPresenceSnapshot('agent-1')?.status).toBe('starting')
      expect(getAgentPresenceSnapshot('agent-1')?.presentation).toMatchObject({ tone: 'starting', label: 'starting', animate: false })
      setLocalAgentStatus('agent-1', local('idle', 'plain', { kind: 'failed', stage: null }))
      expect(getAgentPresenceSnapshot('agent-1')?.status, 'failed start is an error').toBe('error')
      setLocalAgentStatus('agent-1', local('idle', 'plain', { kind: 'archived', stage: null }))
      expect(getAgentPresenceSnapshot('agent-1')?.status).toBe('archived')
      setLocalAgentStatus('agent-1', local('needs_user', 'approval', { kind: 'ready', stage: null }))
      expect(getAgentPresenceSnapshot('agent-1')?.presentation).toMatchObject({ tone: 'needs_user', label: 'needsApproval' })
    } finally {
      unsubscribe()
    }
  })
  // 别的设备、群里的别人:这台机器不是宿主,读云端那一行上的读数;本机有条目时读本机的,❌ 两条比版本。
  it('reads the cloud reading when this machine is not the host, and the local entry when it is', async () => {
    rpcMock.mockResolvedValueOnce({
      data: payload('active', '2026-08-15T00:00:05Z', {
        device_id: 'device-1',
        device_status: 'online',
        desired_status: 'online',
        activity_status: 'running',
        agent_status: 'needs_user',
        agent_status_detail: 'approval',
      }),
      error: null,
    })
    const unsubscribe = subscribeAgentPresence('agent-1', () => undefined)
    try {
      await settle()
      expect(getAgentPresenceSnapshot('agent-1')?.status, '别处也看得到「等你批准」').toBe('needs_user')
      expect(getAgentPresenceSnapshot('agent-1')?.presentation.label).toBe('needsApproval')
      expect(getAgentPresenceSnapshot('agent-1')?.local).toBeNull()
      setLocalAgentStatus('agent-1', local('working', 'running'))
      expect(getAgentPresenceSnapshot('agent-1')?.status).toBe('working')
      setLocalAgentStatus('agent-1', null)
      expect(getAgentPresenceSnapshot('agent-1')?.status).toBe('needs_user')
    } finally {
      unsubscribe()
    }
  })
  it('an old host that writes no reading still reads through its running/idle projection', async () => {
    rpcMock.mockResolvedValueOnce({
      data: payload('active', '2026-08-15T00:00:05Z', {
        device_id: 'device-1',
        device_status: 'online',
        desired_status: 'online',
        activity_status: 'running',
      }),
      error: null,
    })
    const unsubscribe = subscribeAgentPresence('agent-1', () => undefined)
    try {
      await settle()
      expect(getAgentPresenceSnapshot('agent-1')?.reading).toBeNull()
      expect(getAgentPresenceSnapshot('agent-1')?.status).toBe('working')
    } finally {
      unsubscribe()
    }
  })
  // 在不在线只看设备行与 owner 意图;载荷里的 runtime_status / derived_status(老后端还会带)一律不读。
  it('ignores runtime_status and derived_status: a reachable device with desired online is online', async () => {
    rpcMock.mockResolvedValueOnce({
      data: payload('active', '2026-08-15T00:00:04Z', {
        runtime_status: 'online',
        derived_status: 'offline',
        desired_status: 'online',
        device_id: 'device-1',
        device_status: 'online',
        device_last_seen_at: new Date().toISOString(),
      }),
      error: null,
    })
    const unsubscribe = subscribeAgentPresence('agent-1', () => undefined)
    await settle()
    const state = getAgentPresenceSnapshot('agent-1')
    expect(state?.payload).not.toHaveProperty('derivedStatus')
    expect(state?.status).toBe('idle')
    unsubscribe()
  })
})

// gugu-dev#181 80e:看不到一个 agent 只是那一刻的事 —— 它审批过后进了我在的群,成员变化一到就重问,状态(含类型)拿得到。
describe('an agent this viewer could not see', () => {
  it('is asked again when a chat of mine changes members, and is seen once it is visible', async () => {
    rpcMock.mockResolvedValue({ data: { results: { 'agent-1': { status: 'unauthorized' } } }, error: null })
    const off = subscribeAgentPresence('agent-1', () => undefined)
    try {
      await settle()
      expect(getAgentPresenceSnapshot('agent-1')?.error).toBeTruthy()
      expect(getAgentPresenceSnapshot('agent-1')?.payload ?? null).toBeNull()
      rpcMock.mockImplementation(answerAll)
      await recheckUnseenAgentPresence(['agent-1'])
      await settle()
      expect(getAgentPresenceSnapshot('agent-1')?.error ?? null).toBeNull()
      expect(getAgentPresenceSnapshot('agent-1')?.payload?.agentUserId).toBe('agent-1')
    } finally {
      off()
    }
  })

  it('an agent already seen is not asked again on every member change (read watermarks move all the time)', async () => {
    rpcMock.mockImplementation(answerAll)
    const off = subscribeAgentPresence('agent-1', () => undefined)
    try {
      await settle()
      rpcMock.mockClear()
      await recheckUnseenAgentPresence(['agent-1', 'someone-else'])
      expect(rpcMock).not.toHaveBeenCalled()
    } finally {
      off()
    }
  })
})
