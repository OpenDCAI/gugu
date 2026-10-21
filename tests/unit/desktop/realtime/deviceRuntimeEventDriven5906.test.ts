// #5906 —— 设备宿主的调度合同(spec device-runtime):取命令只由事件触发,没有公共节拍器。
//
// 这些用例判的是**请求次数**,所以每一条都配阳控:「取命令的次数没涨」只有在同一段时间里
// 监督节拍确实在跑(实例租约心跳在涨)时才算数 —— 否则一个根本没起来的宿主也会满足它。
import { describe, expect, test, vi } from 'vitest'
import {
  createDeviceRuntimeHostLoop,
  deterministicDeviceId,
  type DeviceRuntimeIdentityClient,
} from '@gugu/core'
import { runDueScheduledTasks, type AgentScheduledTaskRow } from '@gugu/core/cloud/agentScheduledTasks'
import {
  createTestLocalAgent,
  deviceCommandRow,
  isolatedGuguEnv,
  MemoryRuntimeIdentityClient,
  TEST_AGENT_USER_ID,
  type MemoryCommandRow,
} from '../../../support/deviceRuntimeHarness'
import { until } from '../../../support/awaitCondition'

const MACHINE_ID = 'event-driven-5906-machine'
const USER_ID = 'user-1'
const DEVICE_ID = deterministicDeviceId(MACHINE_ID, USER_ID)
const DRAIN_RETRY_MS = 15
const SUPERVISE_MS = 40

/** 按函数名数 RPC —— 判据读的就是这个账本。 */
class CountingClient extends MemoryRuntimeIdentityClient {
  readonly calls = new Map<string, number>()
  /** 下一次孤儿恢复要「放回」的行(模拟死掉的兄弟实例留下的 running 行被 RPC 重置成 pending)。 */
  requeueOnNextRecovery: MemoryCommandRow[] = []
  failNextFetch = false

  count(fn: string): number {
    return this.calls.get(fn) ?? 0
  }

  /** `row()` 在行还不存在时会抛;轮询判据要的是「还没有」而不是异常。 */
  statusOf(id: string): unknown {
    return this.rows.find((row) => row.id === id)?.status
  }

  async rpc(fn: string, args: Record<string, unknown>): ReturnType<MemoryRuntimeIdentityClient['rpc']> {
    type RpcResult = Awaited<ReturnType<MemoryRuntimeIdentityClient['rpc']>>
    this.calls.set(fn, this.count(fn) + 1)
    if (fn === 'fetch_fair_pending_device_commands' && this.failNextFetch) {
      this.failNextFetch = false
      return { data: null, error: { message: 'simulated network failure' } } as unknown as RpcResult
    }
    if (fn === 'recover_orphaned_device_commands' && this.requeueOnNextRecovery.length > 0) {
      const requeued = this.requeueOnNextRecovery.splice(0)
      for (const row of requeued) this.add(row)
      return { data: requeued.length, error: null } as unknown as RpcResult
    }
    return super.rpc(fn, args)
  }
}

const newClient = (rows: MemoryCommandRow[] = []) =>
  new CountingClient(rows, {
    insertError: 'insert is not used by #5906',
    singleError: 'single is not used by #5906',
  })

type Wake = {
  onCommand: ((commandId?: string) => Promise<void>) | null
  onSubscriptionLost: (() => void) | null
  subscriptions: number
}

function startedHost(
  env: NodeJS.ProcessEnv,
  client: CountingClient,
  extra: Partial<Parameters<typeof createDeviceRuntimeHostLoop>[0]> = {},
) {
  const wake: Wake = { onCommand: null, onSubscriptionLost: null, subscriptions: 0 }
  const host = createDeviceRuntimeHostLoop({
    env,
    intervalMs: DRAIN_RETRY_MS,
    superviseIntervalMs: SUPERVISE_MS,
    // 让孤儿恢复闸每个监督 tick 都开(默认 60 s),否则「放回触发取」那条要等一分钟。
    orphanRecoveryIntervalMs: 0,
    machineIdentifier: () => MACHINE_ID,
    capabilities: { terminals: [], runtimes: [] },
    authProvider: { getAuth: async () => ({ accessToken: 'token', userId: USER_ID }) },
    makeIdentityClient: () => client as unknown as DeviceRuntimeIdentityClient,
    runtimeBridge: {
      create: async () => {},
      injectAgentInbox: async () => 'accepted' as const,
      stop: async () => {},
    },
    subscribeCommandWake: ({ onCommand, onSubscribed, onSubscriptionLost }) => {
      wake.subscriptions += 1
      wake.onCommand = onCommand
      wake.onSubscriptionLost = onSubscriptionLost ?? null
      // 真实的订阅实现在 SUBSCRIBED 时回报;宿主的「wake 订着」只认这个回报。
      onSubscribed?.()
      return () => undefined
    },
    ...extra,
  })
  return { host, wake }
}

/** 一条没人持有的 deliver:持有预算(150 s)内既不 claim 也不落终态,一直留在 pending。 */
const unheldDeliver = (id: string): MemoryCommandRow =>
  deviceCommandRow({
    id,
    deviceId: DEVICE_ID,
    type: 'agent.deliver',
    payload: { agent_user_id: 'agent-nobody-holds', chat_id: 'chat-1', message_id: `msg-${id}` },
    createdAt: new Date().toISOString(),
  })

const FETCH = 'fetch_fair_pending_device_commands'
const LEASE = 'runtime_instance_heartbeat'

/**
 * 等宿主的状态走到某一步。宿主的每一轮都有真 fs 读写,要多久由机器定 ⇒ 没有期限(失败时 `[awaiting-fact]` 点名卡在哪一步),
 * ❌ 5 秒上限。条件里有 `getDebugSnapshot()` 这类没有事件可等的读数,所以是轮询(`until`)。
 */
const waitFor = (check: () => boolean, label: string): Promise<void> => until(label, check)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const UNANNOUNCED = 'no wake event announced'
const warned = (warn: ReturnType<typeof vi.fn>, needle: string) =>
  warn.mock.calls.filter(([message]) => String(message).includes(needle)).length

describe('#5906 device runtime is event-driven: no shared metronome', () => {
  test('队列取空之后,取命令只发生在对账节拍上 —— 不再按排空间隔扫', async () => {
    const env = await isolatedGuguEnv('gugu-5906-idle-')
    const client = newClient()
    // 排空间隔 10 ms、对账节拍 120 ms:两种节律差一个数量级,谁在驱动取命令一眼可分。
    const { host } = startedHost(env, client, { intervalMs: 10, superviseIntervalMs: 120 })
    host.start()
    try {
      await waitFor(() => client.count(FETCH) >= 1 && !host.getDebugSnapshot().ticking, '启动时的首轮')
      const before = client.count(FETCH)
      await sleep(500)
      const grown = client.count(FETCH) - before
      expect(grown, '阳控:对账节拍确实在跑(否则「没多取」对一个死掉的宿主也成立)').toBeGreaterThanOrEqual(1)
      // 从前按 intervalMs 扫:500 ms 里约 50 次。对账节拍:约 4 次。
      expect(grown, '空闲时只许按对账节拍取命令').toBeLessThanOrEqual(8)
      expect(host.getDebugSnapshot().drainFollowUpArmed).toBe(false)
    } finally {
      await host.stop()
    }
  })

  test('command_created 事件当场触发一轮 tick', async () => {
    const env = await isolatedGuguEnv('gugu-5906-wake-')
    await createTestLocalAgent(env, {}, { cache: { acp_engine_id: 'codex' }, status: 'active' })
    const client = newClient()
    const { host, wake } = startedHost(env, client, { superviseIntervalMs: 60_000 })
    host.start()
    try {
      await waitFor(() => wake.onCommand !== null, 'wake 已订上')
      await waitFor(() => client.count(FETCH) >= 1 && !host.getDebugSnapshot().ticking, '首轮结束')
      client.add({
        id: 'cmd-stop',
        device_id: DEVICE_ID,
        type: 'agent.stop',
        status: 'pending',
        payload: { agent_user_id: TEST_AGENT_USER_ID },
        created_at: new Date().toISOString(),
      })
      await wake.onCommand!()
      expect(client.row('cmd-stop')).toMatchObject({ status: 'done' })
    } finally {
      await host.stop()
    }
  })

  test.each(['during-subscribe', 'after-subscribe'] as const)(
    '#5979 空队列不取消本轮的 wake 重订,恢复后仍静默: %s',
    async (failureTiming) => {
      const env = await isolatedGuguEnv('gugu-5979-wake-retry-')
      await createTestLocalAgent(env, {}, { cache: { acp_engine_id: 'codex' }, status: 'active' })
      const client = newClient()
      let subscriptions = 0
      let failSubscription!: () => void
      let announce!: (commandId?: string) => Promise<void>
      const { host } = startedHost(env, client, {
        superviseIntervalMs: 60_000,
        heartbeatIntervalMs: 20,
        subscribeCommandWake: ({ onSubscribeFailure, onSubscribed, onCommand }) => {
          subscriptions += 1
          failSubscription = onSubscribeFailure
          announce = onCommand
          if (subscriptions === 1) {
            if (failureTiming === 'during-subscribe') onSubscribeFailure()
            // subscribe() 已经返回、这一轮还没完(后面还有 await)时才报失败。设备 RPC 现在先于 wake 订,
            // 从前借它那个 await 落这一下,现在落在这一轮余下的 await 里
            else queueMicrotask(() => failSubscription())
          } else {
            onSubscribed?.()
          }
          return () => undefined
        },
        subscribeDeviceRpc: async () => ({ ready: Promise.resolve(true), unsubscribe: () => undefined }),
      })
      host.start()
      try {
        await waitFor(() => subscriptions >= 1 && client.count(FETCH) >= 1, '首轮确实取空并尝试订阅')
        await waitFor(() => host.getDebugSnapshot().commandWakeSubscribed, '不等一分钟对账,退避重订成功')
        client.add(deviceCommandRow({
          id: 'cmd-after-resubscribe', deviceId: DEVICE_ID, type: 'agent.stop',
          payload: { agent_user_id: TEST_AGENT_USER_ID }, createdAt: new Date().toISOString(),
        }))
        await announce('cmd-after-resubscribe')
        expect(client.statusOf('cmd-after-resubscribe')).toBe('done')
        await waitFor(() => {
          const snapshot = host.getDebugSnapshot()
          return !snapshot.ticking && !snapshot.drainFollowUpArmed
        }, '恢复后排空并静默')
        const fetched = client.count(FETCH)
        const leases = client.count(LEASE)
        await waitFor(() => client.count(LEASE) >= leases + 3, '阳控:静默期间宿主仍续租')
        expect(client.count(FETCH), '恢复订阅不应留下持续取命令的定时器').toBe(fetched)
        expect(subscriptions).toBe(2)
      } finally {
        await host.stop()
      }
    },
  )

  test('先登记 offline 再订 RPC:订上后设备行才变 online', async () => {
    const env = await isolatedGuguEnv('gugu-rpc-before-heartbeat-')
    const client = newClient()
    let heartbeatsBeforeRpc: number | null = null
    const { host } = startedHost(env, client, {
      superviseIntervalMs: 60_000,
      subscribeDeviceRpc: async () => {
        heartbeatsBeforeRpc ??= client.upserts.length
        return { ready: Promise.resolve(true), unsubscribe: () => undefined }
      },
    })
    host.start()
    try {
      await waitFor(() => heartbeatsBeforeRpc !== null && client.upserts.length >= 1, '首轮订了设备 RPC,也写了心跳(阳控)')
      expect(heartbeatsBeforeRpc).toBe(1)
      expect(client.upserts[0]?.row.status).toBe('offline')
      expect(client.upserts[1]?.row.status).toBe('online')
    } finally {
      await host.stop()
    }
  })

  test('首次 RPC 授权失败时只登记 offline,不把设备伪装成 online', async () => {
    const env = await isolatedGuguEnv('gugu-rpc-registration-failure-')
    const client = newClient()
    let subscriptions = 0
    const { host } = startedHost(env, client, {
      superviseIntervalMs: 60_000,
      subscribeDeviceRpc: async () => {
        subscriptions += 1
        return { ready: Promise.resolve(false), unsubscribe: () => undefined }
      },
    })
    host.start()
    try {
      await waitFor(() => client.upserts.length >= 1 && !host.getDebugSnapshot().ticking, '离线登记、订阅失败')
      expect(subscriptions).toBe(1)
      expect(client.upserts[0]?.row.status).toBe('offline')
      await sleep(100)
      expect(subscriptions).toBe(1)
    } finally {
      await host.stop()
    }
  })

  test('留在 pending 的行由排空跟进复查,行没了就回到静默', async () => {
    const env = await isolatedGuguEnv('gugu-5906-drain-')
    const client = newClient([unheldDeliver('cmd-unheld')])
    const { host } = startedHost(env, client, { intervalMs: 10, superviseIntervalMs: 60_000 })
    host.start()
    try {
      // 行一直 pending ⇒ 取命令的次数必须持续上涨(没有任何事件会替它叫醒宿主;对账节拍被放到了一分钟外)。
      await waitFor(() => client.count(FETCH) >= 5, '对留在 pending 的行至少复查 5 轮')
      expect(client.row('cmd-unheld')).toMatchObject({ status: 'pending' })

      // 持有者把它领走了(行不再 pending)⇒ 下一轮取到空集 ⇒ 静默。
      client.row('cmd-unheld').status = 'done'
      await waitFor(
        () => !host.getDebugSnapshot().drainFollowUpArmed && !host.getDebugSnapshot().ticking,
        '排空跟进撤下',
      )
      const atQuiescence = client.count(FETCH)
      await sleep(150)
      expect(client.count(FETCH), '静默之后不许再按排空间隔取命令').toBe(atQuiescence)
    } finally {
      await host.stop()
    }
  })

  test('#5979 提前到来的 tick 接替旧跟进,取空后不再额外取一次', async () => {
    const env = await isolatedGuguEnv('gugu-5979-preempt-drain-')
    const client = newClient([unheldDeliver('cmd-before-event')])
    const { host } = startedHost(env, client, {
      intervalMs: 200, superviseIntervalMs: 60_000, heartbeatIntervalMs: 20,
    })
    host.start()
    try {
      await host.tickOnce()
      expect(host.getDebugSnapshot().drainFollowUpArmed).toBe(true)
      client.row('cmd-before-event').status = 'done'
      await host.tickOnce()
      const fetched = client.count(FETCH)
      const leases = client.count(LEASE)
      await sleep(250)
      expect(client.count(LEASE), '阳控:宿主仍在续租').toBeGreaterThan(leases)
      expect(client.count(FETCH), '旧跟进已被提前到来的 tick 接替').toBe(fetched)
    } finally {
      await host.stop()
    }
  })

  test('没被任何事件通知过的行:对账节拍取走它,并且响亮地说出来', async () => {
    const env = await isolatedGuguEnv('gugu-5906-unannounced-')
    await createTestLocalAgent(env, {}, { cache: { acp_engine_id: 'codex' }, status: 'active' })
    const client = newClient()
    const warn = vi.fn()
    const { host, wake } = startedHost(env, client, { warn, superviseIntervalMs: 60 })
    host.start()
    try {
      await waitFor(() => wake.onCommand !== null && client.count(FETCH) >= 1 && !host.getDebugSnapshot().ticking, '首轮取空')
      // 一条广播丢了的命令:行进了库,wake 一声不响。
      client.add({
        id: 'cmd-silent',
        device_id: DEVICE_ID,
        type: 'agent.stop',
        status: 'pending',
        payload: { agent_user_id: TEST_AGENT_USER_ID },
        created_at: new Date().toISOString(),
      })
      await waitFor(() => client.statusOf('cmd-silent') === 'done', '对账节拍把它取走并执行')
      // **别的行**的广播盖不掉这一行的丢失(按行 id 对)。
      await wake.onCommand!('cmd-some-other-row')
      // 判定等一个 intervalMs 才落槌(给晚到的广播留到场时间)。
      await waitFor(() => warned(warn, UNANNOUNCED) >= 1, '漏掉的事件必须被看见,不许被对账悄悄抹平')
      expect(warned(warn, UNANNOUNCED)).toBe(1)
      expect(warn.mock.calls.some(([message]) => String(message).includes('cmd-silent'))).toBe(true)
    } finally {
      await host.stop()
    }
  })

  test('活着的兄弟实例持有的行不归本实例(#5041):不为它续跑,也不为它报「没被通知」', async () => {
    const env = await isolatedGuguEnv('gugu-5906-held-elsewhere-')
    const agent = 'agent-held-by-sibling-instance'
    const client = newClient([
      // 兄弟 inst-B 刚替这个 agent 跑过一条 ⇒ 它是持有者;下面那条 pending 归它。
      {
        ...deviceCommandRow({ id: 'earlier-by-B', deviceId: DEVICE_ID, type: 'agent.deliver', payload: { agent_user_id: agent } }),
        status: 'done',
        claimed_by: 'inst-B',
        claimed_at: new Date().toISOString(),
      } as MemoryCommandRow,
      deviceCommandRow({
        id: 'cmd-of-sibling',
        deviceId: DEVICE_ID,
        type: 'agent.deliver',
        payload: { agent_user_id: agent, chat_id: 'chat-1', message_id: 'msg-1' },
        createdAt: new Date().toISOString(),
      }),
    ])
    const keepSiblingAlive = setInterval(() => client.setRuntimeInstance('inst-B', DEVICE_ID, new Date().toISOString()), 10)
    client.setRuntimeInstance('inst-B', DEVICE_ID, new Date().toISOString())
    const warn = vi.fn()
    const { host } = startedHost(env, client, { warn, heartbeatIntervalMs: 10, superviseIntervalMs: 80 })
    host.start()
    try {
      await waitFor(() => client.count(FETCH) >= 1 && !host.getDebugSnapshot().ticking, '首轮')
      expect(client.row('cmd-of-sibling')).toMatchObject({ status: 'pending' })
      expect(host.getDebugSnapshot().drainFollowUpArmed, '别人的行不挂排空跟进').toBe(false)
      const fetchBefore = client.count(FETCH)
      const leaseBefore = client.count(LEASE)
      await sleep(8 * DRAIN_RETRY_MS)
      expect(client.count(LEASE), '阳控:这段时间宿主确实活着').toBeGreaterThan(leaseBefore)
      // 120 ms 里至多赶上两拍对账(80 ms 一拍);按排空间隔(15 ms)续跑的话会是 8 次上下。
      expect(client.count(FETCH) - fetchBefore, '只许对账节拍取,不许按排空间隔续跑').toBeLessThanOrEqual(2)
      await waitFor(() => client.count(FETCH) >= fetchBefore + 3, '再过几拍对账')
      await sleep(3 * DRAIN_RETRY_MS)
      expect(warned(warn, UNANNOUNCED), '兄弟把行 hold 回 pending 本来就没有广播').toBe(0)
      expect(client.row('cmd-of-sibling')).toMatchObject({ status: 'pending' })
    } finally {
      clearInterval(keepSiblingAlive)
      await host.stop()
    }
  })

  test('本机说一声就当场取:失败条的「重试」与登录态变化都不等对账节拍', async () => {
    const env = await isolatedGuguEnv('gugu-5906-retry-button-')
    await createTestLocalAgent(env, {}, { cache: { acp_engine_id: 'codex' }, status: 'active' })
    const client = newClient()
    const { host } = startedHost(env, client, { superviseIntervalMs: 60_000 })
    host.start()
    try {
      await waitFor(() => client.count(FETCH) >= 1 && !host.getDebugSnapshot().ticking, '首轮取空')
      client.add({
        id: 'cmd-retried',
        device_id: DEVICE_ID,
        type: 'agent.stop',
        status: 'pending',
        payload: { agent_user_id: TEST_AGENT_USER_ID },
        created_at: new Date().toISOString(),
      })
      // 阴控:没人说话的时候它确实不会被取走(对账节拍在一分钟外)。
      await sleep(80)
      expect(client.row('cmd-retried')).toMatchObject({ status: 'pending' })
      host.notifyCommandsChanged()
      await waitFor(() => client.statusOf('cmd-retried') === 'done', '通知之后当场取走')
      // 登录态变化走同一条路:不通知的话,登录之后要等一个对账周期设备才上线。
      // ⚠️ 先等排空跟进收干净再放第二条:取到过行会排一轮跟进,它会在「没人说话」之前就把新行取走,阴控就废了。
      await waitFor(() => {
        const snapshot = host.getDebugSnapshot()
        return !snapshot.ticking && !snapshot.drainFollowUpArmed
      }, '排空跟进已收、宿主静默')
      client.add(deviceCommandRow({ id: 'cmd-after-auth', deviceId: DEVICE_ID, type: 'agent.stop', payload: { agent_user_id: TEST_AGENT_USER_ID }, createdAt: new Date().toISOString() }))
      await sleep(80)
      expect(client.row('cmd-after-auth')).toMatchObject({ status: 'pending' })
      host.notifyAuthChanged()
      await waitFor(() => client.statusOf('cmd-after-auth') === 'done', '登录态变化之后当场取走')
    } finally {
      await host.stop()
    }
  })

  test('一轮 tick 失败 ⇒ 退避重试(队列状态未知,不是「没有事件」)', async () => {
    const env = await isolatedGuguEnv('gugu-5906-retry-')
    const client = newClient()
    client.failNextFetch = true
    const warn = vi.fn()
    const { host } = startedHost(env, client, { warn, superviseIntervalMs: 60_000 })
    host.start()
    try {
      await waitFor(() => client.count(FETCH) >= 2, '失败之后自己再取一次')
      expect(warned(warn, 'simulated network failure')).toBeGreaterThanOrEqual(1)
    } finally {
      await host.stop()
    }
  })

  test('没有 wake 事件源的宿主拒绝启动', async () => {
    const env = await isolatedGuguEnv('gugu-5906-nowake-')
    const { host } = startedHost(env, newClient(), { subscribeCommandWake: undefined })
    expect(() => host.start()).toThrow(/subscribeCommandWake/)
  })

  test('续租不受设备心跳的能力探测闩牵连:探测超时之后 tick 仍被占着,租约照常续', async () => {
    const env = await isolatedGuguEnv('gugu-5906-lease-latch-')
    const client = newClient()
    const warn = vi.fn()
    let release!: () => void
    const occupied = new Promise<void>((resolve) => { release = resolve })
    let occupying = false
    let hangProbe = false
    const { host } = startedHost(env, client, {
      warn,
      heartbeatIntervalMs: 20,
      superviseIntervalMs: 60_000,
      capabilityTimeoutMs: 15,
      capabilities: () => (hangProbe ? new Promise<never>(() => undefined) : { terminals: [], runtimes: [] }),
      subscribeCommandWake: async () => {
        occupying = true
        await occupied
        return () => undefined
      },
    })
    host.start()
    try {
      await waitFor(() => occupying, 'tick 已被占住')
      hangProbe = true
      // 控:闩确实落了 —— 心跳报了能力探测超时;此后心跳那条 flight 不再出门,而 tick 进不来、清不了它。
      await waitFor(() => warned(warn, 'device capability detection timed out') >= 1, '心跳的能力探测超时')
      const before = client.count(LEASE)
      await waitFor(() => client.count(LEASE) >= before + 3, '闩落之后租约仍在续')
      expect(host.getDebugSnapshot().ticking).toBe(true)
    } finally {
      release()
      await host.stop()
    }
  })
})

describe('#5906 scheduled tasks fire on their due time, not on a tick', () => {
  const task = (overrides: Partial<AgentScheduledTaskRow>): AgentScheduledTaskRow => ({
    id: 'task-1',
    agent_user_id: 'agent-1',
    owner_user_id: USER_ID,
    chat_id: 'chat-1',
    title: null,
    prompt: 'ping',
    schedule_kind: 'interval',
    interval_seconds: 60,
    enabled: true,
    next_run_at: null,
    last_run_at: null,
    created_at: '2026-09-19T00:00:00.000Z',
    updated_at: '2026-09-19T00:00:00.000Z',
    ...overrides,
  })

  test('到点才扫:挂的是最早到期时刻的一次性定时器', async () => {
    const env = await isolatedGuguEnv('gugu-5906-sched-')
    const client = newClient()
    const runs: number[] = []
    const startedAt = Date.now()
    const dueInMs = 120
    const { host } = startedHost(env, client, {
      // 监督节拍放到很远,免得它的周期重排混进这条判据。
      superviseIntervalMs: 60_000,
      runScheduledTasks: async ({ nowMs }) => {
        runs.push(nowMs - startedAt)
        return { nextDueAtMs: runs.length === 1 ? startedAt + dueInMs : null }
      },
    })
    host.start()
    try {
      await waitFor(() => runs.length >= 1, '首轮排期')
      await waitFor(() => runs.length >= 2, '到期时刻的那一轮')
      expect(runs[1], '不许早于到期时刻').toBeGreaterThanOrEqual(dueInMs - 5)
      await new Promise((resolve) => setTimeout(resolve, 80))
      expect(runs, '没有下一个到期时刻 ⇒ 不再扫').toHaveLength(2)
    } finally {
      await host.stop()
    }
  })

  test('nextDueAtMs 取推进后的排期;到期却没推进成的任务不参与(否则定时器原地空转)', async () => {
    const nowMs = Date.parse('2026-09-19T12:00:00.000Z')
    const fired = task({ id: 'fired', next_run_at: '2026-09-19T11:59:00.000Z', interval_seconds: 300 })
    const offline = task({ id: 'offline', agent_user_id: 'agent-offline', next_run_at: '2026-09-19T11:58:00.000Z' })
    const later = task({ id: 'later', next_run_at: '2026-09-19T12:10:00.000Z' })
    const result = await runDueScheduledTasks(
      {
        listEnabledTasks: async () => [fired, offline, later],
        resolveAgentDeviceId: async (agentUserId) => (agentUserId === 'agent-offline' ? null : 'device-1'),
        enqueueAgentDeliver: async () => 'cmd-1',
        markTaskFired: async () => true,
      },
      { ownerUserId: USER_ID, nowMs, newMessageId: () => 'msg-1' },
    )
    expect(result.fired).toEqual(['fired'])
    expect(result.skipped).toEqual([{ taskId: 'offline', reason: 'agent_offline' }])
    // fired 推进到 12:05,later 在 12:10,offline 仍停在过去 ⇒ 最早的未来时刻是 12:05。
    expect(result.nextDueAtMs).toBe(Date.parse('2026-09-19T12:05:00.000Z'))
  })

  test('推进排期是 CAS:别的设备先推进了 ⇒ 这一轮不入队(多台设备在同一个到期时刻醒来)', async () => {
    const nowMs = Date.parse('2026-09-19T12:00:00.000Z')
    const due = task({ id: 'due', next_run_at: '2026-09-19T11:59:00.000Z', interval_seconds: 300 })
    const enqueue = vi.fn(async () => 'cmd-1')
    const seenExpected: Array<string | null> = []
    const result = await runDueScheduledTasks(
      {
        listEnabledTasks: async () => [due],
        resolveAgentDeviceId: async () => 'device-1',
        enqueueAgentDeliver: enqueue,
        markTaskFired: async (_id, _patch, expectedNextRunAt) => {
          seenExpected.push(expectedNextRunAt)
          return false
        },
      },
      { ownerUserId: USER_ID, nowMs, newMessageId: () => 'msg-1' },
    )
    expect(seenExpected, 'CAS 的期望值就是我们读到的那个排期').toEqual(['2026-09-19T11:59:00.000Z'])
    expect(result.fired).toEqual([])
    expect(result.skipped).toEqual([{ taskId: 'due', reason: 'claimed_elsewhere' }])
    expect(enqueue, '没抢到就不许入队 —— 否则 agent 把同一条定时指令跑两遍').not.toHaveBeenCalled()
  })
})
