/**
 * `gugu-server unregister` 的生产装配(判断全在 server-unregister.ts):GoTrue 换令牌 / 注销、库里移除这台机器。
 * 每个网络请求 10 秒上限:卸载不为网络卡住。
 */
import { removeDevice, type DeviceRpcClient } from '@gugu/core/cloud/devices'
import { getSupabaseAnonKey, getSupabaseUrl } from '@gugu/core/cloud/config'
import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase'
import { clearStoredServerSession, readStoredServerSession } from './server-auth'
import { deviceIdForAccount } from './server-login'
import { runUnregister } from './server-unregister'

export async function unregisterAccountNow(userId: string, out: (line: string) => void): Promise<void> {
  const base = getSupabaseUrl().replace(/\/$/, '')
  const anonKey = getSupabaseAnonKey()
  await runUnregister({
    readSession: () => {
      try {
        return readStoredServerSession()
      } catch {
        return null
      }
    },
    refresh: async (refreshToken) => {
      const response = await fetch(`${base}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { apikey: anonKey, 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) return null
      const body = (await response.json()) as { access_token?: unknown }
      return typeof body.access_token === 'string' ? body.access_token : null
    },
    deviceId: (accessToken) => deviceIdForAccount(userId, accessToken),
    removeDevice: async (accessToken, deviceId) => {
      const client = createGuguSupabaseClient({ schema: 'identity', headers: { Authorization: `Bearer ${accessToken}` } })
      await removeDevice(client as unknown as DeviceRpcClient, deviceId, { cascade: false })
    },
    revoke: async (accessToken) => {
      const response = await fetch(`${base}/auth/v1/logout?scope=local`, {
        method: 'POST',
        headers: { apikey: anonKey, authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok && response.status !== 204) throw new Error(`logout ${response.status}`)
    },
    clearLocal: () => clearStoredServerSession(),
    out,
  })
}
