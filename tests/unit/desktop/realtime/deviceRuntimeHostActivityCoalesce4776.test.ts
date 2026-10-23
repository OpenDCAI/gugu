import { describe, expect, test } from 'vitest'
import { createDeviceRuntimeHostLoop, type DeviceRuntimeIdentityClient } from '@gugu/core'
import type { AgentStatusReading } from '@gugu/core/shared/agentStatus'
import { awaitPending } from '../../../support/awaitFact'
import {
  createTestLocalAgent,
  isolatedGuguEnv,
  pollOnlyRuntimeIdentityClient,
} from '../../../support/deviceRuntimeHarness'

/** 替身每记下一笔就叫醒等待者:等的是那一笔本身,❌ 5ms 轮询、❌ 5 秒上限(宿主的每一轮都有真 fs 读写,要多久由机器定)。 */
function recorder() {
  const waiters = new Set<{ ok: () => boolean; done: () => void }>()
  return {
    note(): void {
      for (const waiter of [...waiters]) {
        if (!waiter.ok()) continue
        waiters.delete(waiter)
        waiter.done()
      }
    },
    when(step: string, ok: () => boolean): Promise<void> {
      return ok() ? Promise.resolve() : awaitPending(step, new Promise<void>((done) => { waiters.add({ ok, done }) }))
    },
  }
}
describe('device runtime activity publish coalescing', () => {
  test('publishes a terminal idle transition that arrives during an in-flight running publish', async () => {
    const env = await isolatedGuguEnv('gugu-activity-coalesce-4776-')
    await createTestLocalAgent(env, {}, { cache: { acp_engine_id: 'claude' }, status: 'active' })
    const client = pollOnlyRuntimeIdentityClient([], 'activity coalesce 4776')
    const originalRpc = client.rpc.bind(client)
    const activityStatuses: unknown[] = []
    let releaseRunning!: () => void
    const runningReportBlocked = new Promise<void>((resolve) => {
      releaseRunning = resolve
    })
    let runningReportStarted = false
    let presenceReads = 0
    const reports = recorder()
    client.rpc = async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'get_agent_presence_batch') {
        const result = await originalRpc(fn, args)
        presenceReads += 1
        reports.note()
        return result
      }
      if (fn === 'set_agent_runtime_state') {
        activityStatuses.push(args.p_activity_status)
        if (args.p_activity_status === 'running' && !runningReportStarted) {
          runningReportStarted = true
          reports.note()
          await runningReportBlocked
        }
        reports.note()
      }
      return originalRpc(fn, args)
    }
    const notifyStatusChanged: { current: ((agentUserId: string) => void) | null } = { current: null }
    let status: AgentStatusReading | null = null
    // 周期节拍(activity 节律、对账、心跳、activity 对账)全部推到一天以后:这条用例要证的是「在途那次发完
    // 就立刻补发排着的 idle」,❌ 靠下一格周期节拍把 idle 带出去。节拍能在用例里触发,补发坏了也照样变绿。
    const NEVER_DURING_THIS_TEST = 24 * 60 * 60 * 1000
    const host = createDeviceRuntimeHostLoop({
      env,
      intervalMs: NEVER_DURING_THIS_TEST,
      superviseIntervalMs: NEVER_DURING_THIS_TEST,
      heartbeatIntervalMs: NEVER_DURING_THIS_TEST,
      activityReconcileIntervalMs: NEVER_DURING_THIS_TEST,
      // 宿主不轮询命令,start() 要求一个事件源(#5906);这条用例不关心命令到达,给一个永不触发的。
      subscribeCommandWake: () => () => undefined,
      machineIdentifier: () => 'activity-coalesce-4776-machine',
      authProvider: { getAuth: async () => ({ accessToken: 'token-1', userId: 'user-1' }) },
      makeIdentityClient: () => client as unknown as DeviceRuntimeIdentityClient,
      runtimeBridge: {
        create: async () => {},
        injectAgentInbox: async () => 'accepted' as const,
        stop: async () => {},
        agentStatus: () => status,
        onAgentStatusChanged: (listener) => {
          notifyStatusChanged.current = listener
          return () => {
            notifyStatusChanged.current = null
          }
        },
      },
    })
    host.start()
    try {
      // 开机那一轮对账读过云端(云端那一行本来就是空闲,没有要写的)。
      await reports.when('startup presence reconcile', () => presenceReads >= 1)
      status = { status: 'working', detail: 'running', running: true, background: null }
      notifyStatusChanged.current?.('agent-1')
      await reports.when('running activity report to start', () => runningReportStarted)
      status = { status: 'idle', detail: 'done', running: false, background: null }
      notifyStatusChanged.current?.('agent-1')
      releaseRunning()
      await reports.when(
        'queued idle activity report',
        () => activityStatuses.includes('idle'),
      )
      const runningIndex = activityStatuses.lastIndexOf('running')
      expect(runningIndex).toBeGreaterThanOrEqual(0)
      expect(activityStatuses.slice(runningIndex + 1)).toContain('idle')
    } finally {
      releaseRunning()
      await host.stop()
    }
  })
})
