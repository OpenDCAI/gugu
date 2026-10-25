// #7317 —— 这台电脑能被调用的动作一变(Computer Use 开 / 关),登记在心跳里的清单当场重写,❌ 等下一拍心跳。
// Mac 实测(b6acdaa4):停用后 agent 读到的清单仍是 25 个可用的 computer.* —— 重新登记走的是 tickOnce,而 tick 只在
// 心跳到期(30 s 一拍)时才写。判据读的是写进 gugu_devices 的那几行。
import { describe, expect, test } from 'vitest'
import { createDeviceRuntimeHostLoop, type DeviceRuntimeIdentityClient } from '@gugu/core'
import type { DeviceActionsCapability } from '@gugu/core/shared/deviceActions'
import { isolatedGuguEnv, MemoryRuntimeIdentityClient } from '../../../support/deviceRuntimeHarness'
import { until } from '../../../support/awaitCondition'

const USER_ID = 'user-7317'

function hostWith(env: NodeJS.ProcessEnv, client: MemoryRuntimeIdentityClient, actions: () => DeviceActionsCapability) {
  let auths = 0
  const host = createDeviceRuntimeHostLoop({
    env,
    intervalMs: 15,
    superviseIntervalMs: 60_000,
    // The periodic heartbeat must not be what writes the new list within this test.
    heartbeatIntervalMs: 60_000,
    machineIdentifier: () => 'device-actions-7317-machine',
    capabilities: { terminals: [], runtimes: [] },
    deviceActions: actions,
    authProvider: { getAuth: async () => { auths += 1; return { accessToken: 'token', userId: USER_ID } } },
    makeIdentityClient: () => client as unknown as DeviceRuntimeIdentityClient,
    runtimeBridge: { create: async () => {}, injectAgentInbox: async () => 'accepted' as const, stop: async () => {} },
    subscribeCommandWake: ({ onSubscribed }) => {
      onSubscribed?.()
      return () => undefined
    },
  })
  return { host, auths: () => auths }
}

const offList = (client: MemoryRuntimeIdentityClient) =>
  client.upserts.map((u) => ((u.row.capabilities as { actions?: DeviceActionsCapability } | undefined)?.actions?.switched_off ?? null))

describe('#7317 device actions are re-registered the moment they change', () => {
  test('switched on after the first heartbeat: the new list is written at once, not at the next one', async () => {
    const env = await isolatedGuguEnv('gugu-7317-actions-')
    const client = new MemoryRuntimeIdentityClient([], { insertError: 'not used', singleError: 'not used' })
    let on = false
    const { host, auths } = hostWith(env, client, () => ({
      v: 1,
      actions: [],
      ...(on ? {} : { switched_off: [{ group: 'computer', detail: 'Computer Use is off' }] }),
    }))
    // Not started: nothing is written and nobody is asked for auth (at boot the renderer cannot answer yet).
    host.notifyDeviceActionsChanged()
    expect(client.upserts).toHaveLength(0)
    expect(auths()).toBe(0)
    host.start()
    try {
      await until('first heartbeat written', () => client.upserts.length >= 1 && !host.getDebugSnapshot().ticking)
      expect(offList(client).at(-1)).toEqual([{ group: 'computer', detail: 'Computer Use is off' }])
      const written = client.upserts.length
      on = true
      host.notifyDeviceActionsChanged()
      await until('the changed list written', () => client.upserts.length > written)
      expect(offList(client).at(-1)).toBeNull()
    } finally {
      await host.stop()
    }
    // Control: stopped, it writes no more.
    const after = client.upserts.length
    host.notifyDeviceActionsChanged()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(client.upserts).toHaveLength(after)
  })
})
