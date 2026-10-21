import { expect, test, vi } from 'vitest'
import {
  createDeviceRuntimeHostLoop,
  type DeviceCapabilities,
  type DeviceRuntimeIdentityClient,
} from '@gugu/core'
import { awaitPending } from '../../../support/awaitFact'
import {
  isolatedGuguEnv,
  pollOnlyRuntimeIdentityClient,
} from '../../../support/deviceRuntimeHarness'
const CAPABILITIES: DeviceCapabilities = { terminals: ['tmux'], runtimes: ['codex'] }
test('bounds a stuck capability flight without rejecting a slow valid probe', async () => {
  const env = await isolatedGuguEnv('gugu-runtime-bounded-flight-2816-b-')
  const client = pollOnlyRuntimeIdentityClient([], 'bounded flight #2816 B')
  let authCalls = 0
  let capabilityCalls = 0
  let activeCapabilityCalls = 0
  let maxConcurrentCapabilityCalls = 0
  let capabilityAborted = false
  let stuck = true
  // 卡住的探测不是永远不回:恢复时一起放行。此刻若有一轮失败重试的 tick(intervalMs 之后自己排上的)
  // 正等着它,那一轮照样成功 —— 恢复那一拍的结论因此不取决于重试 tick 恰好落在哪一毫秒。
  const stuckProbes: Array<(capabilities: DeviceCapabilities) => void> = []
  let heartbeatWarned!: () => void
  const heartbeatWarning = new Promise<void>((resolve) => { heartbeatWarned = resolve })
  const warn = vi.fn((message: string) => {
    if (message.startsWith('[device-runtime] heartbeat:')) heartbeatWarned()
  })
  const host = createDeviceRuntimeHostLoop({
    env,
    intervalMs: 1_000,
    // 宿主不轮询命令,start() 要求一个事件源(#5906);这条用例不关心命令到达,给一个永不触发的。
    subscribeCommandWake: () => () => undefined,
    heartbeatIntervalMs: 20,
    capabilityTimeoutMs: 80,
    machineIdentifier: () => 'machine-2816',
    authProvider: {
      getAuth: async () => {
        authCalls += 1
        return { accessToken: 'token-1', userId: 'user-1' }
      },
    },
    makeIdentityClient: () => client as unknown as DeviceRuntimeIdentityClient,
    capabilities: ({ signal }) => {
      capabilityCalls += 1
      activeCapabilityCalls += 1
      maxConcurrentCapabilityCalls = Math.max(maxConcurrentCapabilityCalls, activeCapabilityCalls)
      let released = false
      const release = () => {
        if (released) return
        released = true
        activeCapabilityCalls -= 1
      }
      signal.addEventListener('abort', () => { capabilityAborted = true }, { once: true })
      signal.addEventListener('abort', release, { once: true })
      if (stuck) return new Promise<DeviceCapabilities>((resolve) => { stuckProbes.push(resolve) }).finally(release)
      return Promise.resolve(CAPABILITIES).finally(release)
    },
    warn,
  })
  host.start()
  const active = host.tickOnce()
  await expect(active).rejects.toThrow('device capability detection timed out after 80ms')
  // 就在这一轮落定的同一拍里读:被卡住的那一轮让出了 tick 位。往后读,读到的可能是失败重试排上的下一轮。
  expect(host.getDebugSnapshot().ticking).toBe(false)
  await awaitPending('心跳报出探测超时', heartbeatWarning)
  // @@@no-wallclock — authCalls 是**心跳驱动的周期性**副作用(heartbeatIntervalMs: 20)。断言它
  // 恰好等于 2,等于断言「这段真实时间里心跳只跑了这么多拍」——机器一忙就变 3,实测已在 CI 上
  // 红过(run 31151680759 同型)。要证的其实是「失败的 tick 之后确实重新鉴权了」,那是个下界;
  // capabilityCalls may include a later heartbeat retry; the invariant is that capability flights
  // never overlap, not how many retries a busy host schedules before this observation runs.
  expect(authCalls).toBeGreaterThanOrEqual(2)
  expect(capabilityCalls).toBeGreaterThanOrEqual(1)
  expect(maxConcurrentCapabilityCalls).toBe(1)
  expect(capabilityAborted).toBe(true)
  expect(client.upserts).toHaveLength(0)
  stuck = false
  for (const resolve of stuckProbes.splice(0)) resolve(CAPABILITIES)
  const upsertsBeforeRecovery = client.upserts.length
  await expect(host.tickOnce()).resolves.toMatchObject({ skipped: false })
  expect(client.upserts.length).toBeGreaterThan(upsertsBeforeRecovery)
  await host.stop()
  const slowEnv = await isolatedGuguEnv('gugu-runtime-bounded-flight-2816-negative-')
  const slowClient = pollOnlyRuntimeIdentityClient([], 'bounded flight #2816 negative')
  // @@@no-wallclock — 这段是「慢但有效的探测不该被误杀」的反向对照:探测在超时**之前**返回就必须被接受。
  // 从前是 100ms 超时配真 80ms sleep,机器一忙 sleep 真会跑过 100ms;后来靠把超时拉到 5000ms 躲开。
  // 现在探测的耗时与超时走同一只假钟:80ms 回、100ms 超时,两者谁先到由钟决定,不由机器忙不忙决定。
  let probeStarted!: () => void
  const slowProbeStarted = new Promise<void>((resolve) => { probeStarted = resolve })
  const slowHost = createDeviceRuntimeHostLoop({
    env: slowEnv,
    capabilityTimeoutMs: 100,
    machineIdentifier: () => 'machine-2816-slow',
    authProvider: { getAuth: async () => ({ accessToken: 'token-1', userId: 'user-1' }) },
    makeIdentityClient: () => slowClient as unknown as DeviceRuntimeIdentityClient,
    capabilities: () => {
      probeStarted()
      return new Promise<DeviceCapabilities>((resolve) => setTimeout(() => resolve(CAPABILITIES), 80))
    },
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const slowTick = slowHost.tickOnce()
    // 超时的计时器与探测同一段同步代码里挂上(见 withCapabilityTimeout),探测开始即两只钟都已在走。
    await awaitPending('慢探测开始', slowProbeStarted)
    await vi.advanceTimersByTimeAsync(80)
    await expect(slowTick).resolves.toMatchObject({ skipped: false })
    expect(slowClient.upserts).toHaveLength(1)
  } finally {
    vi.useRealTimers()
  }
  await slowHost.stop()
})
