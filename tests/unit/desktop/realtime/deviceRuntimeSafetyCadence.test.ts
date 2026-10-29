// @@@safety-cadence —— wake 订着时,新命令由事件送来,对账 tick(取命令 + 孤儿恢复)与定时任务重排只是兜底:每 safetyIntervalMs 一次。
// 掉线(或从没订上)时回到每个监督节拍一次。本机改了定时任务由渲染层当场通知(notifyScheduledTasksChanged),❌ 等兜底周期。
//
// 判的是请求次数,配阳控:「取命令的次数没涨」只在同一段时间里租约心跳确实在涨(宿主在跑)时才算数。
import { describe, expect, test } from 'vitest'
import { createDeviceRuntimeHostLoop, type DeviceRuntimeIdentityClient } from '@gugu/core'
import { isolatedGuguEnv, MemoryRuntimeIdentityClient } from '../../../support/deviceRuntimeHarness'
import { until } from '../../../support/awaitCondition'

const MACHINE_ID = 'safety-cadence-machine'
const USER_ID = 'user-1'
const SUPERVISE_MS = 30
const FETCH = 'fetch_fair_pending_device_commands'
const LEASE = 'runtime_instance_heartbeat'

class CountingClient extends MemoryRuntimeIdentityClient {
  readonly calls = new Map<string, number>()
  count(fn: string): number {
    return this.calls.get(fn) ?? 0
  }
  async rpc(fn: string, args: Record<string, unknown>): ReturnType<MemoryRuntimeIdentityClient['rpc']> {
    this.calls.set(fn, this.count(fn) + 1)
    return super.rpc(fn, args)
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function startedHost(env: NodeJS.ProcessEnv, client: CountingClient, safetyIntervalMs: number) {
  const wake = { lost: null as (() => void) | null, subscribed: null as (() => void) | null }
  const plans = { runs: 0 }
  const host = createDeviceRuntimeHostLoop({
    env,
    intervalMs: 10,
    superviseIntervalMs: SUPERVISE_MS,
    heartbeatIntervalMs: SUPERVISE_MS,
    safetyIntervalMs,
    machineIdentifier: () => MACHINE_ID,
    capabilities: { terminals: [], runtimes: [] },
    authProvider: { getAuth: async () => ({ accessToken: 'token', userId: USER_ID }) },
    makeIdentityClient: () => client as unknown as DeviceRuntimeIdentityClient,
    runtimeBridge: { create: async () => {}, injectAgentInbox: async () => 'accepted' as const, stop: async () => {} },
    runScheduledTasks: async () => {
      plans.runs += 1
      return { nextDueAtMs: null }
    },
    subscribeCommandWake: ({ onSubscribed, onSubscriptionLost }) => {
      wake.lost = onSubscriptionLost ?? null
      wake.subscribed = onSubscribed ?? null
      onSubscribed?.()
      return () => undefined
    },
  })
  return { host, wake, plans }
}

describe('@@@safety-cadence device runtime fallback polling', () => {
  test('wake subscribed: the reconcile fetch is a safety net; wake lost: every supervise tick fetches again', async () => {
    const env = await isolatedGuguEnv('gugu-safety-cadence-')
    const client = new CountingClient([], { insertError: 'unused', singleError: 'unused' })
    const { host, wake } = startedHost(env, client, 60_000)
    host.start()
    try {
      await until('first tick done', () => client.count(FETCH) >= 1 && !host.getDebugSnapshot().ticking)
      const fetches = client.count(FETCH)
      const leases = client.count(LEASE)
      await sleep(SUPERVISE_MS * 8)
      // 阳控:宿主在跑(租约心跳在涨),取命令却没涨 —— 订着时监督节拍不再取。
      expect(client.count(LEASE)).toBeGreaterThan(leases)
      expect(client.count(FETCH)).toBeLessThanOrEqual(fetches + 1)
      wake.lost!()
      const atLoss = client.count(FETCH)
      await until('fetches resume every supervise tick', () => client.count(FETCH) >= atLoss + 3)
      // 重新订上:又回到兜底节律。
      wake.subscribed!()
      await sleep(SUPERVISE_MS * 2)
      const resubscribed = client.count(FETCH)
      await sleep(SUPERVISE_MS * 8)
      expect(client.count(FETCH)).toBeLessThanOrEqual(resubscribed + 1)
    } finally {
      await host.stop()
    }
  })

  test('a scheduled task changed on this machine is re-planned at once, not at the next safety read', async () => {
    const env = await isolatedGuguEnv('gugu-safety-cadence-tasks-')
    const client = new CountingClient([], { insertError: 'unused', singleError: 'unused' })
    const { host, plans } = startedHost(env, client, 60_000)
    host.start()
    try {
      await until('first plan', () => plans.runs >= 1)
      await sleep(SUPERVISE_MS * 4)
      const before = plans.runs
      await sleep(SUPERVISE_MS * 6)
      // 订着时监督节拍不再重读任务表(阳控:下面一通知就重读)。
      expect(plans.runs).toBe(before)
      host.notifyScheduledTasksChanged()
      await until('re-planned after the local change', () => plans.runs === before + 1)
    } finally {
      await host.stop()
    }
  })
})
