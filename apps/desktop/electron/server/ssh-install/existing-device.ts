import type { RuntimeAuth } from '@gugu/core'
import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase'
import type { ExistingDeviceLookup } from './existing-account'

/** The released install-id is the server's cloud machine_id, not a hardware ID. */
export function cloudExistingDevice(getAuth: () => Promise<RuntimeAuth | null>, tier: string, requestFetch?: typeof fetch): ExistingDeviceLookup {
  return async ({ userId, machineId, signal }) => {
    signal.throwIfAborted()
    const auth = await getAuth()
    if (!auth?.accessToken || auth.userId !== userId) throw new Error('The desktop account changed or is no longer authenticated while reading the existing device')
    const client = createGuguSupabaseClient({ schema: 'identity', accessToken: async () => auth.accessToken,
      ...(requestFetch ? { fetch: requestFetch } : {}) })
    const { data, error } = await client.from('gugu_devices')
      .select('device_id,user_id,machine_id,tier')
      .eq('user_id', userId).eq('machine_id', machineId).eq('tier', tier).limit(2).abortSignal(signal)
    signal.throwIfAborted()
    if ((await getAuth())?.userId !== userId) throw new Error('The desktop account changed while reading the existing device')
    if (error) throw new Error(`Could not read the existing device: ${error.message.replaceAll(auth.accessToken, '[REDACTED]')}`)
    if (!Array.isArray(data) || data.length !== 1) throw new Error('The server installation does not identify exactly one device in this account and environment; its login was preserved')
    const row = data[0]
    if (row.user_id !== userId || row.machine_id !== machineId || row.tier !== tier
      || typeof row.device_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(row.device_id)) {
      throw new Error('The existing device identity is empty, invalid, or belongs to another account or environment')
    }
    return row.device_id
  }
}
