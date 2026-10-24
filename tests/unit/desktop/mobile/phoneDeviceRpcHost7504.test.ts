import { describe, expect, it, vi } from 'vitest'
import { openAttachedDeviceRpcPipe, type JoinDeviceTopic, type DeviceTopicHandlers } from '@gugu/core/cloud/deviceRpcAttach'
import { createDeviceRpcRequester } from '@gugu/core/cloud/deviceRpcRequester'
import { createDeviceActionCaller } from '@gugu/core/cloud/deviceActionCaller'
import { REMOTE_PROTOCOL_VERSION } from '@gugu/core/cloud/serverMachineHealth'
import { createPhoneDeviceRpcHost } from '../../../../apps/desktop/src/mobile/phone-device/phoneDeviceRpcHost'

describe('current desktop RPC reaches the phone through an attached private topic', () => {
  it('refuses a remote action at caller and receiver without touching the provider', async () => {
    const subscribers = new Map<string, Set<DeviceTopicHandlers>>()
    const frames: Array<{ topic: string; message: unknown }> = []
    const join: JoinDeviceTopic = async (name, handlers) => {
      const listeners = subscribers.get(name) ?? new Set(); subscribers.set(name, listeners); listeners.add(handlers)
      return {
        send: async (message) => { frames.push({ topic: name, message }); for (const other of listeners) if (other !== handlers) queueMicrotask(() => other.onMessage(message)) },
        close: () => { listeners.delete(handlers) },
      }
    }
    const shared = 'gugu:phone-test:rpc'
    const provider = { manifest: () => [], permit: () => ({ ok: true as const }), run: vi.fn(async () => ({ ok: true as const, data: { body: 'sms from the real phone provider' } })) }
    const host = createPhoneDeviceRpcHost({ userId: 'owner', deviceId: 'phone-test', provider, join, replyShared: async (payload) => {
      for (const handler of subscribers.get(shared) ?? []) queueMicrotask(() => handler.onMessage({ payload }))
    }, warn: vi.fn() })
    const sharedSubscription = await join(shared, { onMessage: (payload) => { void host.onShared(payload) }, onClosed: vi.fn(), onRejoined: vi.fn() })
    const bystander = vi.fn()
    const other = await join(shared + ':otherAsk123', { onMessage: bystander, onClosed: vi.fn(), onRejoined: vi.fn() })
    const requester = createDeviceRpcRequester({ userId: async () => 'owner',
      openPipe: async (deviceId, handlers) => openAttachedDeviceRpcPipe({ ...handlers, deviceId, asker: 'desktopAsk123', userId: async () => 'owner', join }),
      onEvent: (deviceId, payload) => { caller.onEvent(deviceId, payload) },
    })
    const caller = createDeviceActionCaller({ listDevices: async () => [{ device_id: 'phone-test', label: 'phone', online: true, last_seen_at: new Date().toISOString(), actions: { v: 1, actions: [{ name: 'sms.get', group: 'sms', title: 'SMS', description: 'read SMS', risk: 'low', confirm: 'never', input_schema: { type: 'object' }, available: true }] } }], rpc: (id, type, payload, options) => requester.call(id, type, payload, options) })
    try {
      expect(await caller.call({ deviceId: 'phone-test', action: 'sms.get', args: { id: '1' } })).toMatchObject({ ok: false, code: 'device_scope_mismatch' })
      // Bypass the new caller (as an older client can): the phone still refuses.
      for (const type of ['device.action', 'device.action.result_ack']) {
        expect(await requester.call('phone-test', type, { v: 1, call_id: 'forged-local', action: 'sms.get', caller: { deviceId: 'phone-test' } }, { timeoutMs: 1000 }))
          .toMatchObject({ error: { code: 'device_scope_mismatch', message: expect.stringContaining('device:phone-test') } })
      }
      expect(provider.run).not.toHaveBeenCalled()
      expect(bystander).not.toHaveBeenCalled()
      expect(frames.some(f => JSON.stringify(f.message).includes('sms from the real phone provider'))).toBe(false)
    } finally { requester.closeAll(); host.dispose(); await sharedSubscription.close(); await other.close() }
  })
  it('ignores another account before creating an asker topic', async () => {
    const join = vi.fn()
    const host = createPhoneDeviceRpcHost({ userId: 'owner', deviceId: 'phone', join, provider: { manifest: () => [], permit: () => ({ ok: true }), run: vi.fn() }, replyShared: vi.fn(async () => undefined), warn: vi.fn() })
    await host.onShared({ type: 'taskhost.attach', request_id: 'r', user_id: 'someone-else', payload: { asker: 'foreign123', protocol: 9 } })
    expect(join).not.toHaveBeenCalled()
    host.dispose()
  })
  it('lets the same asker reattach while its previous subscription is still leaving', async () => {
    let finishClosing!: () => void
    const closing = new Promise<void>((resolve) => { finishClosing = resolve })
    const sent: unknown[][] = []
    const join: JoinDeviceTopic = vi.fn(async (_name, handlers) => {
      const messages: unknown[] = []; sent.push(messages)
      return { send: async (message: unknown) => { messages.push(message) }, close: async () => { await closing; handlers.onClosed() } }
    })
    const host = createPhoneDeviceRpcHost({ userId: 'owner', deviceId: 'phone', join, provider: { manifest: () => [], permit: () => ({ ok: true }), run: vi.fn() }, replyShared: vi.fn(async () => undefined), warn: vi.fn() })
    const request = { type: 'taskhost.attach', request_id: 'r', user_id: 'owner', payload: { asker: 'desktopAsk123', protocol: 9 } }
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now')
    try {
      await host.onShared(request)
      clock.mockReturnValue(now + 301_000)
      host.beat()
      const again = host.onShared({ ...request, request_id: 'again' })
      finishClosing()
      await again
      expect(join).toHaveBeenCalledTimes(2)
      expect(sent[1]).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ result: { attached: true, protocol: REMOTE_PROTOCOL_VERSION } }) }))
    } finally { finishClosing(); clock.mockRestore(); host.dispose() }
  })
})
