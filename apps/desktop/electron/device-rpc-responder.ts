import type { SubscribeDeviceRpc } from '@gugu/core'
import {
  createDeviceRpcReplyEnvelope,
  DEVICE_RPC_ALIVE,
  DEVICE_RPC_ALIVE_MS,
  DEVICE_RPC_ATTACH,
  deviceRpcChannelName,
  isSubscribeFailure,
  parseDeviceRpcRequest,
  subscribeStatusName,
} from '@gugu/core/cloud/deviceRpcProtocol'
import {
  createDeviceRpcRequestHandler,
  type DeviceRpcHandlers,
  type PublishDeviceRpcEvent,
  type PublishDeviceRpcReply,
} from '@gugu/core/cloud/deviceRpcResponder'
import { MIN_CLIENT_PROTOCOL } from '@gugu/core/cloud/serverMachineHealth'
import { SESSION_HOST_READY_EVENT } from '@shared/lib/ipc/session-host-device-frames'
import { createDeviceRpcAskers, type DeviceRpcAskerLimits } from './device-rpc-askers'
import type { ElectronManagedRealtimeChannel } from './realtime-channel'
import { sendBroadcast, subscribeAuthenticatedElectronRealtimeChannel } from './realtime-channel'

/**
 * 共用 topic 上照旧直接收的请求:咕咕云库里中转来的 MessagePreview(#6357,`chat.message_preview_relay` 用 realtime.send
 * 发到共用 topic,它不报到 —— 也没人等它的应答)。别的请求一律要先报到(协议 9,#7233)。
 */
const SHARED_TOPIC_REQUESTS = /^taskpage\.preview\./

type RpcChannel = {
  on: (
    kind: 'broadcast',
    filter: { event: string },
    callback: (payload: unknown) => void
  ) => RpcChannel
  subscribe: (callback: (status: string, err?: Error) => void) => RpcChannel
  send: (message: { type: 'broadcast'; event: string; payload: unknown }) => Promise<unknown>
}

type RpcSupabaseClient<TChannel> = {
  realtime: {
    setAuth: () => unknown | Promise<unknown>
  }
  channel: (
    topic: string,
    options: { config: { private: boolean; broadcast: { self: boolean; ack: boolean } } }
  ) => TChannel
  removeChannel: (channel: TChannel) => unknown
}

export function createDesktopDeviceRpcSubscription<TChannel>({
  supabase,
  warn = console.warn,
  createHandlers,
  askerLimits,
  broadcastEvents,
  onSubscribed,
}: {
  supabase: RpcSupabaseClient<TChannel>
  warn?: (message: string) => void
  /** 每个发问端一条线的上限(deviceRpcAskerLimitsFromEnv;默认 DEVICE_RPC_ASKER_LIMITS)。 */
  askerLimits?: DeviceRpcAskerLimits
  /** Control hints share the existing device channel; file bytes must never use these callbacks. */
  broadcastEvents?: Record<string, (deviceId: string, payload: unknown) => void>
  onSubscribed?: (deviceId: string) => void
  /**
   * 每条频道一份宿主处理器。**按频道建、按频道拆**：处理器可能握着会话页窗口（taskhost.open），
   * 而订阅只在这条频道活着的时候有意义 —— 频道断了还留着，就是「以为还有人在看」的泄漏。
   * `io.openTopicPublisher`:用同一令牌往别的 topic 推(MessagePreview,#6357)。
   */
  createHandlers?: (io: { openTopicPublisher: OpenTopicPublisher }) => {
    handlers: DeviceRpcHandlers
    dispose: () => void
  }
}): SubscribeDeviceRpc {
  return async ({ deviceId }) => {
    let active = true
    let rpcSubscribed = false
    let liveChannel: RpcChannel | null = null
    const realtimeClient = {
      realtime: supabase.realtime,
      removeChannel: (channel: ElectronManagedRealtimeChannel) => {
        return supabase.removeChannel(channel as TChannel)
      }
    }
    const openTopicPublisher: OpenTopicPublisher = (topic, event) =>
      createTopicPublisher({ supabase, realtimeClient, topic, event, warn })
    const hostHandlers = createHandlers?.({ openTopicPublisher })
    const handleRequest = createDeviceRpcRequestHandler({ warn, handlers: hostHandlers?.handlers })
    const publishReply: PublishDeviceRpcReply = (payload) => {
      if (!liveChannel) return
      return sendBroadcast(liveChannel, 'broadcast', payload)
    }
    const publishEvent: PublishDeviceRpcEvent = (payload) => {
      if (!active || !liveChannel) return
      return sendBroadcast(liveChannel, 'broadcast', payload)
    }
    // #7233 每个报到过的发问端一条线:它的请求、回包、窗口回帧都走那条(device-rpc-askers.ts)。
    const askers = createDeviceRpcAskers({
      supabase,
      deviceId,
      handle: handleRequest,
      replyShared: publishReply,
      limits: askerLimits,
      warn,
    })
    const createRpcChannel = () => {
      rpcSubscribed = false
      const channel = supabase.channel(deviceRpcChannelName(deviceId), {
        config: {
          private: true,
          broadcast: { self: false, ack: true }
        }
      })
      const rpcChannel = channel as TChannel & RpcChannel & ElectronManagedRealtimeChannel
      liveChannel = rpcChannel
      for (const [event, receive] of Object.entries(broadcastEvents ?? {})) {
        rpcChannel.on('broadcast', { event }, payload => { if (active) receive(deviceId, payload) })
      }
      rpcChannel.on('broadcast', { event: 'broadcast' }, (payload) => {
        if (!active || liveChannel !== rpcChannel) return
        const request = parseDeviceRpcRequest(payload)
        if (!request || request.type.endsWith(':reply')) return
        if (request.type === DEVICE_RPC_ATTACH) return askers.attach(request)
        if (SHARED_TOPIC_REQUESTS.test(request.type)) return void handleRequest(payload, publishReply, publishEvent)
        // 不报到、直接在共用 topic 上问的,是协议 9 之前的咕咕:当场说清,让那一端说「请更新」(❌ 让它干等到超时)。
        void Promise.resolve(publishReply(createDeviceRpcReplyEnvelope(request.type, request.request_id, {
          error: {
            code: 'client_outdated',
            message: `Gugu on the device asking is too old (this machine needs protocol ${MIN_CLIENT_PROTOCOL}): update Gugu there`
          }
        }))).catch(() => undefined)
      })
      return rpcChannel
    }
    // 活着的那一声:共用 topic 与每条在的发问端线上各一条,订阅方的看门狗靠它(#840)。空闲的发问端线顺手离开。
    const aliveTimer = setInterval(() => {
      if (!active || !rpcSubscribed) return
      void Promise.resolve(publishEvent({ type: DEVICE_RPC_ALIVE })).catch(() => undefined)
      askers.alive()
    }, DEVICE_RPC_ALIVE_MS)
    const sweepTimer = setInterval(() => {
      if (active) askers.sweep()
    }, 30_000)
    aliveTimer.unref?.()
    sweepTimer.unref?.()
    const rpcChannel = createRpcChannel()
    // 这一份宿主处理器头一回订上频道时说一声「宿主起来了」:订着这条频道的别的桌面 / 手机据此作废对着没起来的这台发出去的开线、
    // 立刻重开。只说一次 —— 频道断了又订上时窗口还在(处理器没换),再说就会让别人白白拆掉好好的窗口。
    let announced = false
    const unsubscribe = await subscribeAuthenticatedElectronRealtimeChannel(realtimeClient, rpcChannel, {
      label: `device-rpc:${deviceId}`,
      createChannel: createRpcChannel,
      onStatus: (status, err) => {
        const name = subscribeStatusName(status)
        if (name === 'SUBSCRIBED' || name.endsWith('.SUBSCRIBED')) {
          rpcSubscribed = active
          if (active) onSubscribed?.(deviceId)
          if (hostHandlers && !announced) {
            announced = true
            void Promise.resolve(publishEvent({ type: SESSION_HOST_READY_EVENT })).catch((error: unknown) => {
              warn(`[device-rpc] host ready announce failed: ${(error as Error)?.message ?? String(error)}`)
            })
          }
          return
        }
        if (!isSubscribeFailure(status) || !active) return
        rpcSubscribed = false
        warn(`[device-rpc] subscribe failed: ${name}${err ? ` ${(err as Error).message}` : ''}`)
      },
      reconnectOnStatus: (status) => isSubscribeFailure(status)
    })

    return () => {
      active = false
      rpcSubscribed = false
      clearInterval(aliveTimer)
      clearInterval(sweepTimer)
      askers.dispose()
      liveChannel = null
      hostHandlers?.dispose()
      unsubscribe()
    }
  }
}

export type TopicPublisher = { send: (payload: unknown) => unknown; close: () => void }
export type OpenTopicPublisher = (topic: string, event: string) => TopicPublisher

/** 只往外推的私有频道:加入前只压最新一份(整份状态),加入/重连后补发。 */
function createTopicPublisher<TChannel>({
  supabase,
  realtimeClient,
  topic,
  event,
  warn
}: {
  supabase: RpcSupabaseClient<TChannel>
  realtimeClient: { realtime: RpcSupabaseClient<TChannel>['realtime']; removeChannel: (channel: ElectronManagedRealtimeChannel) => unknown }
  topic: string
  event: string
  warn: (message: string) => void
}): TopicPublisher {
  let closed = false
  let joined = false
  let latest: unknown = undefined
  let live: RpcChannel | null = null
  let unsubscribe: (() => void) | null = null
  const flush = () => {
    if (closed || !joined || !live || latest === undefined) return
    sendBroadcast(live, event, latest).catch((error: unknown) => {
      warn(`[topic-publisher] send failed on ${topic}: ${(error as Error)?.message ?? String(error)}`)
    })
  }
  const createChannel = () => {
    const channel = supabase.channel(topic, { config: { private: true, broadcast: { self: false, ack: true } } })
    live = channel as TChannel & RpcChannel & ElectronManagedRealtimeChannel
    joined = false
    return live as TChannel & RpcChannel & ElectronManagedRealtimeChannel
  }
  void subscribeAuthenticatedElectronRealtimeChannel(realtimeClient, createChannel(), {
    label: `topic-publisher:${topic}`,
    createChannel,
    onStatus: (status, err) => {
      const name = subscribeStatusName(status)
      if (name === 'SUBSCRIBED' || name.endsWith('.SUBSCRIBED')) {
        joined = true
        flush()
        return
      }
      if (isSubscribeFailure(status)) {
        joined = false
        if (!closed) warn(`[topic-publisher] subscribe failed on ${topic}: ${name}${err ? ` ${err.message}` : ''}`)
      }
    },
    reconnectOnStatus: (status) => isSubscribeFailure(status)
  })
    .then((stop) => {
      if (closed) stop()
      else unsubscribe = stop
    })
    .catch((error: unknown) => {
      warn(`[topic-publisher] subscribe threw on ${topic}: ${(error as Error)?.message ?? String(error)}`)
    })
  return {
    send: (payload) => {
      latest = payload
      flush()
    },
    close: () => {
      closed = true
      unsubscribe?.()
      unsubscribe = null
      live = null
    }
  }
}
