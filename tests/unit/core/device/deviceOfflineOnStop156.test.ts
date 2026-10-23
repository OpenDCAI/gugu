import { describe, expect, it, vi } from 'vitest'
import { createDeviceRuntimeHostLoop, type DeviceRuntimeIdentityClient } from '@gugu/core'
import { isolatedGuguEnv, pollOnlyRuntimeIdentityClient } from '../../../support/deviceRuntimeHarness'

// #156 机器要走了(退出咕咕 / 停掉服务):设备行当场标离线,名下别的设备马上看见;
// ❌ 不说一声就走,让它们等两分钟租约过期 —— 那与崩溃看起来一模一样。
async function hostWith(
  label: string,
  auth: { accessToken: string; userId: string } | null = { accessToken: 'token-1', userId: 'user-1' },
  timing: { heartbeatIntervalMs?: number } = {},
  shared?: { client: ReturnType<typeof pollOnlyRuntimeIdentityClient>; machine: string },
) {
  const env = await isolatedGuguEnv(`gugu-offline-on-stop-${label}-`)
  const client = shared?.client ?? pollOnlyRuntimeIdentityClient([], `offline on stop ${label}`)
  const warn = vi.fn()
  let currentAuth = auth
  const host = createDeviceRuntimeHostLoop({
    env,
    intervalMs: 60_000,
    superviseIntervalMs: 60_000,
    ...timing,
    subscribeCommandWake: () => () => undefined,
    machineIdentifier: () => shared?.machine ?? `machine-${label}`,
    authProvider: { getAuth: async () => currentAuth },
    makeIdentityClient: () => client as unknown as DeviceRuntimeIdentityClient,
    capabilities: { terminals: [], runtimes: [] },
    warn,
  })
  return { host, client, warn, signOut: () => { currentAuth = null } }
}

async function instancesOf(client: ReturnType<typeof pollOnlyRuntimeIdentityClient>, deviceId: string) {
  const table = (client as unknown as { from: (t: 'runtime_instances') => { select: (c: string) => { eq: (k: string, v: string) => PromiseLike<{ data: unknown[] }> } } }).from('runtime_instances')
  return (await table.select('instance_id, last_heartbeat_at').eq('device_id', deviceId)).data
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

  it('定时那一拍心跳正在写时停机:先等它落地,再标离线(❌ 心跳写的「在线」落在后面,把它标回在线)', async () => {
    const { host, client } = await hostWith('inflight', undefined, { heartbeatIntervalMs: 20 })
    const order: string[] = []
    let land: (() => void) | null = null
    host.start()
    // 首轮 tick(它自己也写一拍)走完,之后的心跳只来自定时那一拍,与 tick 无关
    await vi.waitFor(() => expect(client.upserts.length).toBeGreaterThan(0))
    await vi.waitFor(() => expect(host.getDebugSnapshot().status).toBe('running'))
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
    await vi.waitFor(() => expect(land).not.toBeNull())
    const stopping = host.stop()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(order).toEqual([])
    land!()
    await stopping
    expect(order).toEqual(['heartbeat', 'offline'])
  })

  it('同机同账号的另一个实例还活着(两个共用这一行):不标离线;那一个早已没了心跳(过了租约):照常标', async () => {
    const { host, client } = await hostWith('sibling')
    await host.tickOnce()
    const deviceId = client.upserts.at(-1)?.row.device_id as string
    client.setRuntimeInstance('other-instance', deviceId, new Date().toISOString())
    await host.stop()
    expect(client.offlineUpdates).toHaveLength(0)

    const second = await hostWith('sibling-gone')
    await second.host.tickOnce()
    const secondDevice = second.client.upserts.at(-1)?.row.device_id as string
    second.client.setRuntimeInstance('crashed-instance', secondDevice, new Date(Date.now() - 120_000).toISOString())
    await second.host.stop()
    expect(second.client.offlineUpdates).toHaveLength(1)
  })

  it('停下时先注销自己这个实例:同机的兄弟、孤儿回收当场知道它走了(❌ 等 90 s 心跳过期)', async () => {
    const { host, client } = await hostWith('retire')
    await host.tickOnce()
    const deviceId = client.upserts.at(-1)?.row.device_id as string
    expect(await instancesOf(client, deviceId)).toHaveLength(1)
    await host.stop()
    expect(await instancesOf(client, deviceId)).toHaveLength(0)
  })

  it('同机两个实例先后停:先停的不说,后停的说;一起停(关机):至少一个说', async () => {
    const shared = { client: pollOnlyRuntimeIdentityClient([], 'offline on stop pair'), machine: 'machine-pair' }
    const first = await hostWith('pair-a', undefined, {}, shared)
    const second = await hostWith('pair-b', undefined, {}, shared)
    await first.host.tickOnce()
    await second.host.tickOnce()
    const deviceId = shared.client.upserts.at(-1)?.row.device_id as string
    expect(shared.client.upserts.map((u) => u.row.device_id)).toEqual(expect.arrayContaining([deviceId]))
    expect(await instancesOf(shared.client, deviceId)).toHaveLength(2)
    await first.host.stop()
    expect(shared.client.offlineUpdates).toHaveLength(0)
    await second.host.stop()
    expect(shared.client.offlineUpdates).toHaveLength(1)

    const together = { client: pollOnlyRuntimeIdentityClient([], 'offline on stop together'), machine: 'machine-together' }
    const a = await hostWith('together-a', undefined, {}, together)
    const b = await hostWith('together-b', undefined, {}, together)
    await a.host.tickOnce()
    await b.host.tickOnce()
    await Promise.all([a.host.stop(), b.host.stop()])
    expect(together.client.offlineUpdates.length).toBeGreaterThanOrEqual(1)
  })

  it('停下之后再叫它跑一轮(比如中转变了):不跑,❌ 重新订阅、写一拍「在线」把离线翻回去', async () => {
    const { host, client } = await hostWith('after-stop')
    await host.tickOnce()
    await host.stop()
    const upserts = client.upserts.length
    expect(await host.tickOnce()).toEqual({ skipped: true })
    expect(client.upserts).toHaveLength(upserts)
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
