// 生产 bug 的宿主那一半:一条命令执行期间 provider 换了令牌(旧令牌随即失效),落终态必须重新问 provider 要令牌,
// ❌ 用这一拍开头的 client。判据读库里那一行最后是不是 done;阴控 = 同一条用例里旧令牌确实已被库拒收。
import { describe, expect, test } from 'vitest'
import {
  createDeviceRuntimeHostLoop,
  deterministicDeviceId,
  type DeviceRuntimeIdentityClient,
} from '@gugu/core'
import {
  createTestLocalAgent,
  deviceCommandRow,
  isolatedGuguEnv,
  MemoryRuntimeIdentityClient,
  TEST_AGENT_USER_ID,
} from '../../../support/deviceRuntimeHarness'
import { until } from '../../../support/awaitCondition'

const MACHINE_ID = 'settle-token-rotation-machine'
const USER_ID = 'user-1'
const DEVICE_ID = deterministicDeviceId(MACHINE_ID, USER_ID)
const JWT_EXPIRED = { data: null, error: { message: 'JWT expired' } }

/** 一枚令牌看到的库:令牌已不是 provider 当前那枚 ⇒ 命令表与 RPC 一律回 401 体。 */
function viewFor(db: MemoryRuntimeIdentityClient, token: string, current: () => string, rejected: string[]) {
  const reject = (what: string) => {
    rejected.push(`${token}:${what}`)
    const chain = { eq: () => chain, select: () => Promise.resolve(JWT_EXPIRED), then: (r: (v: unknown) => unknown) => Promise.resolve(JWT_EXPIRED).then(r) }
    return chain
  }
  return {
    from: (table: string) => {
      if (table === 'gugu_device_commands' && token !== current()) {
        return { select: () => reject('select'), update: () => reject('update') }
      }
      return (db.from as (t: string) => unknown)(table)
    },
    rpc: (fn: string, args: Record<string, unknown>) => {
      if (token !== current()) {
        rejected.push(`${token}:rpc:${fn}`)
        return Promise.resolve(JWT_EXPIRED)
      }
      return db.rpc(fn, args)
    },
  } as unknown as DeviceRuntimeIdentityClient
}

describe('落终态时向 provider 现要令牌', () => {
  test('命令执行期间令牌被换掉:done 用新令牌写进去', async () => {
    const env = await isolatedGuguEnv('gugu-settle-token-')
    await createTestLocalAgent(env, {}, { cache: { acp_engine_id: 'codex' }, status: 'active' })
    const db = new MemoryRuntimeIdentityClient([], { insertError: 'unused', singleError: 'unused' })
    let token = 'token-1'
    const rejected: string[] = []
    let onCommand: ((commandId?: string) => Promise<void>) | null = null
    const host = createDeviceRuntimeHostLoop({
      env,
      intervalMs: 15,
      superviseIntervalMs: 60_000,
      orphanRecoveryIntervalMs: 60_000,
      machineIdentifier: () => MACHINE_ID,
      capabilities: { terminals: [], runtimes: [] },
      authProvider: { getAuth: async () => ({ accessToken: token, userId: USER_ID }) },
      makeIdentityClient: (accessToken) => viewFor(db, accessToken, () => token, rejected),
      runtimeBridge: {
        create: async () => {},
        injectAgentInbox: async () => 'accepted' as const,
        // 停一个会话要一阵子;这期间 provider 刷新了令牌,旧的那枚随即失效。
        stop: async () => { token = 'token-2' },
      },
      subscribeCommandWake: ({ onCommand: wake, onSubscribed }) => {
        onCommand = wake
        onSubscribed?.()
        return () => undefined
      },
      subscribeDeviceRpc: async () => () => undefined,
    })
    host.start()
    try {
      await until('wake 已订上且首轮结束', () => onCommand !== null && !host.getDebugSnapshot().ticking)
      db.add(deviceCommandRow({
        id: 'cmd-stop', deviceId: DEVICE_ID, type: 'agent.stop',
        payload: { agent_user_id: TEST_AGENT_USER_ID }, createdAt: new Date().toISOString(),
      }))
      await onCommand!('cmd-stop')
      await until('命令落定', () => db.row('cmd-stop').status !== 'running' && db.row('cmd-stop').status !== 'pending')
      expect(db.row('cmd-stop')).toMatchObject({ status: 'done', claim_token: null })
      // 阴控:旧令牌在这条用例里确实被库拒过 —— 否则「done 写进去了」证明不了用的是新令牌。
      const probe = viewFor(db, 'token-1', () => token, rejected)
      await probe.rpc('recheck_device_command_execution', { p_id: 'cmd-stop', p_claim_token: 'x' })
      expect(rejected).toContain('token-1:rpc:recheck_device_command_execution')
    } finally {
      await host.stop()
    }
  })
})
