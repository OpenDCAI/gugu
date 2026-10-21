import { describe, expect, test } from 'vitest'
import {
  AGENT_CLOUD_IDENTITY_STATE_CACHE_KEY,
  createDeviceRuntimeHostLoop,
  type DeviceRuntimeIdentityClient,
} from '@gugu/core'
import { awaitFact } from '../../../support/awaitFact'
import {
  createTestLocalAgent,
  isolatedGuguEnv,
  pollOnlyRuntimeIdentityClient,
} from '../../../support/deviceRuntimeHarness'

// #6938 gone 守卫删掉的名册行交给宿主,宿主据此收回发给它的卡。只交**真删掉**的:公网身份还在铸的行(#5331)留着,
// 它的卡也就照留。
describe('#6938 gone 守卫把真删掉的名册行交给宿主', () => {
  test('原因是 cloud-gone;公网身份还在铸的行不交', async () => {
    const env = await isolatedGuguEnv('gugu-gone-revokes-6938-')
    const MINTING = 'agent-minting-now'
    const GONE = 'agent-deleted-elsewhere'
    await createTestLocalAgent(
      env,
      { name: 'Minting', gugu_user_id: MINTING },
      { cache: { [AGENT_CLOUD_IDENTITY_STATE_CACHE_KEY]: 'pending' } },
    )
    await createTestLocalAgent(env, { name: 'Gone', gugu_user_id: GONE })
    const client = pollOnlyRuntimeIdentityClient([], 'gone revokes 6938')
    const rpc = client.rpc.bind(client)
    client.rpc = (async (fn: string, args: Record<string, unknown>) => {
      const result = await rpc(fn, args)
      if (fn !== 'set_agent_runtime_state') return result
      return { data: null, error: { message: 'agent is not writable by current user' } }
    }) as typeof client.rpc
    const removed: Array<[string, string]> = []
    const host = createDeviceRuntimeHostLoop({
      env,
      intervalMs: 20,
      subscribeCommandWake: () => () => undefined,
      machineIdentifier: () => 'gone-revokes-machine',
      capabilities: { terminals: [], runtimes: [] },
      authProvider: { getAuth: async () => ({ accessToken: 'token', userId: 'owner-1' }) },
      makeIdentityClient: () => client as unknown as DeviceRuntimeIdentityClient,
      onAgentRosterRemoved: (agent, reason) => { removed.push([agent.gugu_user_id, reason]) },
    })
    host.start()
    try {
      await awaitFact('gone 的行删掉之后交给了宿主', async () => (removed.length > 0 ? true : undefined))
    } finally {
      await host.stop()
    }
    expect(removed).toEqual([[GONE, 'cloud-gone']])
  })
})
