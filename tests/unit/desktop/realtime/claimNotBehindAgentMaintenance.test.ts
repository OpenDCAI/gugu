// 认领命令那条 tick 不许排在逐 agent 的维护后面。
//
// 10-22 读数:一台挂着 80 个 agent 的机器重启后,每 120 s 一次的在线巡检(逐个 set_agent_runtime_state)放在 tick 里、
// 认领之前,单程拖到 11–30 s;wake 事件与对账节拍都排在这一轮后面,消息到认领 p50 12 s、最长 47 s。
// 维护现在跑在 activity 的 flight 上(#4008),这里判两件事:维护卡住时命令照样被认领;令牌档只在令牌变了才重写。
import { mkdir, readFile, rm } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'
import {
  agentRuntimeSessionFile,
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
import { awaitFact } from '../../../support/awaitFact'

const MACHINE_ID = 'claim-not-behind-maintenance'
const USER_ID = 'user-1'
const DEVICE_ID = deterministicDeviceId(MACHINE_ID, USER_ID)
const FETCH = 'fetch_fair_pending_device_commands'

/** 在线巡检的那一发 RPC 可以被扣住,模拟巡检单程拖到几十秒。 */
class GatedSweepClient extends MemoryRuntimeIdentityClient {
  readonly calls = new Map<string, number>()
  sweepGate: Promise<void> | null = null

  count(fn: string): number {
    return this.calls.get(fn) ?? 0
  }

  async rpc(fn: string, args: Record<string, unknown>): ReturnType<MemoryRuntimeIdentityClient['rpc']> {
    this.calls.set(fn, this.count(fn) + 1)
    if (fn === 'set_agent_runtime_state' && this.sweepGate) await this.sweepGate
    return super.rpc(fn, args)
  }
}

function startedHost(env: NodeJS.ProcessEnv, client: GatedSweepClient, getToken: () => string, superviseIntervalMs = 60_000) {
  let announce: ((commandId?: string) => Promise<void>) | null = null
  const host = createDeviceRuntimeHostLoop({
    env,
    intervalMs: 15,
    superviseIntervalMs,
    machineIdentifier: () => MACHINE_ID,
    capabilities: { terminals: [], runtimes: [] },
    authProvider: { getAuth: async () => ({ accessToken: getToken(), refreshToken: 'refresh', userId: USER_ID }) },
    makeIdentityClient: () => client as unknown as DeviceRuntimeIdentityClient,
    runtimeBridge: {
      create: async () => {},
      injectAgentInbox: async () => 'accepted' as const,
      stop: async () => {},
    },
    subscribeCommandWake: ({ onCommand, onSubscribed }) => {
      announce = onCommand
      onSubscribed?.()
      return () => undefined
    },
  })
  return { host, wake: () => announce }
}

async function sessionTokenOnDisk(env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    return (JSON.parse(await readFile(agentRuntimeSessionFile(TEST_AGENT_USER_ID, env), 'utf8')) as { access_token: string })
      .access_token
  } catch {
    return null
  }
}

describe('认领命令不排在逐 agent 的维护后面', () => {
  test('在线巡检卡住时,wake 叫来的命令照样被认领', async () => {
    const env = await isolatedGuguEnv('gugu-claim-not-behind-sweep-')
    await createTestLocalAgent(env, {}, { cache: { acp_engine_id: 'codex' }, status: 'active' })
    const client = new GatedSweepClient([], { insertError: 'unused', singleError: 'unused' })
    let releaseSweep!: () => void
    client.sweepGate = new Promise((resolve) => { releaseSweep = resolve })
    const { host, wake } = startedHost(env, client, () => 'token')
    host.start()
    try {
      await until('巡检的那一发已经发出并被扣住', () => client.count('set_agent_runtime_state') >= 1)
      await until('wake 已订上', () => wake() !== null)
      client.add(deviceCommandRow({
        id: 'cmd-stop', deviceId: DEVICE_ID, type: 'agent.stop',
        payload: { agent_user_id: TEST_AGENT_USER_ID }, createdAt: new Date().toISOString(),
      }))
      const fetchesBefore = client.count(FETCH)
      // 不 await:agent.stop 自己也要写 presence,在扣着的闸后面落不了终态;判的是「认领了」。
      void wake()!('cmd-stop')
      await until('巡检还卡着,命令已被认领', () => client.row('cmd-stop').status !== 'pending')
      expect(client.count(FETCH)).toBeGreaterThan(fetchesBefore)
    } finally {
      releaseSweep()
      await host.stop()
    }
  })

  test('令牌档只在令牌变了才整批重写;没写成的下一轮补写', async () => {
    const env = await isolatedGuguEnv('gugu-runtime-session-on-token-change-')
    await createTestLocalAgent(env, {}, { cache: { acp_engine_id: 'codex' }, status: 'active' })
    // 目标路径先被一个目录占着 ⇒ 这一档写不成。
    const blocker = agentRuntimeSessionFile(TEST_AGENT_USER_ID, env)
    await mkdir(`${blocker}/occupied`, { recursive: true })
    const client = new GatedSweepClient([], { insertError: 'unused', singleError: 'unused' })
    let token = 'token-1'
    // 对账节拍 100 ms:没写成的那一档按它重试。
    const { host, wake } = startedHost(env, client, () => token, 100)
    host.start()
    try {
      await until('首轮 tick 已拿到鉴权', () => client.count(FETCH) >= 1)
      await until('巡检跑过(阳控:维护的 flight 在转)', () => client.count('set_agent_runtime_state') >= 1)
      await rm(blocker, { recursive: true })
      await awaitFact('没写成的那一档在下一轮补上,令牌不变也补', async () => ((await sessionTokenOnDisk(env)) === 'token-1' ? true : undefined))
      const written = await readFile(blocker, 'utf8')
      const fetches = client.count(FETCH)
      for (let i = 0; i < 3; i += 1) await wake()!()
      expect(client.count(FETCH), '阳控:tick 确实又跑了几轮').toBeGreaterThanOrEqual(fetches + 3)
      expect(await readFile(blocker, 'utf8'), '令牌没变,这一档一个字节都不重写').toBe(written)
      token = 'token-2'
      await wake()!()
      await awaitFact('令牌一变就整批重写', async () => ((await sessionTokenOnDisk(env)) === 'token-2' ? true : undefined))
    } finally {
      await host.stop()
    }
  })
})
