import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentPresenceState } from '@/lib/agentPresenceStore'
import { readPerfCounters } from '@/lib/perfCounters'
// #3841 (#3839 的 E) —— 冷启动的 N 次往返收成一次。
// 这一层判的是产品 e2e 判不了的那几条:一次 tick 里到底发了几次 RPC、三种结局有没有被压成一个、
// 契约被破坏时会不会 fail loud、超上限是分块还是截断。
//
// ⚠️ 这条改动是**客户端 ↔ 数据库的契约变更**,合并前无法对 devdb 自测(DDL 只能由
// deploy-migrations 施加)。所以这一层必须把能在本地判的都判掉,合并后再补真库读数。
const { rpcMock, ipcMock, logErrorMock, host } = vi.hoisted(() => ({ rpcMock: vi.fn(), ipcMock: vi.fn(), logErrorMock: vi.fn(), host: { enabled: false } }))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ error: logErrorMock }) }))
vi.mock('@/platform/desktopIpc', () => ({ desktopIpc: () => host.enabled ? { invoke: ipcMock } : null }))
vi.mock('@/lib/supabase', () => ({ dataClient: { schema: vi.fn(() => ({ rpc: rpcMock })) } }))
import {
  getAgentPresenceSnapshot,
  prewarmAgentPresence,
  setPresenceBusContext,
  setLocalAgentStatus,
  subscribeAgentPresence,
} from '@/lib/agentPresenceStore'
function presenceEntry(agentUserId: string, activityStatus = 'idle') {
  return {
    status: 'presence',
    presence: {
      agent_user_id: agentUserId,
      account_status: 'active',
      runtime_status: 'online',
      desired_status: 'online',
      activity_status: activityStatus,
      device_id: 'dev-1',
      device_status: 'online',
      device_last_seen_at: new Date().toISOString(),
      updated_at: '2026-08-21T00:00:00Z',
    },
  }
}
/** 让 mock 照着「问了哪些 id」作答 —— 判据不该预设调用方会问什么顺序、问几次。 */
function answerAll(build: (id: string) => unknown = (id) => presenceEntry(id)) {
  return (_name: string, args: { p_agent_user_ids?: string[] }) => {
    const results: Record<string, unknown> = {}
    for (const id of args.p_agent_user_ids ?? []) results[id] = build(id)
    return Promise.resolve({ data: { results }, error: null })
  }
}
async function settle(): Promise<void> {
  await vi.dynamicImportSettled()
}
let seq = 0
const openSubscriptions: Array<() => void> = []
function watch(agentUserId: string, listener: (state: AgentPresenceState) => void = () => undefined): () => void {
  const off = subscribeAgentPresence(agentUserId, listener)
  openSubscriptions.push(off)
  return off
}
beforeEach(() => {
  rpcMock.mockReset(); ipcMock.mockReset(); logErrorMock.mockReset(); host.enabled = false
  setPresenceBusContext({ currentUserId: `owner-${++seq}` })
})
afterEach(() => {
  while (openSubscriptions.length) openSubscriptions.pop()?.()
})
it('uses local holding for local contacts while leaving remote reachability and dormant sessions intact', async () => {
  host.enabled = true
  ipcMock.mockResolvedValue({ missing: 'unheld', dormant: 'held', sibling: 'held-elsewhere' })
  rpcMock.mockImplementation(answerAll())
  for (const id of ['missing', 'dormant', 'sibling', 'remote']) watch(id)
  await settle()
  expect(ipcMock).toHaveBeenCalledTimes(1)
  expect(getAgentPresenceSnapshot('missing')?.status).toBe('offline')
  expect(getAgentPresenceSnapshot('missing')?.deviceOnline).toBe(true)
  for (const id of ['dormant', 'sibling', 'remote']) expect(getAgentPresenceSnapshot(id)?.status).toBe('idle')
  ipcMock.mockResolvedValue({ missing: 'held' })
  setLocalAgentStatus('missing', { sessionId: 'restored', reading: null, unseen: false, reviewGate: null, providerBlocker: null, statusSourceFault: null, life: null })
  await settle()
  expect(getAgentPresenceSnapshot('missing')?.status).toBe('idle')
})
it('retains local and remote cloud presence and records the original error while the local host is not ready', async () => {
  host.enabled = true
  const error = new Error('Local agent host is not ready')
  ipcMock.mockRejectedValue(error)
  rpcMock.mockImplementation(answerAll(id => {
    const result = presenceEntry(id)
    if (id === 'remote') result.presence.device_id = 'remote-device'
    return result
  }))
  for (const id of ['local', 'remote']) watch(id)
  await settle()
  for (const id of ['local', 'remote']) {
    expect(getAgentPresenceSnapshot(id)?.payload?.agentUserId).toBe(id)
    expect(getAgentPresenceSnapshot(id)?.status).toBe('idle')
    expect(getAgentPresenceSnapshot(id)?.error).toBeNull()
  }
  expect(logErrorMock).toHaveBeenCalledExactlyOnceWith({ err: error }, 'Read local agent holding failed')
  expect(ipcMock).toHaveBeenCalledTimes(1)
})

describe('#3841 presence 批量快照', () => {
  it('同一 tick 的 N 个订阅合成一次 RPC —— 这就是这一票要买的东西', async () => {
    rpcMock.mockImplementation(answerAll())
    watch('b1')
    watch('b2')
    watch('b3')
    await settle()
    expect(rpcMock, '三个订阅只该换来一次往返').toHaveBeenCalledTimes(1)
    expect(rpcMock.mock.calls[0][0]).toBe('get_agent_presence_batch')
    expect([...(rpcMock.mock.calls[0][1] as { p_agent_user_ids: string[] }).p_agent_user_ids].sort())
      .toEqual(['b1', 'b2', 'b3'])
    for (const id of ['b1', 'b2', 'b3']) {
      expect(getAgentPresenceSnapshot(id)?.payload?.agentUserId, `${id} 必须真的拿到 payload`).toBe(id)
    }
  })
  it('预热与订阅落在同一 tick 时也合并,不是各走各的', async () => {
    rpcMock.mockImplementation(answerAll())
    prewarmAgentPresence(['c1', 'c2'])
    watch('c3')
    await settle()
    expect(rpcMock).toHaveBeenCalledTimes(1)
    expect([...(rpcMock.mock.calls[0][1] as { p_agent_user_ids: string[] }).p_agent_user_ids].sort())
      .toEqual(['c1', 'c2', 'c3'])
  })
  it('unauthorized 与 not_found 是两种结局,不许压成同一句话', async () => {
    rpcMock.mockImplementation((_name: string, args: { p_agent_user_ids: string[] }) => {
      const results: Record<string, unknown> = {}
      for (const id of args.p_agent_user_ids) {
        results[id] = id === 'd-unauth' ? { status: 'unauthorized' } : { status: 'not_found' }
      }
      return Promise.resolve({ data: { results }, error: null })
    })
    watch('d-unauth')
    watch('d-missing')
    await settle()
    const unauth = getAgentPresenceSnapshot('d-unauth')?.error ?? ''
    const missing = getAgentPresenceSnapshot('d-missing')?.error ?? ''
    expect(unauth, 'unauthorized 必须说出它是无权观察').toMatch(/viewable/i)
    expect(missing, 'not_found 必须说出它是不存在').toMatch(/not found/i)
    expect(unauth, '两种结局不得同形 —— 同形就等于把它们压成了一个').not.toBe(missing)
  })
  it('结果里少了问过的 id 是契约被破坏,fail loud,❌ 不许猜成 not_found', async () => {
    rpcMock.mockImplementation((_name: string, args: { p_agent_user_ids: string[] }) => {
      const results: Record<string, unknown> = {}
      // 只答第一个,把第二个静默略去 —— 正是服务端契约禁止的那种作答
      const [first] = args.p_agent_user_ids
      if (first) results[first] = presenceEntry(first)
      return Promise.resolve({ data: { results }, error: null })
    })
    watch('e1')
    watch('e2')
    await settle()
    expect(getAgentPresenceSnapshot('e1')?.payload?.agentUserId).toBe('e1')
    expect(getAgentPresenceSnapshot('e2')?.error ?? '', '被略去的 id 要报「批量漏了它」').toMatch(/omitted/i)
    expect(getAgentPresenceSnapshot('e2')?.error ?? '', '❌ 不许说成 not found').not.toMatch(/not found/i)
  })
  it('超过上限时分块,不截断 —— 每个 id 都必须被问到', async () => {
    const before = readPerfCounters()
    rpcMock.mockImplementation(answerAll())
    const ids = Array.from({ length: 205 }, (_, i) => `f${i}`)
    prewarmAgentPresence(ids)
    await settle()
    expect(rpcMock, '205 个 id 该分成两批').toHaveBeenCalledTimes(2)
    expect(readPerfCounters().presenceBatches - before.presenceBatches).toBe(2)
    expect(readPerfCounters().presenceIds - before.presenceIds).toBe(205)
    const asked = rpcMock.mock.calls.flatMap((call) => (call[1] as { p_agent_user_ids: string[] }).p_agent_user_ids)
    expect(new Set(asked).size, '一个都不许被丢掉').toBe(ids.length)
    expect(rpcMock.mock.calls[0][1].p_agent_user_ids.length, '单批不得超过服务端上限').toBeLessThanOrEqual(200)
  })
  it('RPC 整体报错时每个 waiter 都收到那条错误,不是只有第一个', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'boom' } })
    watch('g1')
    watch('g2')
    await settle()
    expect(getAgentPresenceSnapshot('g1')?.error).toBe('boom')
    expect(getAgentPresenceSnapshot('g2')?.error).toBe('boom')
  })
  it('响应形状不对时报错,而不是当成一批空结果安静落地', async () => {
    rpcMock.mockResolvedValue({ data: { nope: 1 }, error: null })
    watch('h1')
    await settle()
    expect(getAgentPresenceSnapshot('h1')?.error ?? '').toMatch(/Invalid agent presence batch/i)
  })
})
