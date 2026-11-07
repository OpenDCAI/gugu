import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { SubscribeElectronRealtimeChannelOptions } from '../../../../apps/desktop/electron/realtime-channel'
import { createPasswordPolicySource } from '../../../../apps/desktop/electron/permissions/password-policy-source'
import { beginPermissionPolicyWrite } from '../../../../apps/desktop/electron/permissions/policy-write-lifetime'
import type { ServicePermissionPolicyStore } from '../../../../apps/desktop/electron/permissions/policy-store'
import { defaultPermissionPolicy } from '../../../../apps/desktop/electron/permissions/rules'

const transport = vi.hoisted(() => ({ subscribe: vi.fn() }))
vi.mock('../../../../apps/desktop/electron/realtime-channel', () => ({ subscribeAuthenticatedElectronRealtimeChannel: transport.subscribe }))
const sources: Array<{ dispose(): Promise<void> }> = []
afterEach(async () => { for (const source of sources.splice(0)) await source.dispose(); vi.restoreAllMocks() })

async function fixture(ownerId = randomUUID()) {
  const lifetime = new AbortController(), read = vi.fn(async () => defaultPermissionPolicy()), off = vi.fn(async () => {})
  let options!: SubscribeElectronRealtimeChannelOptions
  const channels: Array<{ topic: string; emit(event: unknown): void }> = []
  transport.subscribe.mockImplementation(async (_client: unknown, _channel: unknown, value: SubscribeElectronRealtimeChannelOptions) => { options = value; return off })
  const channel = vi.fn((_topic: string, _config: unknown) => {
    let receive: (event: unknown) => void = () => {}
    const value = { topic: `realtime:${_topic}`, on: (_kind: string, _filter: unknown, callback: (event: unknown) => void) => { receive = callback },
      subscribe: vi.fn(), emit: (event: unknown) => receive(event) }
    channels.push(value); return value
  })
  const store = { read }, source = await createPasswordPolicySource({ ownerId, store: store as unknown as ServicePermissionPolicyStore,
    supabase: { channel, getChannels: () => channels, removeChannel: vi.fn(), realtime: { setAuth: vi.fn() } }, lifetime: lifetime.signal })
  sources.push(source)
  const caller = { ownerId, subjectId: 'agent', sessionId: 'session', installationId: 'install', deviceId: 'device', toolScope: 'gugu' }
  const status = (value: string) => options.onStatus!(value)
  const event = (scope = 'user') => ({ payload: { op: 'update', setting: { user_id: ownerId, scope,
    updated_at: '2026-11-07T05:21:00.000Z', config: { service_permissions: { malicious: 'never consumed' } } } } })
  const current = () => source.readPolicy(caller, new AbortController().signal)
  return { source, ownerId, caller, store, read, off, channel, channels, options, status, event, current, lifetime }
}

describe('live policy from the existing private settings bus', () => {
  it('refuses an already owned account bus before attaching, subscribing or removing it', async () => {
    const ownerId = randomUUID(), channel = vi.fn(), removeChannel = vi.fn(), before = transport.subscribe.mock.calls.length
    await expect(createPasswordPolicySource({ ownerId, store: { read: vi.fn() } as unknown as ServicePermissionPolicyStore,
      supabase: { channel, getChannels: () => [{ topic: `realtime:gugu:user:${ownerId}:events` }], removeChannel, realtime: { setAuth: vi.fn() } },
      lifetime: new AbortController().signal })).rejects.toThrow('password_permission_unavailable')
    expect(channel).not.toHaveBeenCalled(); expect(removeChannel).not.toHaveBeenCalled()
    expect(transport.subscribe.mock.calls.length).toBe(before)
  })
  it('requires a joined channel and fresh-reads for every phase rather than using broadcast values', async () => {
    const f = await fixture()
    await expect(f.current()).rejects.toThrow('password_permission_unavailable'); expect(f.read).not.toHaveBeenCalled()
    f.status('SUBSCRIBED'); const first = await f.current()
    f.channels[0]!.emit(f.event()); expect(first.signal.aborted).toBe(true); expect(() => first.assertCurrent()).toThrow()
    const second = await f.current(); expect(second.value).toEqual(defaultPermissionPolicy()); expect(f.read).toHaveBeenCalledTimes(2)
    expect(f.channel).toHaveBeenCalledWith(`gugu:user:${f.ownerId}:events`, { config: { private: true } })
  })
  it('cancels an in-flight old read on a valid remote change and never revives it on late completion', async () => {
    const f = await fixture(); f.status('SUBSCRIBED')
    let resolve!: (value: ReturnType<typeof defaultPermissionPolicy>) => void
    f.read.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const pending = f.current(); f.channels[0]!.emit(f.event())
    await expect(pending).rejects.toThrow('password_permission_unavailable')
    resolve(defaultPermissionPolicy()); await Promise.resolve()
    const fresh = await f.current(); expect(() => fresh.assertCurrent()).not.toThrow()
  })
  it('invalidates synchronously before a local write and refuses fresh reads until every write settles', async () => {
    const f = await fixture(); f.status('SUBSCRIBED'); const fact = await f.current()
    const finish = beginPermissionPolicyWrite(f.ownerId), finishOther = beginPermissionPolicyWrite(f.ownerId)
    expect(fact.signal.aborted).toBe(true); await expect(f.current()).rejects.toThrow()
    finish(); finish(); await expect(f.current()).rejects.toThrow()
    finishOther(); const fresh = await f.current(); expect(() => fresh.assertCurrent()).not.toThrow()
    expect(() => fact.assertCurrent()).toThrow()
  })
  it('also blocks a source first constructed while a local settings write is pending', async () => {
    const ownerId = randomUUID(), finish = beginPermissionPolicyWrite(ownerId)
    try { const f = await fixture(ownerId); f.status('SUBSCRIBED'); await expect(f.current()).rejects.toThrow(); finish(); await expect(f.current()).resolves.toBeDefined() }
    finally { finish() }
  })
  it.each(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED', 'UNSUBSCRIBED'])('fails closed on %s and reconciles only through a new fresh read', async status => {
    const f = await fixture(); f.status('SUBSCRIBED'); const old = await f.current()
    f.status(status); expect(old.signal.aborted).toBe(true); await expect(f.current()).rejects.toThrow()
    f.status('SUBSCRIBED'); await expect(f.current()).resolves.toBeDefined(); expect(() => old.assertCurrent()).toThrow()
  })
  it('withdraws old and pending facts as soon as the real manager starts losing continuity', async () => {
    const f = await fixture(); f.status('SUBSCRIBED'); const old = await f.current()
    f.options.onUnavailable!(); expect(old.signal.aborted).toBe(true)
    await expect(f.current()).rejects.toThrow()
    f.status('SUBSCRIBED'); await expect(f.current()).resolves.toBeDefined(); expect(() => old.assertCurrent()).toThrow()
  })
  it.each(['shape', 'owner', 'time'])('closes on an unreliable %s event instead of granting from it', async kind => {
    const f = await fixture(); f.status('SUBSCRIBED'); const old = await f.current(), event = f.event()
    if (kind === 'owner') event.payload.setting.user_id = randomUUID()
    if (kind === 'time') event.payload.setting.updated_at = 'bad-time'
    f.channels[0]!.emit(kind === 'shape' ? {} : event)
    expect(old.signal.aborted).toBe(true); f.status('SUBSCRIBED'); await expect(f.current()).rejects.toThrow()
  })
  it('does not revoke user policy for a valid different settings scope', async () => {
    const f = await fixture(); f.status('SUBSCRIBED'); const fact = await f.current()
    f.channels[0]!.emit(f.event('device:test')); expect(fact.signal.aborted).toBe(false); expect(() => fact.assertCurrent()).not.toThrow()
  })
  it('rejects late callbacks from a replaced physical channel', async () => {
    const f = await fixture(); f.status('SUBSCRIBED'); const old = await f.current()
    const retired = f.channels.shift()! // Managed reconnect removes the old physical channel first.
    f.options.createChannel!(); expect(old.signal.aborted).toBe(true); await expect(f.current()).rejects.toThrow()
    f.status('SUBSCRIBED'); const fresh = await f.current(); retired.emit({})
    expect(() => fresh.assertCurrent()).not.toThrow()
  })
  it('captures its actual store method, and closes outstanding facts when a later query fails', async () => {
    const f = await fixture(); f.status('SUBSCRIBED'); const old = await f.current()
    f.store.read = vi.fn(async () => ({ ...defaultPermissionPolicy(), revision: 999 }))
    expect((await f.current()).value.revision).toBe(0)
    f.read.mockRejectedValueOnce(new Error('private database diagnostic'))
    await expect(f.current()).rejects.toThrow('password_permission_unavailable'); expect(old.signal.aborted).toBe(true)
    await expect(f.current()).rejects.toThrow('password_permission_unavailable')
  })
  it('binds the owner/lifetime, cancels old facts and returns the same disposal completion', async () => {
    const f = await fixture(); f.status('SUBSCRIBED'); const fact = await f.current()
    await expect(f.source.readPolicy({ ...f.caller, ownerId: randomUUID() }, new AbortController().signal)).rejects.toThrow()
    f.lifetime.abort(); expect(fact.signal.aborted).toBe(true)
    const first = f.source.dispose(); expect(f.source.dispose()).toBe(first); await first
    expect(f.off).toHaveBeenCalledOnce(); await expect(f.current()).rejects.toThrow()
  })
})
