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
  presenceRow,
} from '../../../support/deviceRuntimeHarness'

// #6938 gone 守卫删掉的名册行交给宿主,宿主据此收回发给它的卡。只交**真删掉**的:公网身份还在铸的行(#5331)留着,
// 它的卡也就照留。
describe('#6938 gone 守卫把真删掉的名册行交给宿主', () => {
  test('an owner-less legacy row rejected as not writable is not a confirmed deletion', async () => {
    const env = await isolatedGuguEnv('gugu-not-writable-997-')
    const agentId = 'legacy-other-account'
    await createTestLocalAgent(env, { name: 'Legacy', gugu_user_id: agentId })
    const client = pollOnlyRuntimeIdentityClient([], 'not writable is not deleted')
    client.presence.set(agentId, presenceRow(agentId, { activity_status: 'running' }))
    const rpc = client.rpc.bind(client)
    client.rpc = (async (fn: string, args: Record<string, unknown>) => fn === 'set_agent_runtime_state'
      ? { data: null, error: { message: 'agent is not writable by current user' } }
      : rpc(fn, args)) as typeof client.rpc
    const removed: string[] = []
    const host = createDeviceRuntimeHostLoop({
      env, intervalMs: 20, subscribeCommandWake: () => () => undefined,
      machineIdentifier: () => 'not-writable-machine', capabilities: { terminals: [], runtimes: [] },
      authProvider: { getAuth: async () => ({ accessToken: 'token', userId: 'new-owner' }) },
      makeIdentityClient: () => client as unknown as DeviceRuntimeIdentityClient,
      onAgentRosterRemoved: (_agent, reason) => { removed.push(reason) },
    })
    host.start()
    try {
      await awaitFact('not-writable row reached the host', async () => removed.length ? true : undefined)
    } finally { await host.stop() }
    expect(removed).toEqual(['cloud-gone'])
  })

  test('明确 removed 才给 cloud-removed;公网身份还在铸的行不交', async () => {
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
    // 别处删掉的 agent:主人读得到它的墓碑(account_status='removed'),对账那一读据此收回名册行。
    client.presence.set(GONE, presenceRow(GONE, { account_status: 'removed' }))
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
    expect(removed).toEqual([[GONE, 'cloud-removed']])
  })
})
