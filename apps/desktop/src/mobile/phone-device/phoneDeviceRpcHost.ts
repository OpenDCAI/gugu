import { createDeviceActionHost, type DeviceActionProvider } from '@gugu/core/cloud/deviceActionHost'
import type { JoinDeviceTopic, DeviceTopic } from '@gugu/core/cloud/deviceRpcAttach'
import { createDeviceRpcReplyEnvelope, deviceRpcAskerChannelName, parseDeviceRpcRequest, DEVICE_RPC_ATTACH, DEVICE_RPC_ASKER_ID, DEVICE_RPC_ALIVE, DEVICE_RPC_DETACHED } from '@gugu/core/cloud/deviceRpcProtocol'
import { MIN_CLIENT_PROTOCOL, REMOTE_PROTOCOL_VERSION } from '@gugu/core/cloud/serverMachineHealth'
import { deviceScopeError } from '@gugu/core/shared/deviceActions'

/** Phones use the same protocol-9 attach handshake as computers. A result only goes to its asking endpoint. */
export function createPhoneDeviceRpcHost(input: {
  userId: string
  deviceId: string
  provider: DeviceActionProvider
  join: JoinDeviceTopic
  replyShared(payload: unknown): Promise<unknown>
  warn(message: string): void
}) {
  type Peer = { host: ReturnType<typeof createDeviceActionHost>; topic: Promise<DeviceTopic>; lastAsked: number }
  const peers = new Map<string, Peer>()
  const leaving = new Map<string, Promise<void>>()
  let alive = true
  const send = (topic: DeviceTopic, payload: unknown) => topic.send({ type: 'broadcast', event: 'broadcast', payload })
  const close = (id: string) => {
    const peer = peers.get(id)
    if (!peer) return
    peers.delete(id)
    peer.host.dispose()
    const done = peer.topic.then(async (t) => {
      try { await send(t, { type: DEVICE_RPC_DETACHED }) } finally { await t.close() }
    }, () => undefined).catch((error: unknown) => input.warn(String(error))).then(() => { if (leaving.get(id) === done) leaving.delete(id) })
    leaving.set(id, done)
  }
  const refuse = (request: NonNullable<ReturnType<typeof parseDeviceRpcRequest>>, code: string, message: string) =>
    input.replyShared(createDeviceRpcReplyEnvelope(request.type, request.request_id, { error: { code, message } }))

  return {
    async onShared(payload: unknown): Promise<void> {
      const request = parseDeviceRpcRequest(payload)
      if (!alive || !request || request.type.endsWith(':reply') || request.user_id !== input.userId) return
      if (request.type !== DEVICE_RPC_ATTACH) {
        await refuse(request, 'client_outdated', '请更新发起调用的那台电脑上的咕咕')
        return
      }
      const args = request.payload as { asker?: unknown; protocol?: unknown } | null
      if (!args || typeof args.asker !== 'string' || !DEVICE_RPC_ASKER_ID.test(args.asker) || typeof args.protocol !== 'number' || args.protocol < MIN_CLIENT_PROTOCOL) {
        await refuse(request, 'client_outdated', '发起调用的一端版本太旧或连接信息无效,请更新那台电脑上的咕咕')
        return
      }
      const id = args.asker
      let peer = peers.get(id)
      if (!peer) {
        const host = createDeviceActionHost({ provider: input.provider, publishEvent: async (event) => {
          const current = peers.get(id)
          if (!alive || !current || current.host !== host) throw new Error('手机设备频道已关闭')
          current.lastAsked = Date.now()
          await send(await current.topic, event)
        } })
        const topic = Promise.resolve(leaving.get(id)).then(() => input.join(deviceRpcAskerChannelName(input.deviceId, id), {
          onMessage: (message) => {
            const current = peers.get(id)
            const call = parseDeviceRpcRequest(message)
            if (!alive || !current || current.host !== host || !call || call.user_id !== input.userId || call.type.endsWith(':reply')) return
            current.lastAsked = Date.now()
            const result = Promise.resolve({ error: call.type === 'device.action' || call.type === 'device.action.result_ack'
              ? deviceScopeError(input.deviceId)
              : { code: 'unknown_method', message: '手机只执行已登记的设备动作' } })
            void result.then(async (reply) => {
              if (alive && peers.get(id) === current) await send(await current.topic, createDeviceRpcReplyEnvelope(call.type, call.request_id, reply))
            }).catch((error: unknown) => input.warn(String(error)))
          },
          onRejoined: () => undefined,
          onClosed: () => { if (peers.get(id)?.host === host) close(id) },
        }))
        peer = { host, topic, lastAsked: Date.now() }
        peers.set(id, peer)
      }
      try {
        const topic = await peer.topic
        if (alive && peers.get(id) === peer) await send(topic, createDeviceRpcReplyEnvelope(request.type, request.request_id, { result: { attached: true, protocol: REMOTE_PROTOCOL_VERSION } }))
      } catch (error) {
        if (peers.get(id) === peer) close(id)
        input.warn(String(error))
      }
    },
    beat(): void {
      for (const [id, peer] of peers) {
        if (Date.now() - peer.lastAsked > 5 * 60_000) { close(id); continue }
        void peer.topic.then((topic) => send(topic, { type: DEVICE_RPC_ALIVE })).catch((error: unknown) => input.warn(String(error)))
      }
      void input.replyShared({ type: DEVICE_RPC_ALIVE }).catch((error: unknown) => input.warn(String(error)))
    },
    dispose(): void { alive = false; for (const id of peers.keys()) close(id) },
  }
}
