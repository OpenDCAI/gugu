/**
 * #7233 宿主这一侧的「一个发问端一条线」(协议 9):每个报到过的发问端一条 `gugu:<dev>:rpc:<asker>`,它的请求从这条进、
 * 回包与窗口回帧从这条出。发问端那一侧见 @gugu/core/cloud/deviceRpcAttach。
 *
 * 每条线:
 * - 订上之前要发的帧全部按先后排着,订上后照原序发完 —— 窗口帧按 seq 拼,❌ 只留最新一份(createTopicPublisher 那种
 *   只适合整份状态)。排队有上限(`queueFrames` 条 / `queueChars` 字):超了说明这条一直订不上,离开它(见下),
 *   发问端下一问会重新报到、窗口重开。
 * - 离开之前先在这条上说 `taskhost.detached`,再走:发问端据此下一问前重新报到;那一声丢了,它的一问会超时,超时就重新报到、
 *   原样重发一次(同一个 request_id,宿主按它去重 —— deviceRpcResponder)。离开时经它开的会话页窗口一并关掉。
 * - 什么时候离开:`idleMs` 里它一问都没问(开着窗口的发问端每 20 s 有一拍心跳,不会算空闲);报到的发问端超过 `maxAskers`
 *   个时,给新来的让位 —— 离开最久没问过的那一个;宿主收摊(频道换了 / 退出)时全部离开。
 * - 每 DEVICE_RPC_ALIVE_MS 在它上面发一条 alive:发问端的看门狗靠它分清「没人说话」和「线悄悄死了」(#840)。
 */
import {
  createDeviceRpcReplyEnvelope,
  DEVICE_RPC_ALIVE,
  DEVICE_RPC_ASKER_ID,
  DEVICE_RPC_ATTACH,
  DEVICE_RPC_DETACHED,
  deviceRpcAskerChannelName,
  deviceRpcFrameType,
  isSubscribeFailure,
  subscribeStatusName,
  type DeviceRpcRequestEnvelope,
} from '@gugu/core/cloud/deviceRpcProtocol'
import type { DeviceRpcAskerContext, PublishDeviceRpcEvent, PublishDeviceRpcReply } from '@gugu/core/cloud/deviceRpcResponder'
import { MIN_CLIENT_PROTOCOL, REMOTE_PROTOCOL_VERSION } from '@gugu/core/cloud/serverMachineHealth'
import type { ElectronManagedRealtimeChannel } from './realtime-channel'
import { subscribeAuthenticatedElectronRealtimeChannel } from './realtime-channel'

type RpcChannel = {
  on: (kind: 'broadcast', filter: { event: string }, callback: (payload: unknown) => void) => RpcChannel
  subscribe: (callback: (status: string, err?: Error) => void) => RpcChannel
  send: (message: { type: 'broadcast'; event: string; payload: unknown }) => Promise<unknown>
}

type RpcSupabaseClient<TChannel> = {
  realtime: { setAuth: (accessToken: string) => unknown | Promise<unknown> }
  channel: (topic: string, options: { config: { private: boolean; broadcast: { self: boolean; ack: boolean } } }) => TChannel
  removeChannel: (channel: TChannel) => unknown
}

export type DeviceRpcAskerLimits = {
  /** 同时在线的发问端最多几个;再来一个就让最久没问过的那个离开。 */
  maxAskers: number
  /** 这么久一问都没有就离开。 */
  idleMs: number
  /** 订上之前最多排多少条 / 多少字,超了就离开这条。 */
  queueFrames: number
  queueChars: number
}

export const DEVICE_RPC_ASKER_LIMITS: DeviceRpcAskerLimits = {
  maxAskers: 32,
  idleMs: 5 * 60_000,
  queueFrames: 4_096,
  queueChars: 64 * 1024 * 1024,
}

/**
 * 测试装置用的上限(只在 GUGU_SESSION_TEST_HOOKS=1 时读):A/B 里要让一台机器挤掉 / 空闲关掉一个发问端,
 * ❌ 真开 33 个客户端、❌ 等 5 分钟。
 */
export function deviceRpcAskerLimitsFromEnv(env: NodeJS.ProcessEnv): DeviceRpcAskerLimits {
  if (env.GUGU_SESSION_TEST_HOOKS !== '1') return DEVICE_RPC_ASKER_LIMITS
  const read = (name: string, fallback: number) => {
    const value = Number(env[name])
    return Number.isInteger(value) && value > 0 ? value : fallback
  }
  return {
    ...DEVICE_RPC_ASKER_LIMITS,
    maxAskers: read('GUGU_TEST_DEVICE_RPC_MAX_ASKERS', DEVICE_RPC_ASKER_LIMITS.maxAskers),
    idleMs: read('GUGU_TEST_DEVICE_RPC_ASKER_IDLE_MS', DEVICE_RPC_ASKER_LIMITS.idleMs),
  }
}

/** 一个发问端在这台机器上的那条线。 */
type Asker = {
  id: string
  channel: (RpcChannel & ElectronManagedRealtimeChannel) | null
  joined: boolean
  leaving: boolean
  queue: unknown[]
  queuedChars: number
  lastAsked: number
  detached: Set<() => void>
  /** 订那一步交回的「退订」(订失败 = null)。 */
  subscription: Promise<(() => Promise<void>) | null>
}

export type DeviceRpcAskers = {
  /** 共用 topic 上来的一声报到。 */
  attach(request: DeviceRpcRequestEnvelope): void
  /** 在每条订上了的线上发一条 alive。 */
  alive(): void
  /** 空闲的离开(由调用方定时调)。 */
  sweep(): void
  /** 现在在线的发问端(测试 / 日志)。 */
  ids(): string[]
  /** 宿主收摊:全部离开。 */
  dispose(): void
}

export function createDeviceRpcAskers<TChannel>(input: {
  supabase: RpcSupabaseClient<TChannel>
  accessToken: string
  deviceId: string
  /** 一问:从发问端那条进来的请求交给它,回包与推送发回那条。 */
  handle: (payload: unknown, publishReply: PublishDeviceRpcReply, publishEvent: PublishDeviceRpcEvent, asker: DeviceRpcAskerContext) => Promise<void>
  /** 报到被拒(协议旧 / id 不合法)时在共用 topic 上答。 */
  replyShared: PublishDeviceRpcReply
  limits?: DeviceRpcAskerLimits
  warn?: (message: string) => void
  now?: () => number
  /** 离开前说 detached 最多等多久(等它被频道收下),再走。 */
  detachGraceMs?: number
}): DeviceRpcAskers {
  const limits = input.limits ?? DEVICE_RPC_ASKER_LIMITS
  const warn = input.warn ?? (() => undefined)
  const now = input.now ?? (() => Date.now())
  const detachGraceMs = input.detachGraceMs ?? 2_000
  const askers = new Map<string, Asker>()
  /**
   * 离开了、那条还没退完的发问端:它这时再报到,等退完再开线。realtime-js 的 channel(topic) 在同名那条退完之前会把它交回来,
   * 新开的线就订在一条要退的频道上,随它一起没了(发问端从此报到不上,直到空闲关掉 —— 可它每报到一次都算「问过」)。
   */
  const leavingAskers = new Map<string, Promise<void>>()
  const realtimeClient = {
    realtime: input.supabase.realtime,
    removeChannel: (channel: ElectronManagedRealtimeChannel) => input.supabase.removeChannel(channel as TChannel),
  }

  const send = (asker: Asker, payload: unknown) => {
    void asker.channel?.send({ type: 'broadcast', event: 'broadcast', payload }).catch((error: unknown) => {
      warn(`[device-rpc] send failed on ${asker.id.slice(0, 8)}: ${(error as Error)?.message ?? String(error)}`)
    })
  }

  const publish = (asker: Asker, payload: unknown): unknown => {
    if (asker.leaving) return undefined
    if (asker.joined && asker.channel) {
      send(asker, payload)
      return undefined
    }
    const chars = JSON.stringify(payload)?.length ?? 0
    if (asker.queue.length + 1 > limits.queueFrames || asker.queuedChars + chars > limits.queueChars) {
      warn(`[device-rpc] asker ${asker.id.slice(0, 8)}: ${asker.queue.length} frames waiting for its topic, over the limit — leaving it`)
      leave(asker, 'overflow')
      return undefined
    }
    asker.queue.push(payload)
    asker.queuedChars += chars
    return undefined
  }

  const leave = (asker: Asker, reason: string) => {
    if (asker.leaving) return
    asker.leaving = true
    if (askers.get(asker.id) === asker) askers.delete(asker.id)
    for (const callback of [...asker.detached]) {
      try {
        callback()
      } catch (error) {
        warn(`[device-rpc] detach callback failed: ${(error as Error)?.message ?? String(error)}`)
      }
    }
    asker.detached.clear()
    asker.queue = []
    asker.queuedChars = 0
    let markLeft: () => void = () => undefined
    const left = new Promise<void>((resolve) => { markLeft = resolve })
    leavingAskers.set(asker.id, left)
    void left.then(() => {
      if (leavingAskers.get(asker.id) === left) leavingAskers.delete(asker.id)
    })
    const gone = () => {
      asker.channel = null
      asker.joined = false
      // 还在订的,订那一步交回来时再退
      void asker.subscription.then((stop) => stop?.()).catch(() => undefined).then(markLeft)
    }
    const channel = asker.channel
    if (!asker.joined || !channel) return gone()
    const said = channel.send({ type: 'broadcast', event: 'broadcast', payload: { type: DEVICE_RPC_DETACHED, reason } })
    void Promise.race([said, new Promise((resolve) => setTimeout(resolve, detachGraceMs))]).then(gone, gone)
  }

  const open = (id: string): Asker => {
    const asker: Asker = { id, channel: null, joined: false, leaving: false, queue: [], queuedChars: 0, lastAsked: now(), detached: new Set(), subscription: Promise.resolve(null) }
    const context: DeviceRpcAskerContext = {
      id,
      onDetached: (callback) => {
        if (asker.leaving) {
          // 已经在离开:下一拍再叫(❌ 同步叫 —— 登记的那一方可能还没登记完)。
          queueMicrotask(callback)
          return () => undefined
        }
        asker.detached.add(callback)
        return () => asker.detached.delete(callback)
      },
    }
    const createChannel = () => {
      const channel = input.supabase.channel(deviceRpcAskerChannelName(input.deviceId, id), {
        config: { private: true, broadcast: { self: false, ack: true } },
      }) as TChannel & RpcChannel & ElectronManagedRealtimeChannel
      asker.channel = channel
      asker.joined = false
      channel.on('broadcast', { event: 'broadcast' }, (payload) => {
        if (asker.leaving) return
        // 报到只在共用 topic 上;这条上只收这个发问端的请求。
        if (deviceRpcFrameType(payload) === DEVICE_RPC_ATTACH) return
        asker.lastAsked = now()
        void input.handle(payload, (reply) => publish(asker, reply), (event) => publish(asker, event), context)
      })
      return channel
    }
    asker.subscription = subscribeAuthenticatedElectronRealtimeChannel(realtimeClient, createChannel(), {
      accessToken: input.accessToken,
      label: `device-rpc-asker:${id.slice(0, 8)}`,
      createChannel,
      onStatus: (status, err) => {
        const name = subscribeStatusName(status)
        if (name === 'SUBSCRIBED' || name.endsWith('.SUBSCRIBED')) {
          if (asker.leaving) return
          asker.joined = true
          const queued = asker.queue
          asker.queue = []
          asker.queuedChars = 0
          // 照原序发:同一条 socket 上先发先到,窗口帧的 seq 由发问端那边再排一次。
          for (const payload of queued) send(asker, payload)
          return
        }
        if (isSubscribeFailure(status)) {
          asker.joined = false
          if (!asker.leaving) warn(`[device-rpc] asker topic ${id.slice(0, 8)} subscribe failed: ${name}${err ? ` ${err.message}` : ''}`)
        }
      },
      reconnectOnStatus: (status) => isSubscribeFailure(status),
    }).then(
      (stop) => stop,
      (error: unknown) => {
        warn(`[device-rpc] asker topic ${id.slice(0, 8)} subscribe threw: ${(error as Error)?.message ?? String(error)}`)
        leave(asker, 'unreachable')
        return null
      },
    )
    askers.set(id, asker)
    return asker
  }

  const api: DeviceRpcAskers = {
    attach(request) {
      const body = (request.payload ?? {}) as { asker?: unknown; protocol?: unknown }
      const refuse = (code: string, message: string) =>
        void Promise.resolve(input.replyShared(createDeviceRpcReplyEnvelope(DEVICE_RPC_ATTACH, request.request_id, { error: { code, message } }))).catch(() => undefined)
      if (typeof body.asker !== 'string' || !DEVICE_RPC_ASKER_ID.test(body.asker)) return refuse('invalid_payload', 'asker 是必填的')
      if (typeof body.protocol !== 'number' || body.protocol < MIN_CLIENT_PROTOCOL) {
        return refuse('client_outdated', `Gugu on the device asking is too old (protocol ${String(body.protocol)}, this machine needs ${MIN_CLIENT_PROTOCOL}): update Gugu there`)
      }
      let asker = askers.get(body.asker)
      if (!asker) {
        const leaving = leavingAskers.get(body.asker)
        if (leaving) {
          void leaving.then(() => api.attach(request))
          return
        }
        // 给新来的让位:离开最久没问过的。
        while (askers.size >= limits.maxAskers) {
          const oldest = [...askers.values()].reduce((a, b) => (b.lastAsked < a.lastAsked ? b : a))
          leave(oldest, 'make_room')
        }
        asker = open(body.asker)
      }
      asker.lastAsked = now()
      publish(asker, createDeviceRpcReplyEnvelope(DEVICE_RPC_ATTACH, request.request_id, { result: { attached: true, protocol: REMOTE_PROTOCOL_VERSION } }))
    },
    alive() {
      for (const asker of askers.values()) if (asker.joined && !asker.leaving) send(asker, { type: DEVICE_RPC_ALIVE })
    },
    sweep() {
      const t = now()
      for (const asker of [...askers.values()]) if (t - asker.lastAsked >= limits.idleMs) leave(asker, 'idle')
    },
    ids: () => [...askers.keys()],
    dispose() {
      for (const asker of [...askers.values()]) leave(asker, 'host_closed')
    },
  }
  return api
}
