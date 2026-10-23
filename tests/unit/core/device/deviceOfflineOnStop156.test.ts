import { describe, expect, it, vi } from 'vitest'
import { createDeviceRuntimeHostLoop, type DeviceRuntimeIdentityClient } from '@gugu/core'
import { isolatedGuguEnv, pollOnlyRuntimeIdentityClient } from '../../../support/deviceRuntimeHarness'

// #156 机器要走了(退出咕咕 / 停掉服务):设备行当场标离线,名下别的设备马上看见;
// ❌ 不说一声就走,让它们等两分钟租约过期 —— 那与崩溃看起来一模一样。
async function hostWith(label: string, auth: { accessToken: string; userId: string } | null = { accessToken: 'token-1', userId: 'user-1' }) {
  const env = await isolatedGuguEnv(`gugu-offline-on-stop-${label}-`)
  const client = pollOnlyRuntimeIdentityClient([], `offline on stop ${label}`)
  const warn = vi.fn()
  let currentAuth = auth
  const host = createDeviceRuntimeHostLoop({
    env,
    intervalMs: 60_000,
    subscribeCommandWake: () => () => undefined,
    machineIdentifier: () => `machine-${label}`,
    authProvider: { getAuth: async () => currentAuth },
    makeIdentityClient: () => client as unknown as DeviceRuntimeIdentityClient,
    capabilities: { terminals: [], runtimes: [] },
    warn,
  })
  return { host, client, warn, signOut: () => { currentAuth = null } }
}

describe('#156 停机时设备行当场标离线', () => {
  it('停下时把这台的设备行标成离线(只改状态),一次', async () => {
    const { host, client } = await hostWith('once')
    await host.tickOnce()
    const deviceId = client.upserts.at(-1)?.row.device_id
    expect(deviceId).toBeTypeOf('string')
    await host.stop()
    expect(client.offlineUpdates).toHaveLength(1)
    expect(client.offlineUpdates[0]).toMatchObject({ deviceId, value: { status: 'offline' } })
  })

  it('在路上的心跳先落地,再标离线:❌ 心跳(写「在线」)落在后面把它标回在线', async () => {
    const { host, client } = await hostWith('inflight')
    const order: string[] = []
    let land: (() => void) | null = null
    const originalFrom = client.from.bind(client) as (table: string) => Record<string, unknown>
    ;(client as unknown as { from: (table: string) => unknown }).from = (table: string) => {
      const real = originalFrom(table)
      if (table !== 'gugu_devices') return real
      return {
        ...real,
        upsert: () => new Promise((resolve) => { land = () => { order.push('heartbeat'); resolve({ data: null, error: null }) } }),
        update: (value: unknown) => ({ eq: async (column: string, id: string) => { order.push('offline'); return (real.update as (v: unknown) => { eq: (c: string, i: string) => unknown })(value).eq(column, id) } }),
      }
    }
    // 第一拍的心跳正在写:停机要等它
    const beat = host.tickOnce()
    await vi.waitFor(() => expect(land).not.toBeNull())
    const stopping = host.stop()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(order).toEqual([])
    land!()
    await stopping
    await beat.catch(() => undefined)
    expect(order).toEqual(['heartbeat', 'offline'])
  })

  it('停下时已经没有登录态:不写,也不报错', async () => {
    const { host, client, warn, signOut } = await hostWith('signed-out')
    await host.tickOnce()
    signOut()
    await host.stop()
    expect(client.offlineUpdates).toHaveLength(0)
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('offline'))
  })

  it('说不出去(库拒绝 / 断网):停机照样完成,原因记一句', async () => {
    const { host, client, warn } = await hostWith('refused')
    await host.tickOnce()
    const originalFrom = client.from.bind(client) as (table: string) => Record<string, unknown>
    ;(client as unknown as { from: (table: string) => unknown }).from = (table: string) => {
      const real = originalFrom(table)
      if (table !== 'gugu_devices') return real
      return { ...real, update: () => ({ eq: async () => ({ error: { message: 'network down' } }) }) }
    }
    await host.stop()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not mark this device offline on stop: network down'))
  })
})
