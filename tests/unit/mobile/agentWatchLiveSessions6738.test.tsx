// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import type { SessionpageSessionSummary, SessionpageSessionsEvent } from '@gugu/session-core/session-record/contract'
import { createNode, createReactHarness, renderWithAppProviders } from '../../support/testHarness'

/**
 * #6738:时间线页头读的是壳根上那份会话列表(`useAgentWatchLiveSessions`)。那份列表的订阅**第一次列表失败**
 * (机器一时没应答,RPC 超时)之后原来整段吞掉、再不重试 ⇒ 这台机器没有 live 行,页头停在进页那一帧的快照上,
 * 整轮在跑页头却说「做完了」,停止键是红的(mac1 实测 115/204 秒不一致)。
 */
type PushHandler = (event: SessionpageSessionsEvent) => void
type SubscribeFn = (deviceId: string, subscriptionId: string) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  subscribeSessionsList: null as unknown as Mock<SubscribeFn>,
  unsubscribeSessionsList: null as unknown as Mock<SubscribeFn>,
  pushes: new Map<string, { deviceId: string; onEvent: PushHandler }>(),
  foreground: null as null | (() => void),
  current: {} as Record<string, SessionpageSessionSummary[]>,
}))

vi.mock('@/platform', () => ({
  platform: {
    systemPermissions: [],
    capabilities: { backgroundWatch: false },
    setBackgroundWatch: async () => undefined,
    subscribeAppForeground: (listener: () => void) => { mocks.foreground = listener; return () => { mocks.foreground = null } },
    showNotification: async () => ({ success: true, displayed: true }),
  },
}))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({
  subscribeSessionsList: (deviceId: string, subscriptionId: string) => mocks.subscribeSessionsList(deviceId, subscriptionId),
  unsubscribeSessionsList: (deviceId: string, subscriptionId: string) => mocks.unsubscribeSessionsList(deviceId, subscriptionId),
  onLinkChange: () => () => undefined,
  onAgentIdentity: () => () => undefined,
  subscribeSessionsListEvents: (deviceId: string, subscriptionId: string, onEvent: PushHandler) => {
    mocks.pushes.set(subscriptionId, { deviceId, onEvent })
    return () => { mocks.pushes.delete(subscriptionId) }
  },
}))

const { useAgentWatchAlerts } = await import('../../../apps/desktop/src/mobile/agent-watch/useAgentWatchAlerts')
const { useLiveDeviceSessions, retryDeviceSessions } = await import('../../../apps/desktop/src/session/shared/remote-sessions/session-directory')

const machine = (id: string) => ({ device_id: id, is_online: true, capabilities: {} }) as unknown as Device
const session = (agentStatus: string): SessionpageSessionSummary => ({
  conversationId: 'conversation-1',
  projectId: 'project-1',
  title: '大兴安岭行程',
  harness: 'claude',
  runtime: 'acp',
  agentStatus,
  lastInteractedAt: '2026-09-28T00:00:00.000Z',
  supported: true,
} as SessionpageSessionSummary)

let live: Record<string, SessionpageSessionSummary[] | undefined> = {}
function Root({ devices }: { devices: readonly Device[] }) {
  useAgentWatchAlerts(devices)
  // 页头读的是对过账的那份(本地底稿不算)。
  live = Object.fromEntries(Object.entries(useLiveDeviceSessions()).flatMap(([id, entry]) => (entry.cached ? [] : [[id, [...entry.sessions]]])))
  return null
}

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  mocks.pushes.clear()
  mocks.foreground = null
  mocks.current = {}
  // 假宿主:订上那一刻推一份整的(协议 8)。
  mocks.subscribeSessionsList = vi.fn<SubscribeFn>(async (deviceId, subscriptionId) => {
    mocks.pushes.get(subscriptionId)?.onEvent({ subscriptionId, full: { projects: [], sessions: mocks.current[deviceId] ?? [] } })
    return {}
  })
  mocks.unsubscribeSessionsList = vi.fn<SubscribeFn>(async () => ({}))
  live = {}
})
afterEach(() => {
  harness.cleanup()
  vi.useRealTimers()
})

const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0) })
const pushTo = (deviceId: string, sessions: SessionpageSessionSummary[]) => {
  for (const [subscriptionId, { deviceId: d, onEvent }] of mocks.pushes.entries()) {
    if (d === deviceId) onEvent({ subscriptionId, changed: sessions, removed: [] })
  }
}
const callsFor = (fn: Mock<SubscribeFn>, deviceId: string) =>
  (fn.mock.calls as unknown[][]).filter((call) => call[0] === deviceId).length

describe('壳根会话列表订阅:第一次列表失败之后(#6738)', () => {
  it('手机 Agent 宿主不订 workspace pipe，其他在线机器仍正常同步', async () => {
    vi.useFakeTimers()
    const phone = { ...machine('phone-1'), capabilities: { host_kind: 'phone', host_runtime_capability: 1, terminals: [], runtimes: [{ id: 'pi', available: true }] } } as unknown as Device
    mocks.current['machine-1'] = [session('idle')]
    await harness.render(createNode(Root, { devices: [phone, machine('machine-1')] }))
    await settle()
    expect(callsFor(mocks.subscribeSessionsList, 'phone-1')).toBe(0)
    expect(live['phone-1']).toBeUndefined()
    expect(callsFor(mocks.subscribeSessionsList, 'machine-1')).toBe(1)
    expect(live['machine-1']?.map((row) => row.agentStatus)).toEqual(['idle'])
  })

  it('退避后自己再订阅;live 行出现,之后的推送(只有变了的行)照样更新它', async () => {
    vi.useFakeTimers()
    mocks.current['machine-1'] = [session('idle')]
    mocks.subscribeSessionsList.mockRejectedValueOnce(new Error('Device RPC timed out after 12000ms (type=taskhost.call)'))
    await harness.render(createNode(Root, { devices: [machine('machine-1')] }))
    await settle()
    expect(live['machine-1'], 'the first subscription failed, so there is no live row yet').toBeUndefined()

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(mocks.subscribeSessionsList, 'subscribed again after the back-off').toHaveBeenCalledTimes(2)
    expect(live['machine-1']?.map((s) => s.agentStatus)).toEqual(['idle'])

    // 手机发了一句,机器写 working 并推过来:页头读的这份要跟着变。
    await act(async () => { pushTo('machine-1', [session('working')]) })
    expect(live['machine-1']?.map((s) => s.agentStatus)).toEqual(['working'])
  })
})

describe('回到前台:每台机器整个重订一次(#6738)', () => {
  it('项目页重试复用当前账号目标机器的同步器,换账号/离线/卸载后不能再重试旧连接', async () => {
    vi.useFakeTimers()
    await renderWithAppProviders(harness, createNode(Root, { devices: [machine('a'), machine('b')] }), { auth: { id: 'owner-a' } })
    await settle()
    await expect(retryDeviceSessions('owner-b', 'a')).rejects.toThrow('当前账号')
    await act(async () => { await retryDeviceSessions('owner-a', 'a'); await vi.advanceTimersByTimeAsync(0) })
    expect(callsFor(mocks.subscribeSessionsList, 'a')).toBe(2)
    expect(callsFor(mocks.subscribeSessionsList, 'b')).toBe(1)
    expect([...mocks.pushes.values()].filter(entry => entry.deviceId === 'a')).toHaveLength(1)
    expect([...mocks.pushes.values()].filter(entry => entry.deviceId === 'b')).toHaveLength(1)
    await renderWithAppProviders(harness, createNode(Root, { devices: [machine('a')] }), { auth: { id: 'owner-b' } })
    await settle()
    await expect(retryDeviceSessions('owner-a', 'a')).rejects.toThrow('当前账号')
    await expect(retryDeviceSessions('owner-a', 'b')).rejects.toThrow('当前账号')
    await renderWithAppProviders(harness, createNode(Root, { devices: [{ ...machine('a'), is_online: false }] }), { auth: { id: 'owner-b' } })
    await expect(retryDeviceSessions('owner-b', 'a')).rejects.toThrow('当前账号')
    expect(mocks.pushes.size).toBe(0)
    await renderWithAppProviders(harness, createNode(Root, { devices: [machine('b')] }), { auth: { id: 'owner-b' } })
    await settle()
    await harness.render(null)
    await expect(retryDeviceSessions('owner-b', 'b')).rejects.toThrow('当前账号')
    expect(mocks.pushes.size).toBe(0)
  })

  it('两台在线机器;resume 与 visibilitychange 同一次都响:每台都重订,最后只剩一条活订阅,旧的退掉', async () => {
    vi.useFakeTimers()
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    await harness.render(createNode(Root, { devices: [machine('machine-a'), machine('machine-b')] }))
    await settle()
    expect(callsFor(mocks.subscribeSessionsList, 'machine-a')).toBe(1)
    expect(callsFor(mocks.subscribeSessionsList, 'machine-b')).toBe(1)

    await act(async () => {
      mocks.foreground?.()
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    for (const id of ['machine-a', 'machine-b']) {
      const subscribed = mocks.subscribeSessionsList.mock.calls.filter((call) => call[0] === id).map((call) => call[1])
      const dropped = new Set(mocks.unsubscribeSessionsList.mock.calls.filter((call) => call[0] === id).map((call) => call[1]))
      expect(subscribed.length, `${id}: re-subscribed on return`).toBeGreaterThan(1)
      expect(subscribed.filter((sub) => !dropped.has(sub)), `${id}: only the newest subscription is still live`).toEqual([subscribed.at(-1)])
    }
  })

  it('两台在线机器轮流心跳、列表顺序对调:不重订(❌ 顺序一换整套拆掉重来)', async () => {
    vi.useFakeTimers()
    await harness.render(createNode(Root, { devices: [machine('machine-a'), machine('machine-b')] }))
    await settle()
    await harness.render(createNode(Root, { devices: [machine('machine-b'), machine('machine-a')] }))
    await settle()
    expect(callsFor(mocks.subscribeSessionsList, 'machine-a')).toBe(1)
    expect(callsFor(mocks.subscribeSessionsList, 'machine-b')).toBe(1)
    expect(mocks.unsubscribeSessionsList).not.toHaveBeenCalled()
  })

  it('页面转到后台那一声(hidden)不重订', async () => {
    vi.useFakeTimers()
    await harness.render(createNode(Root, { devices: [machine('machine-a')] }))
    await settle()
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(0) })
    expect(callsFor(mocks.subscribeSessionsList, 'machine-a')).toBe(1)
  })
})
