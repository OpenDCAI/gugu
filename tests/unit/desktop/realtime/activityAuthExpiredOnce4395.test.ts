import { describe, expect, test, vi } from 'vitest'
import {
  createDeviceRuntimeHostLoop,
  RuntimeAuthExpiredError,
  type DeviceRuntimeIdentityClient,
} from '@gugu/core'
import { awaitPending } from '../../../support/awaitFact'
import { createTestLocalAgent, isolatedGuguEnv } from '../../../support/deviceRuntimeHarness'
describe('#4395 permanent auth loss on the activity path stays one-shot', () => {
  test('activity 发布撞上 RuntimeAuthExpiredError 时不得每格重复告警', async () => {
    const env = await isolatedGuguEnv('gugu-4395-activity-')
    await createTestLocalAgent(env, {}, { cache: { acp_engine_id: 'claude' }, status: 'active' })
    const warnings: string[] = []
    const onAuthExpired = vi.fn()
    // 「不得每格重复」要在跑过很多格之后判:数格,❌ 睡 200ms 赌这段时间里跑了几格(机器一忙,一格都不一定跑到)。
    // 这条路上每一格都会再造一次身份客户端(一直没发出去 ⇒ 每格都「有变化」),造的次数就是格数。
    const ATTEMPTS = 20
    let identityClientCalls = 0
    let reachedAttempts!: () => void
    const attempted = new Promise<void>((resolve) => { reachedAttempts = resolve })
    const host = createDeviceRuntimeHostLoop({
      env,
      intervalMs: 10,
      // 宿主不轮询命令,start() 要求一个事件源(#5906);这条用例不关心命令到达,给一个永不触发的。
      subscribeCommandWake: () => () => undefined,
      machineIdentifier: () => 'auth-expired-once-machine',
      capabilities: { terminals: [], runtimes: [] },
      authProvider: { getAuth: async () => ({ accessToken: 'token', userId: 'user-1' }) },
      makeIdentityClient: (): DeviceRuntimeIdentityClient => {
        identityClientCalls += 1
        if (identityClientCalls === ATTEMPTS) reachedAttempts()
        throw new RuntimeAuthExpiredError('refresh_token_not_found')
      },
      runtimeBridge: {
        create: async () => {},
        injectAgentInbox: async () => 'accepted' as const,
        stop: async () => {},
        agentStatus: () => null,
      },
      warn: (message: string) => { warnings.push(message) },
      onAuthExpired,
    })
    host.start()
    try {
      await awaitPending(`身份客户端被构造 ${ATTEMPTS} 次(路径确实一格一格地执行了)`, attempted)
      expect(
        warnings.filter((line) => line.includes('activity edge publish failed')),
        '永久 auth 失效不该以「activity edge publish failed」的形式每格重复',
      ).toHaveLength(0)
      expect(onAuthExpired, '终态只该宣告一次').toHaveBeenCalledTimes(1)
    } finally {
      await host.stop()
    }
  })
})
