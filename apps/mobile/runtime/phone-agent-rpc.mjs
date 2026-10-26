import { randomUUID } from 'node:crypto'
import { deviceScopeError } from '../../../packages/core/src/shared/deviceActions.ts'
import { createDeviceActionHost } from '../../../packages/core/src/cloud/deviceActionHost.ts'
import { createDeviceRpcRequester } from '../../../packages/core/src/cloud/deviceRpcRequester.ts'
import { openAttachedDeviceRpcPipe } from '../../../packages/core/src/cloud/deviceRpcAttach.ts'
import { createDeviceRpcReplyEnvelope, parseDeviceRpcRequest, deviceRpcChannelName, deviceRpcAskerChannelName, DEVICE_RPC_ASKER_ID, DEVICE_RPC_ATTACH, DEVICE_RPC_ALIVE, DEVICE_RPC_DETACHED } from '../../../packages/core/src/cloud/deviceRpcProtocol.ts'
import { MIN_CLIENT_PROTOCOL, REMOTE_PROTOCOL_VERSION } from '../../../packages/core/src/cloud/serverMachineHealth.ts'

/** A single private-channel endpoint handles both task-host and existing device actions. */
export async function startPhoneAgentRpc({ cloud, ownerId, deviceId, invoke, provider, onCommand, warn, onConnectivity }) {
  let alive = true
  const opened = new Set()
  const subscriptions = new Set()
  const peers = new Map()
  const availability = { shared: false, commands: false }
  let connected = null
  const setAvailability = (endpoint, available) => {
    availability[endpoint] = available
    const next = availability.shared && availability.commands
    if (!next && available) return // The other endpoint's initial subscription is still pending.
    if (next !== connected) { connected = next; onConnectivity?.(next) }
  }
  const reconcile = () => { void Promise.resolve().then(() => { if (alive) return onCommand() }).catch((error) => warn(error.message)) }
  const send = async (topic, payload) => {
    const result = await topic.send({ type: 'broadcast', event: 'broadcast', payload })
    if (result !== 'ok' && result !== undefined) throw new Error(`phone RPC send failed: ${result}`)
  }
  const join = (name, handlers, event = 'broadcast', { persistent = false, onAvailability } = {}) =>
    new Promise((resolve, reject) => {
      let subscribed = false
      let available = false
      let closed = false
      let channel = null
      let generation = 0
      let deadline = null
      let retry = null
      let retryDelay = 1_000
      let retiring = Promise.resolve()
      let closing = null
      const current = (epoch) => alive && !closed && generation === epoch
      const remove = (previous) => {
        if (!previous) return Promise.resolve()
        opened.delete(previous)
        return Promise.resolve().then(() => cloud.client.removeChannel(previous)).then((status) => {
          if (status && status !== 'ok') { previous.teardown?.(); warn(`phone RPC channel removal failed: ${name}: ${status}`) }
        }).catch((error) => { previous.teardown?.(); warn(error.message) })
      }
      const topic = {
        send: (message) => {
          if (!alive || closed || !available || !channel) return Promise.reject(new Error(`phone RPC channel is not connected: ${name}`))
          return channel.send(message)
        },
        close: () => {
          if (closing) return closing
          closed = true; generation++; available = false
          clearTimeout(deadline); clearTimeout(retry)
          const previous = channel; channel = null
          if (!subscribed) reject(new Error(`phone RPC subscription stopped: ${name}`))
          closing = Promise.allSettled([retiring, remove(previous)]).then(() => { subscriptions.delete(topic) })
          return closing
        },
      }
      const fail = (epoch, failure, terminal = false) => {
        if (!current(epoch)) return
        available = false; onAvailability?.(false)
        if (!subscribed) { reject(failure); void topic.close(); return }
        // SDK retries CHANNEL_ERROR/TIMED_OUT itself. A terminal CLOSED has left the SDK's
        // channel registry; only these two persistent endpoints own a replacement loop.
        if (!persistent) { handlers.onClosed?.(failure); void topic.close(); return }
        if (!terminal) { handlers.onClosed?.(failure); return }
        clearTimeout(deadline)
        const previous = channel; channel = null
        const retiredEpoch = ++generation
        handlers.onClosed?.(failure)
        retiring = remove(previous)
        void retiring.then(() => {
          if (!current(retiredEpoch)) return
          const delay = retryDelay
          retryDelay = Math.min(30_000, retryDelay * 2)
          retry = setTimeout(() => { retry = null; void subscribe() }, delay)
        })
      }
      const subscribe = async () => {
        const epoch = ++generation
        deadline = setTimeout(() => fail(epoch, new Error(`phone RPC subscription timed out: ${name}`), true), 15_000)
        try {
          await cloud.token()
          if (!current(epoch)) return
          const next = cloud.client.channel(name, { config: { private: true, broadcast: { self: false, ack: true } } })
          channel = next; opened.add(next)
          next.on('broadcast', { event }, (payload) => { if (current(epoch) && available && channel === next) handlers.onMessage(payload) })
          next.subscribe((status, error) => {
            if (!current(epoch) || channel !== next) return
            if (status === 'SUBSCRIBED') {
              if (available) return
              const rejoined = subscribed
              subscribed = true; available = true; retryDelay = 1_000; clearTimeout(deadline)
              onAvailability?.(true)
              if (rejoined) handlers.onRejoined?.()
              else resolve(topic)
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
              fail(epoch, error ?? new Error(`phone channel ${name}: ${status}`), status === 'CLOSED')
            }
          })
        } catch (error) { fail(epoch, error, true) }
      }
      subscriptions.add(topic)
      void subscribe()
    })
  const requester = createDeviceRpcRequester({
    userId: async () => ownerId,
    openPipe: (target, handlers) => openAttachedDeviceRpcPipe({ deviceId: target, asker: randomUUID().replaceAll('-', ''), userId: async () => ownerId, join, watchdog: {}, ...handlers }),
  })
  const closePeer = async (id) => {
    const peer = peers.get(id)
    if (!peer) return
    peers.delete(id); peer.actions.dispose()
    const topic = await peer.topic.catch(() => null)
    if (topic) { await send(topic, { type: DEVICE_RPC_DETACHED }).catch(() => undefined); await topic.close() }
  }
  const makePeer = (id) => {
    const peer = { topic: null, actions: null, lastAsked: Date.now(), requests: new Map() }
    peer.actions = createDeviceActionHost({ provider, publishEvent: async (payload) => send(await peer.topic, payload), log: { info: () => undefined, warn: (_fields, message) => warn(message) } })
    peer.topic = join(deviceRpcAskerChannelName(deviceId, id), {
      onMessage: (raw) => {
        const request = parseDeviceRpcRequest(raw)
        if (!alive || !request || request.user_id !== ownerId || request.type.endsWith(':reply')) return
        peer.lastAsked = Date.now()
        if (request.type === 'device.action' || request.type === 'device.action.result_ack') {
          void sendPeerReply(peer, request, { error: deviceScopeError(deviceId) }).catch((error) => warn(error.message))
          return
        }
        let result = peer.requests.get(request.request_id)
        if (!result) {
          result = (async () => {
            if(request.type==='assistantWork.deliver') {
              try { return {result:await invoke('assistantWork.deliver',[request.payload],request.request_id)} }
              catch(error) {return {error:{code:error.code ?? 'work_delivery_failed',message:error.message}}}
            }
            if (request.type === 'taskhost.call') {
              const body = request.payload
              if (!body || typeof body.channel !== 'string' || !Array.isArray(body.args)) return { error: { code: 'invalid_payload', message: 'channel 和 args 是必填的' } }
              try { return { result: { value: await invoke(body.channel, body.args, request.request_id) } } } catch (error) { return { error: { code: error.code ?? 'session_action_failed', message: error.message } } }
            }
            return { error: { code: 'unknown_method', message: `手机宿主尚不支持 ${request.type}` } }
          })()
          peer.requests.set(request.request_id, result)
          // Durability for creating sessions and admitting messages is owned by invoke's journal.
          // Other read requests need only this bounded connection-local response cache.
          if (peer.requests.size > 256) peer.requests.delete(peer.requests.keys().next().value)
        }
        void result.then((reply) => sendPeerReply(peer, request, reply)).catch((error) => warn(error.message))
      },
      onRejoined: () => undefined,
      onClosed: (error) => { warn(error.message); void closePeer(id) },
    }).catch((error) => {
      if (peers.get(id) === peer) peers.delete(id)
      peer.actions.dispose()
      throw error
    })
    peers.set(id, peer)
    return peer
  }
  const sendPeerReply = async (peer, request, reply) => {
    if (alive && peers.get([...peers].find(([, value]) => value === peer)?.[0]) === peer) await send(await peer.topic, createDeviceRpcReplyEnvelope(request.type, request.request_id, reply))
  }
  let shared
  let timer = null
  let closingHost = null
  const close = () => {
    if (closingHost) return closingHost
    alive = false; clearInterval(timer); requester.closeAll(new Error('phone host stopped'))
    closingHost = (async () => {
      await Promise.all([...peers.keys()].map(closePeer))
      await Promise.all([...subscriptions].map((topic) => topic.close()))
      await Promise.all([...opened].map((channel) => cloud.client.removeChannel(channel)))
    })()
    return closingHost
  }
  try {
    shared = await join(deviceRpcChannelName(deviceId), {
      onMessage: (raw) => {
        const request = parseDeviceRpcRequest(raw)
        if (!alive || !request || request.user_id !== ownerId || request.type.endsWith(':reply')) return
        if (request.type !== DEVICE_RPC_ATTACH) {
          void send(shared, createDeviceRpcReplyEnvelope(request.type, request.request_id, { error: { code: 'client_outdated', message: '请更新发起调用的那台电脑上的咕咕' } })).catch((error) => warn(error.message))
          return
        }
        const body = request.payload
        if (!body || !DEVICE_RPC_ASKER_ID.test(body.asker ?? '') || typeof body.protocol !== 'number' || body.protocol < MIN_CLIENT_PROTOCOL) {
          void send(shared, createDeviceRpcReplyEnvelope(request.type, request.request_id, { error: { code: 'client_outdated', message: '发起调用的一端版本太旧或连接信息无效' } })).catch((error) => warn(error.message))
          return
        }
        const peer = peers.get(body.asker) ?? makePeer(body.asker)
        peer.lastAsked = Date.now()
        void peer.topic.then((topic) => send(topic, createDeviceRpcReplyEnvelope(request.type, request.request_id, { result: { attached: true, protocol: REMOTE_PROTOCOL_VERSION } }))).catch((error) => warn(error.message))
      },
      onRejoined: () => { reconcile(); void send(shared, { type: 'taskhost.ready' }).catch((error) => warn(error.message)) },
      onClosed: (error) => warn(error.message),
    }, 'broadcast', { persistent: true, onAvailability: (available) => setAvailability('shared', available) })
    await send(shared, { type: 'taskhost.ready' })
    await join(`gugu:${deviceId}:commands`, {
      onMessage: reconcile,
      onRejoined: reconcile,
      onClosed: (error) => warn(error.message),
    }, 'command_created', { persistent: true, onAvailability: (available) => setAvailability('commands', available) })
    timer = setInterval(() => {
      void send(shared, { type: DEVICE_RPC_ALIVE }).catch((error) => warn(error.message))
      for (const [id, peer] of peers) {
        if (Date.now() - peer.lastAsked > 5 * 60_000) { void closePeer(id); continue }
        void peer.topic.then((topic) => send(topic, { type: DEVICE_RPC_ALIVE })).catch((error) => warn(error.message))
      }
    }, 60_000)
    return { requester, close }
  } catch (error) { await close(); throw error }
}
