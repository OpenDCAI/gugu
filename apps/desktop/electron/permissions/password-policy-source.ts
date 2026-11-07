import { randomUUID } from 'node:crypto'
import { anySignal } from '@gugu/core/shared/anySignal'
import { isSubscribeFailure, subscribeStatusName } from '@gugu/core/cloud/deviceRpcProtocol'
import { subscribeAuthenticatedElectronRealtimeChannel, type ElectronManagedRealtimeChannel } from '../realtime-channel'
import { passwordUnavailable, type LivePasswordFact } from './password-facts'
import type { PasswordPermissionCaller } from './password-policy'
import type { ServicePermissionPolicyStore } from './policy-store'
import { observePermissionPolicyWrites } from './policy-write-lifetime'
import { parsePermissionPolicy, type PermissionPolicy } from './rules'

type SettingsChannel = ElectronManagedRealtimeChannel & {
  on(kind: 'broadcast', filter: { event: string }, callback: (event: unknown) => void): unknown
}
type RealtimeClient<T> = {
  realtime: { setAuth(): unknown | Promise<unknown> }
  getChannels(): readonly { topic: string }[]
  channel(topic: string, options: { config: { private: boolean } }): T
  removeChannel(channel: T): unknown
}
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/**
 * Account-policy facts only. Uses the existing private setting_changed bus and settings read/CAS.
 * Phase 1 does not promise zero delay from a cloud commit to a local native action. Missing or
 * unreliable subscription closes this source. No production vault/MCP constructor is registered.
 */
export async function createPasswordPolicySource<T>({ ownerId, store, supabase, lifetime }: {
  ownerId: string; store: ServicePermissionPolicyStore; supabase: RealtimeClient<T>; lifetime: AbortSignal
}) {
  if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(ownerId)
    || !(lifetime instanceof AbortSignal) || lifetime.aborted || typeof supabase.getChannels !== 'function') throw passwordUnavailable()
  const read = store.read.bind(store), channel = supabase.channel.bind(supabase)
  const removeChannel = supabase.removeChannel.bind(supabase), setAuth = supabase.realtime.setAuth.bind(supabase.realtime)
  const getChannels = supabase.getChannels.bind(supabase), topic = `gugu:user:${ownerId}:events`
  let joined = false, writing = false, disposed = false, unreliable = false
  let generation = randomUUID(), revision = new AbortController(), physical = 0
  let unsubscribe: (() => Promise<void>) | undefined
  let closing: Promise<void> | undefined
  const available = () => joined && !writing && !disposed && !unreliable && !lifetime.aborted
  const invalidate = () => {
    const previous = revision
    generation = randomUUID(); revision = new AbortController()
    previous.abort()
  }
  const offWrites = observePermissionPolicyWrites(ownerId, pending => { writing = pending; invalidate() })
  const dispose = (): Promise<void> => {
    if (closing) return closing
    closing = Promise.resolve().then(() => unsubscribe?.())
    disposed = true; joined = false; physical++; invalidate(); offWrites()
    lifetime.removeEventListener('abort', stop)
    return closing
  }
  const stop = () => { void dispose().catch(() => {}) }
  lifetime.addEventListener('abort', stop, { once: true })
  const createChannel = () => {
    joined = false; invalidate()
    // realtime-js reuses an existing same-topic object. Never attach to or retire another owner.
    // The native factory must provide an account-authenticated client with an unclaimed bus.
    const existing = getChannels()
    if (!Array.isArray(existing) || existing.some(value => !value || typeof value.topic !== 'string'
      || value.topic === topic || value.topic === `realtime:${topic}`)) throw passwordUnavailable()
    const attempt = ++physical
    const value = channel(topic, { config: { private: true } }) as T & SettingsChannel
    value.on('broadcast', { event: 'setting_changed' }, event => {
      if (disposed || attempt !== physical) return
      const payload = object(object(event)?.payload), setting = object(payload?.setting)
      if (!payload || typeof payload.op !== 'string' || !['insert', 'update', 'deleted'].includes(payload.op) || !setting
        || setting.user_id !== ownerId || typeof setting.scope !== 'string'
        || typeof setting.updated_at !== 'string' || !Number.isFinite(Date.parse(setting.updated_at))) {
        unreliable = true; joined = false; invalidate(); return
      }
      // Broadcast contents never grant access or replace a fresh settings read.
      if (setting.scope === 'user') invalidate()
    })
    return value
  }
  try {
    unsubscribe = await subscribeAuthenticatedElectronRealtimeChannel({ realtime: { setAuth },
      removeChannel: value => removeChannel(value as T) }, createChannel(), {
      label: `password-policy:${ownerId}`, createChannel,
      onUnavailable() { joined = false; invalidate() },
      onStatus(status, error) {
        if (disposed) return
        const name = subscribeStatusName(status)
        joined = !error && !unreliable && (name === 'SUBSCRIBED' || name.endsWith('.SUBSCRIBED'))
        invalidate()
      }, reconnectOnStatus: isSubscribeFailure,
    })
    if (disposed || lifetime.aborted) { await unsubscribe(); throw passwordUnavailable() }
  } catch { await dispose().catch(() => {}); throw passwordUnavailable() }

  return Object.freeze({
    async readPolicy(caller: PasswordPermissionCaller, signal: AbortSignal): Promise<LivePasswordFact<PermissionPolicy>> {
      if (caller?.ownerId !== ownerId || !available() || !(signal instanceof AbortSignal) || signal.aborted) throw passwordUnavailable()
      const captured = generation, revoked = anySignal([lifetime, revision.signal, signal])
      const assertCurrent = () => {
        if (!available() || generation !== captured || revoked.aborted) throw passwordUnavailable()
      }
      let abort!: () => void
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(passwordUnavailable())
        if (revoked.aborted) abort()
        else revoked.addEventListener('abort', abort, { once: true })
      })
      try {
        assertCurrent()
        const value = parsePermissionPolicy(await Promise.race([read(ownerId, revoked), cancelled]))
        assertCurrent()
        return Object.freeze({ value, generation: captured, signal: revoked, assertCurrent })
      } catch {
        if (!revoked.aborted && captured === generation) { unreliable = true; joined = false; invalidate() }
        throw passwordUnavailable()
      }
      finally { revoked.removeEventListener('abort', abort) }
    }, dispose,
  })
}
