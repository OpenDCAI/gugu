import { describe, expect, test } from 'vitest'
import {
  AGENT_CLOUD_IDENTITY_STATE_CACHE_KEY,
  createDeviceRuntimeHostLoop,
  listAgents,
  type DeviceRuntimeIdentityClient,
} from '@gugu/core'
import { awaitFact } from '../../../support/awaitFact'
import {
  createTestLocalAgent,
  isolatedGuguEnv,
  pollOnlyRuntimeIdentityClient,
  presenceRow,
} from '../../../support/deviceRuntimeHarness'
describe('#5331 公网身份还在飞的名册行不许被 gone-agent 守卫收走', () => {
  test('同一轮巡扫:pending 的行留着,真 gone 的行照删', async () => {
    const env = await isolatedGuguEnv('gugu-pending-identity-5331-')
    const MINTING = 'agent-minting-now'
    const GONE = 'agent-deleted-elsewhere'
    await createTestLocalAgent(
      env,
      { name: 'Minting', gugu_user_id: MINTING },
      { cache: { [AGENT_CLOUD_IDENTITY_STATE_CACHE_KEY]: 'pending' } },
    )
    await createTestLocalAgent(env, { name: 'Gone', gugu_user_id: GONE })
    const client = pollOnlyRuntimeIdentityClient([], 'pending identity 5331')
    // 别处删掉的 agent:主人读得到它的墓碑(account_status='removed'),对账那一读据此收回名册行。
    client.presence.set(GONE, presenceRow(GONE, { account_status: 'removed' }))
    const rpc = client.rpc.bind(client)
    client.rpc = (async (fn: string, args: Record<string, unknown>) => {
      const result = await rpc(fn, args)
      if (fn !== 'set_agent_runtime_state') return result
      return { data: null, error: { message: 'agent is not writable by current user' } }
    }) as typeof client.rpc
    const host = createDeviceRuntimeHostLoop({
      env,
      intervalMs: 20,
      // 宿主不轮询命令,start() 要求一个事件源(#5906);这条用例不关心命令到达,给一个永不触发的。
      subscribeCommandWake: () => () => undefined,
      machineIdentifier: () => 'pending-identity-machine',
      capabilities: { terminals: [], runtimes: [] },
      authProvider: { getAuth: async () => ({ accessToken: 'token', userId: 'owner-1' }) },
      makeIdentityClient: () => client as unknown as DeviceRuntimeIdentityClient,
    })
    host.start()
    try {
      // 名册在盘上,读它是异步的:等「那一行没了」这个事实,❌ 5 秒上限(每一轮巡扫都有真 fs 读写)。
      await awaitFact(
        '真 gone 的名册行被这一轮巡扫收走(阳控:守卫是活的)',
        async () => ((await rosterIds(env)).includes(GONE) ? undefined : true),
      )
      expect(
        await rosterIds(env),
        '公网身份还在铸的行必须留着:删了它,后台那一发回写就找不到行,会话卡在没有公网身份上',
      ).toContain(MINTING)
    } finally {
      await host.stop()
    }
    expect(await rosterIds(env)).toContain(MINTING)
  })
})
async function rosterIds(env: NodeJS.ProcessEnv): Promise<string[]> {
  return (await listAgents(env, { includeGuests: true })).map((agent) => agent.gugu_user_id)
}
