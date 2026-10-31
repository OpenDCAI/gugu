// 本机 agent 的 presence 对账:一次批量读云端的行,只写与云端不一样的那几行。
//
// 10-22 读数:一台 82 个 agent 的机器每小时 2 816 发 set_agent_runtime_state,2 508 发是每 120 s 给每个 agent 重写一遍
// online 的巡检,真变化只有 308 发;一轮巡检的代价随空闲会话数线性长。这里判:5 个与 100 个空闲 agent,一轮对账都是
// 1 发读、0 发写;云端卡着 running 的那一行开机就改回来;别处删掉的 agent 由这一读认出来并收回名册行。
import { describe, expect, test } from 'vitest'
import {
  AGENT_CLOUD_IDENTITY_STATE_CACHE_KEY,
  createDeviceRuntimeHostLoop,
  listAgents,
  type DeviceRuntimeIdentityClient,
} from '@gugu/core'
import type { AgentStatusReading } from '@gugu/core/shared/agentStatus'
import {
  createTestLocalAgent,
  isolatedGuguEnv,
  MemoryRuntimeIdentityClient,
  presenceRow,
} from '../../../support/deviceRuntimeHarness'
import { until } from '../../../support/awaitCondition'

const OWNER = 'owner-1'

async function hostWith(env: NodeJS.ProcessEnv, client: MemoryRuntimeIdentityClient, readings: Map<string, AgentStatusReading>) {
  const removed: Array<[string, string]> = []
  const warnings: string[] = []
  const host = createDeviceRuntimeHostLoop({
    env,
    intervalMs: 15,
    superviseIntervalMs: 60_000,
    subscribeCommandWake: ({ onSubscribed }) => (onSubscribed?.(), () => undefined),
    machineIdentifier: () => 'presence-reconcile-machine',
    capabilities: { terminals: [], runtimes: [] },
    authProvider: { getAuth: async () => ({ accessToken: 'token', userId: OWNER }) },
    makeIdentityClient: () => client as unknown as DeviceRuntimeIdentityClient,
    runtimeBridge: {
      create: async () => {},
      injectAgentInbox: async () => 'accepted' as const,
      stop: async () => {},
      agentStatus: (agentUserId: string) => readings.get(agentUserId) ?? null,
    },
    onAgentRosterRemoved: (agent, reason) => { removed.push([agent.gugu_user_id, reason]) },
    warn: (message) => warnings.push(message),
  })
  return { host, removed, warnings }
}

const newClient = () => new MemoryRuntimeIdentityClient([], { insertError: 'unused', singleError: 'unused' })
const working: AgentStatusReading = { status: 'working', detail: 'running', running: true, background: null }

describe('presence 对账:一次批量读,只写不一样的', () => {
  test.each([5, 100])('%i 个空闲 agent:1 发读,0 发写;本机读数一变只写那一个', async (n) => {
    const env = await isolatedGuguEnv(`gugu-presence-reconcile-${n}-`)
    for (let i = 0; i < n; i += 1) await createTestLocalAgent(env, { name: `idle-${i}`, gugu_user_id: `agent-${i}` })
    const client = newClient()
    const readings = new Map<string, AgentStatusReading>()
    const { host } = await hostWith(env, client, readings)
    host.start()
    try {
      await until('开机对账读过云端', () => client.presenceBatchCalls >= 1)
      // 阳控:边沿发布确实在对账之后转着 —— 本机一个读数变了,恰好写那一行。
      readings.set('agent-3', working)
      await until('那一行的变化写上去了', () => client.runtimeStateCalls.length >= 1)
      expect(client.runtimeStateCalls.map((call) => call.p_agent_user_id)).toEqual(['agent-3'])
      expect(client.presenceBatchCalls, '≤200 个 agent 一发读就够').toBe(1)
    } finally {
      await host.stop()
    }
  })

  test('云端卡着 running(上一次宿主没收尾),本机空闲:开机就写回空闲,只写这一行', async () => {
    const env = await isolatedGuguEnv('gugu-presence-reconcile-stale-')
    await createTestLocalAgent(env, { name: 'stale', gugu_user_id: 'agent-stale' })
    await createTestLocalAgent(env, { name: 'fine', gugu_user_id: 'agent-fine' })
    const client = newClient()
    client.presence.set('agent-stale', presenceRow('agent-stale', {
      activity_status: 'running', agent_status: 'working', agent_status_detail: 'running',
    }))
    const { host } = await hostWith(env, client, new Map())
    host.start()
    try {
      await until('卡住的那一行被写回', () => client.runtimeStateCalls.length >= 1)
      expect(client.runtimeStateCalls).toEqual([expect.objectContaining({
        p_agent_user_id: 'agent-stale', p_activity_status: 'idle', p_agent_status: null,
      })])
    } finally {
      await host.stop()
    }
  })

  test('removed 收回名册行(cloud-removed);unauthorized 只说一声、留着;公网身份还在铸的行不去问', async () => {
    const env = await isolatedGuguEnv('gugu-presence-reconcile-gone-')
    await createTestLocalAgent(env, { name: 'gone', gugu_user_id: 'agent-gone' })
    await createTestLocalAgent(env, { name: 'opaque', gugu_user_id: 'agent-opaque' })
    await createTestLocalAgent(env, { name: 'minting', gugu_user_id: 'agent-minting' },
      { cache: { [AGENT_CLOUD_IDENTITY_STATE_CACHE_KEY]: 'pending' } })
    const client = newClient()
    client.presence.set('agent-gone', presenceRow('agent-gone', { account_status: 'removed' }))
    client.presence.set('agent-opaque', { status: 'unauthorized' })
    const asked: string[][] = []
    const rpc = client.rpc.bind(client)
    client.rpc = (async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'get_agent_presence_batch') asked.push(args.p_agent_user_ids as string[])
      return rpc(fn, args)
    }) as typeof client.rpc
    const { host, removed, warnings } = await hostWith(env, client, new Map())
    host.start()
    try {
      await until('删掉的那一行交给了宿主', () => removed.length >= 1)
    } finally {
      await host.stop()
    }
    expect(removed).toEqual([['agent-gone', 'cloud-removed']])
    expect((await listAgents(env)).map((agent) => agent.gugu_user_id).sort()).toEqual(['agent-minting', 'agent-opaque'])
    expect(asked[0].sort()).toEqual(['agent-gone', 'agent-opaque'])
    expect(warnings.some((message) => message.includes('agent-opaque is unauthorized'))).toBe(true)
  })
})
