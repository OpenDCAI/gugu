// #6264 咕咕 server 的机器上限(owner:「远程 SSH 不限。其实总机器上限就是 10 台，但是那个云机器上限就是 3 台」)。
// 库在两处拦(gugu-supabase 迁移 *_machine_limits_6264):登录时 poll 回 machine_limit;心跳时 DEVICE_LIMIT_REACHED。
// 这里判客户端把两种形状读成同一个原因、说成同一句人话,以及各个出口(server 终端、桌面 SSH 那条、宿主日志)都接上了。
import { describe, expect, it, vi } from 'vitest'
import {
  createDeviceRuntimeHostLoop,
  machineLimitMessage,
  machineLimitRefusalFromError,
  parseMachineLimitRefusal,
  recentMachineLimitRefusal,
  type DeviceRuntimeIdentityClient,
} from '@gugu/core'
import { machineLimitFromLoginError, parseLoginOutput, LOGIN_ERROR_MARK } from '../../../../apps/desktop/electron/server/ssh-install/logic'
import { isolatedGuguEnv, pollOnlyRuntimeIdentityClient } from '../../../support/deviceRuntimeHarness'

describe('#6264 机器上限:读原因', () => {
  it('poll 的回包与心跳的错误读成同一个原因;形状不对 = null', () => {
    expect(parseMachineLimitRefusal({ error: 'machine_limit', limit: 'tunnel', used: 3, max: 3, plan: 'default' }))
      .toEqual({ limit: 'tunnel', used: 3, max: 3 })
    expect(machineLimitRefusalFromError(new Error('DEVICE_LIMIT_REACHED: {"max": 10, "plan": "default", "used": 10, "limit": "total"}')))
      .toEqual({ limit: 'total', used: 10, max: 10 })
    expect(machineLimitRefusalFromError('boom: network')).toBeNull()
    expect(parseMachineLimitRefusal({ limit: 'phones', used: 1, max: 1 })).toBeNull()
    expect(parseMachineLimitRefusal('not json')).toBeNull()
  })

  it('人话:哪条上限、已经连了几台;远程隧道那条点明 SSH 添加的不占名额', () => {
    expect(machineLimitMessage({ limit: 'total', used: 10, max: 10 })).toBe('你的账号最多连 10 台咕咕 server，已经连了 10 台。')
    expect(machineLimitMessage({ limit: 'tunnel', used: 3, max: 3 })).toContain('远程隧道')
    expect(machineLimitMessage({ limit: 'tunnel', used: 3, max: 3 })).toContain('远程 SSH 添加的机器不占这个名额')
    expect(machineLimitMessage(null)).toContain('到上限')
  })

  it('桌面经 SSH 装:登录那一步打的标记读成上限原因,别的登录错误不是', () => {
    const outcome = parseLoginOutput(`${LOGIN_ERROR_MARK}machine_limit {"limit":"total","used":10,"max":10}\n没有登上:…\n`)
    expect(outcome).toEqual({ ok: false, error: 'machine_limit {"limit":"total","used":10,"max":10}' })
    expect(machineLimitFromLoginError(outcome.ok ? null : outcome.error)).toEqual({ refusal: { limit: 'total', used: 10, max: 10 } })
    expect(machineLimitFromLoginError('machine_limit')).toEqual({ refusal: null })
    expect(machineLimitFromLoginError('expired_token')).toBeNull()
    expect(machineLimitFromLoginError(null)).toBeNull()
  })

  it('远程隧道那一段问「刚才是不是因为上限被拒」:有就带上机器名,没有 = null,出错照实抛', async () => {
    const rpc = vi.fn(async () => ({ data: { limit: 'tunnel', used: 3, max: 3, hostname: 'gpu-9' }, error: null }))
    expect(await recentMachineLimitRefusal({ rpc }, '2026-09-24T00:00:00.000Z')).toEqual({ limit: 'tunnel', used: 3, max: 3, hostname: 'gpu-9' })
    expect(rpc).toHaveBeenCalledWith('my_recent_machine_limit_refusal', { p_since: '2026-09-24T00:00:00.000Z' })
    expect(await recentMachineLimitRefusal({ rpc: async () => ({ data: null, error: null }) }, 'x')).toBeNull()
    await expect(recentMachineLimitRefusal({ rpc: async () => ({ data: null, error: { message: 'nope' } }) }, 'x')).rejects.toThrow('nope')
  })
})

describe('#6264 机器上限:心跳被拒 ⇒ 宿主日志里说一次人话', () => {
  it('DEVICE_LIMIT_REACHED 只 warn 一次,且是人话;别的心跳错误不说', async () => {
    const env = await isolatedGuguEnv('gugu-machine-limit-6264-')
    const client = pollOnlyRuntimeIdentityClient([], 'machine limit #6264')
    let upsertError = 'boom: network'
    const originalFrom = client.from.bind(client) as (table: string) => unknown
    ;(client as unknown as { from: (table: string) => unknown }).from = (table: string) => {
      const real = originalFrom(table) as Record<string, unknown>
      if (table !== 'gugu_devices') return real
      return { ...real, upsert: async () => ({ data: null, error: { message: upsertError } }) }
    }
    const warn = vi.fn()
    const host = createDeviceRuntimeHostLoop({
      env,
      intervalMs: 60_000,
      subscribeCommandWake: () => () => undefined,
      machineIdentifier: () => 'machine-limit-6264',
      authProvider: { getAuth: async () => ({ accessToken: 'token-1', userId: 'user-1' }) },
      makeIdentityClient: () => client as unknown as DeviceRuntimeIdentityClient,
      capabilities: { terminals: [], runtimes: [] },
      warn,
    })
    await host.tickOnce().catch(() => undefined)
    const limitWarnings = () => warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('没能加入账号'))
    expect(limitWarnings()).toHaveLength(0)
    upsertError = 'DEVICE_LIMIT_REACHED: {"limit": "tunnel", "used": 3, "max": 3, "plan": "default"}'
    await host.tickOnce().catch(() => undefined)
    await host.tickOnce().catch(() => undefined)
    expect(limitWarnings()).toHaveLength(1)
    expect(limitWarnings()[0]).toContain('最多 3 台，你已经连了 3 台')
    expect(limitWarnings()[0]).toContain('设置 → 设备')
    await host.stop()
  })
})
