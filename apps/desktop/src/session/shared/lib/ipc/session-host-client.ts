// @@@task-web-host / #6264 会话页宿主协议的客户端一侧,与「帧怎么过线」无关(照 VS Code Agent Host:
// 本机走进程内 IPC,远端走同一套帧)。承载 preload 那五个方法里要过线的四个:
//   invoke(channel, ...args) → result   eventSend(channel, data)   eventOn(channel)   wire 端口
// 线有两种:浏览器形态的 WebSocket(src/lib/session-host-ws-client.ts)、别的机器的设备连接
// (SSH / 咕咕云,由咕咕壳经 remote-hosts 桥给)。宿主一侧见 electron/session/main/host-ws/frame-host.ts。
//
// 连接策略:首次调用时懒连;断线后 invoke 直接拒绝(不静默排队——排队会让界面看起来「卡住」),
// 按退避重连;重连成功后 eventOn 的订阅仍在(订阅是本地表,线上的订阅重报一遍),wire 端口由 session-wire 的
// reconnecting 传输重开。
import type { Unsubscribe } from '@gugu/session-shared'
import type { WireMessage, WireTransport } from '@gugu/session-wire'
import {
  decodeHostWsMessage,
  encodeHostWsMessage,
  HOST_WS_HEARTBEAT_MS,
  HOST_WS_STALE_MS,
  type HostWsClientMessage,
  type HostWsServerMessage,
} from './host-ws-protocol'

/** 一条接上了的线。send 在线已断时抛错。 */
export type SessionHostPipe = {
  /** `heartbeat` = 这一帧只是心跳:管道可以按「探活」对待它(例如等应答等得更短),❌ 当成要办的事。 */
  send(frame: string | Uint8Array, kind?: 'heartbeat'): void
  close(): void
}

/** 开一条线:接上了才 resolve;之后收到的帧与断开经 handlers 报回来。 */
export type SessionHostPipeOpener = ((handlers: {
  onFrame(frame: string | Uint8Array): void
  onClose(reason: string): void
}) => Promise<SessionHostPipe>) & {
  /**
   * 听「那台机器上的宿主刚(重新)起来了」。挂在客户端「想连着它」的整段上(开线中、退避等着、窗口开着),❌ 挂在某一条管道上 ——
   * 宿主起来那一刻,客户端多半正停在「上一次开线超时了、下一拍还没到」的空档里,那时没有管道。返回取消听。
   */
  watchPeerRestart?(onRestart: () => void): () => void
}

/** 用户可见的三句断连文案(由调用方注入本地化文案;传输层不认 i18n)。 */
export type SessionHostClientMessages = {
  hostNotConnected: string
  hostConnectionLost: string
  hostUnreachable: string
  /** 开线被拒:那台机器上的咕咕太旧(`server_outdated`)。 */
  hostTooOld: string
  /** 开线被拒:这一端的咕咕对那台机器太旧(`client_outdated`)。 */
  clientTooOld: string
}

const DEFAULT_MESSAGES: SessionHostClientMessages = {
  hostNotConnected: 'Task host is not connected',
  hostConnectionLost: 'Task host connection lost. Reconnecting.',
  hostUnreachable: 'Cannot reach the task host. Make sure it is running, then reload.',
  hostTooOld: 'Gugu on that machine is too old. Update Gugu there.',
  clientTooOld: 'Gugu here is too old for that machine. Update Gugu here.',
}

export type SessionHostBridgeApi = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  eventSend(channel: string, data: unknown): void
  eventOn(channel: string, cb: (data: unknown) => void): () => void
  getPathForFile(file: File): string
  requestWirePort(channel: string): Promise<void>
}

export type SessionHostConnectionState = 'connecting' | 'open' | 'closed'

export type SessionHostHello = { protocol: number; appVersion: string | null }

export type SessionHostClient = {
  api: SessionHostBridgeApi
  /** 直接拿一条 wire 传输(不经 window.postMessage 交端口;别的机器用它,可断线重开)。 */
  openWireTransport(channel: string): Promise<WireTransport>
  state(): SessionHostConnectionState
  onStateChange(cb: (state: SessionHostConnectionState) => void): () => void
  /** 最近一次接上时宿主报的版本;还没接上过 = null。 */
  hello(): SessionHostHello | null
  connect(): Promise<void>
  /** 别等退避了,现在就再连一次(那台机器刚上线 / 刚登上)。 */
  reconnectNow(): void
  close(): void
}

export type SessionHostClientOptions = {
  /** 连不上 / 断了时抛出去的那几句话;给函数 = 每次抛的时候现取(界面语言、机器名可能变了)。 */
  messages?: Partial<SessionHostClientMessages> | (() => Partial<SessionHostClientMessages>)
  /** 超过这么久一帧都没收到 = 线已死(宿主每拍都发 hb)。 */
  staleMs?: number
  /** 量「多久没收到帧」的钟;单测注入。默认 Date.now:设备深睡时它照走,宿主那边的钟也照走。 */
  now?: () => number
  /** 只要订了的频道(sub / unsub)。经网络连别的机器时要开,❌ 让整台机器的事件都推过来。 */
  subscribeEvents?: boolean
  /** 客户端心跳间隔;线没有自己的 ping 时要开(设备连接)。0 = 不发。 */
  heartbeatMs?: number
  /** 已确认不可达(含云电脑休眠)时不开线、不发心跳、不退避；变化后恢复原订阅。 */
  isReachable?: () => boolean
  subscribeReachability?: (listener: () => void) => () => void
  /** 重连退避上限。 */
  retryMaxMs?: number
  /** 宿主为某个 wire channel 宣告了端口、又没人经 openWireTransport 等它时:交给页面(浏览器形态)。 */
  deliverPortToPage?: (channel: string, port: MessagePort) => void
  warn?: (message: string, detail?: Record<string, unknown>) => void
  /** 开线失败的原始原因(判「那台机器太旧」这类要看原因的场合)。 */
  onOpenFailed?: (error: unknown) => void
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

type WirePortSink = {
  onMessage: Set<(message: WireMessage) => void>
  onDisconnect: Set<() => void>
}

export function createSessionHostClient(open: SessionHostPipeOpener, options: SessionHostClientOptions = {}): SessionHostClient {
  const failureText = (key: keyof SessionHostClientMessages): string => {
    const given = typeof options.messages === 'function' ? options.messages() : options.messages
    return given?.[key] ?? DEFAULT_MESSAGES[key]
  }
  const staleMs = options.staleMs ?? HOST_WS_STALE_MS
  const now = options.now ?? Date.now
  const heartbeatMs = options.heartbeatMs ?? 0
  // 这边被冻住多久宿主就可能已经关窗:宿主一整拍(HOST_WS_HEARTBEAT_MS)没收到这边任何东西就关。冻住之前这边最后一次
  // 发东西最早在「一个心跳周期」之前(WebSocket 路由浏览器即时回 pong,算 0),所以这边冻住超过 一拍 − 心跳周期 时,
  // 宿主可能已经数满一整拍了。
  const frozenMs = HOST_WS_HEARTBEAT_MS - heartbeatMs
  if (frozenMs <= 0) throw new Error(`[session-host] heartbeatMs ${heartbeatMs} must be shorter than the host beat ${HOST_WS_HEARTBEAT_MS}`)
  const retryMaxMs = options.retryMaxMs ?? 5000
  const warn = options.warn ?? (() => undefined)
  let pipe: SessionHostPipe | null = null
  let generation = 0
  let lastSeenAt = 0
  /** 看门狗上一次真的跑到的时刻:App 在后台被冻住时它停着,醒来时缓在 socket 里的旧帧刷不动它。 */
  let lastTickAt = 0
  let watchdog: ReturnType<typeof setInterval> | null = null
  let beat: ReturnType<typeof setInterval> | null = null
  let state: SessionHostConnectionState = 'closed'
  let opening: Promise<void> | null = null
  // 作废的是一次物理开线,不是等连接的调用。立即叫醒旧调用,让它跟随新的那次;
  // 不能等旧 opener 自己结算(它可能正卡在断掉的网络上)。
  let abandonOpening: (() => void) | null = null
  let lastHello: SessionHostHello | null = null
  let nextId = 1
  let retryDelay = 1000
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  /** 头一回想连时挂上,close 时摘掉:收到就 reconnectNow(在开线就作废这一问,在退避就取消计时、立刻重开,开着就换一条)。 */
  let unwatchPeer: (() => void) | null = null
  let unwatchReachability: (() => void) | null = null
  const reachable = () => options.isReachable?.() ?? true
  const pending = new Map<number, Pending>()
  const eventListeners = new Map<string, Set<(data: unknown) => void>>()
  const stateListeners = new Set<(state: SessionHostConnectionState) => void>()
  /** 等宿主宣告端口的 requestWirePort 调用:`<channel>:port` → resolve */
  const awaitingPorts = new Map<string, { resolve: (portId: number) => void; reject: (e: Error) => void }>()
  /** 已建立的端口:portId → 页面那一侧的 DOM MessagePort,或 openWireTransport 的接收端 */
  const pagePorts = new Map<number, MessagePort>()
  const wirePorts = new Map<number, WirePortSink>()
  /** openWireTransport 正在等的 channel(它来的端口不交给页面)。 */
  const directChannels = new Set<string>()

  const setState = (next: SessionHostConnectionState) => {
    if (state === next) return
    state = next
    for (const cb of [...stateListeners]) cb(next)
  }

  const send = (message: HostWsClientMessage): void => {
    if (!pipe || state !== 'open') throw new Error(failureText('hostNotConnected'))
    pipe.send(encodeHostWsMessage(message))
  }

  const trySend = (message: HostWsClientMessage): void => {
    try {
      send(message)
    } catch {
      /* 断着:重连时订阅会重报 */
    }
  }

  // 心跳标明是心跳:管道据此把它当探活(设备连接上那一问回得慢 = 对面没了,见 remoteSessionHost)。
  const sendHeartbeat = (): void => {
    if (!pipe || state !== 'open') return
    try {
      pipe.send(encodeHostWsMessage({ t: 'hb' }), 'heartbeat')
    } catch {
      /* 断着:重连之后照常 */
    }
  }

  const failAll = (reason: string) => {
    for (const { reject } of pending.values()) reject(new Error(reason))
    pending.clear()
    for (const { reject } of awaitingPorts.values()) reject(new Error(reason))
    awaitingPorts.clear()
    for (const port of pagePorts.values()) port.close()
    pagePorts.clear()
    for (const sink of wirePorts.values()) for (const cb of [...sink.onDisconnect]) cb()
    wirePorts.clear()
  }

  const handle = (message: HostWsServerMessage): void => {
    switch (message.t) {
      case 'hello':
        lastHello = { protocol: message.v, appVersion: message.app ?? null }
        return
      case 'hb':
        return
      case 'result': {
        const entry = pending.get(message.id)
        if (!entry) return
        pending.delete(message.id)
        if (message.ok) entry.resolve(message.value)
        else {
          const error = new Error(message.error.message)
          error.name = message.error.name
          if (message.error.code) Object.assign(error, { code: message.error.code })
          entry.reject(error)
        }
        return
      }
      case 'event':
        for (const cb of [...(eventListeners.get(message.channel) ?? [])]) {
          try {
            cb(message.data)
          } catch {
            /* 一个听的人出错不挡别人 */
          }
        }
        return
      case 'port': {
        const waiting = awaitingPorts.get(message.channel)
        awaitingPorts.delete(message.channel)
        if (directChannels.has(message.channel)) {
          wirePorts.set(message.port, { onMessage: new Set(), onDisconnect: new Set() })
        } else {
          // 与 preload 的 window.postMessage({kind: '<ch>:port'}, '*', [port]) 同构:一头交给页面,另一头泵到线上。
          const { port1, port2 } = new MessageChannel()
          pagePorts.set(message.port, port2)
          port2.onmessage = (ev) => {
            try {
              send({ t: 'pm', port: message.port, msg: ev.data })
            } catch {
              port2.close()
            }
          }
          if (options.deliverPortToPage) options.deliverPortToPage(message.channel, port1)
          else port1.close()
        }
        waiting?.resolve(message.port)
        return
      }
      case 'pm': {
        const sink = wirePorts.get(message.port)
        if (sink) {
          for (const cb of [...sink.onMessage]) cb(message.msg as WireMessage)
          return
        }
        pagePorts.get(message.port)?.postMessage(message.msg)
        return
      }
      case 'pc': {
        const sink = wirePorts.get(message.port)
        wirePorts.delete(message.port)
        if (sink) for (const cb of [...sink.onDisconnect]) cb()
        const port = pagePorts.get(message.port)
        pagePorts.delete(message.port)
        port?.close()
        return
      }
      default:
        return
    }
  }

  const scheduleRetry = () => {
    if (disposed || retryTimer || !reachable()) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      void connect().catch(() => undefined)
    }, retryDelay)
    retryDelay = Math.min(retryDelay * 2, retryMaxMs)
  }

  const stopTimers = () => {
    if (watchdog) clearInterval(watchdog)
    if (beat) clearInterval(beat)
    watchdog = null
    beat = null
  }

  const onClosed = (gen: number, reason: string) => {
    if (gen !== generation) return
    generation += 1
    pipe = null
    stopTimers()
    opening = null
    abandonOpening?.()
    abandonOpening = null
    setState('closed')
    // 原因进日志,用户文案只留下一步(user-copy-leak 棘轮)。
    warn('会话页宿主连接关闭', { reason })
    failAll(failureText('hostConnectionLost'))
    scheduleRetry()
  }

  const reopen = (reason: string): void => {
    if (disposed) return
    // 开着的线也照样扔掉重开:对面换过版(咕咕 server 换版时什么也不说),这条线已经死了,下一拍心跳才知道
    if (state === 'open') {
      const dead = pipe
      onClosed(generation, reason)
      dead?.close()
    } else if (state === 'connecting') {
      // 在路上的那一次作废:等它的调用方当场跟随新线,迟到的回包只负责清理。
      generation += 1
      opening = null
      abandonOpening?.()
      abandonOpening = null
    }
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
    retryDelay = 1000
    void connect().catch(() => undefined)
  }
  const reconnectNow = (): void => reopen('reconnect requested')

  /**
   * @@@silent-window - 窗口多半已死的判据,看门狗按拍判、发问前当场判,都走这里。两个信号,各按宿主的关窗规矩定门槛:
   *  · 收帧:宿主每拍都发 hb,staleMs(两拍)一帧都没收到 = 线被中间设备掐死了。
   *  · 看门狗上一次真的跑到:这边被冻住时它停着,冻住超过 frozenMs 时宿主可能已经关了窗(见 frozenMs)。只看收帧不够:
   *    冻在后台醒来时,socket 里缓着的旧帧先交上来,收帧时刻一下子变新(安卓实测:冻 60 s,问被拒成「连不上」)。
   * 钟用 Date.now:设备深睡时它照走,与宿主那边的钟一致。
   * 代价:WebSocket 路在后台计时器被节流时(浏览器照回 pong,宿主那边其实还活着)也会判死重开;重开走 onClosed → failAll,
   * 这时还在路上的调用会被判成「连接断了」。
   */
  const dropIfSilent = (): boolean => {
    const t = now()
    if (state !== 'open' || (t - lastSeenAt <= staleMs && t - lastTickAt <= frozenMs)) return false
    warn('会话页宿主连接静默过久,主动断开重连', { staleMs, frozenMs })
    reopen('stale')
    return true
  }

  const suspend = (): void => {
    generation += 1
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
    stopTimers()
    const dead = pipe
    pipe = null
    opening = null
    abandonOpening?.()
    abandonOpening = null
    setState('closed')
    dead?.close()
    failAll(failureText('hostNotConnected'))
  }

  const connect = (): Promise<void> => {
    if (disposed) return Promise.reject(new Error('[session-host] client disposed'))
    unwatchReachability ??= options.subscribeReachability?.(() => {
      if (disposed) return
      if (!reachable()) suspend()
      else if (state === 'closed') reconnectNow()
    }) ?? null
    if (!reachable()) {
      suspend()
      return Promise.reject(Object.assign(new Error(failureText('hostNotConnected')), { code: 'unreachable' }))
    }
    if (pipe && state === 'open' && !dropIfSilent()) return Promise.resolve()
    if (opening) return opening
    unwatchPeer ??= open.watchPeerRestart?.(() => reconnectNow()) ?? null
    setState('connecting')
    const gen = ++generation
    const abandoned = new Promise<never>((_resolve, reject) => {
      abandonOpening = () => reject(new Error('[session-host] opening replaced or closed'))
    })
    const attempt = open({
      onFrame: (frame) => {
        if (gen !== generation) return
        lastSeenAt = now()
        const decoded = decodeHostWsMessage(frame)
        if (decoded) handle(decoded as HostWsServerMessage)
      },
      onClose: (reason) => onClosed(gen, reason),
    }).then((opened) => {
      // race 已经把等待者交给新线,旧 opener 仍可能迟到成功。这里拥有那条管道的清理。
      if (gen !== generation || disposed) {
        opened.close()
        throw new Error('[session-host] obsolete opening')
      }
      return opened
    })
    opening = Promise.race([attempt, abandoned]).then(
      (opened) => {
        if (gen !== generation || disposed) {
          // 这一次已被后来的一次取代:等它的调用方接着等现在那一次,❌ 拿一句「连不上」(disposed 时 connect 自己拒)
          opened.close()
          return connect()
        }
        pipe = opened
        retryDelay = 1000
        lastSeenAt = now()
        lastTickAt = lastSeenAt
        stopTimers()
        // 看门狗:线被中间设备掐死而这边还不知道时,按拍发现(判据见 dropIfSilent)。
        // 先判、再记这一拍:冻住醒来的那一拍要先看见这段空白。
        watchdog = setInterval(() => {
          if (gen === generation && !dropIfSilent()) lastTickAt = now()
        }, Math.max(1000, Math.floor(Math.min(staleMs, frozenMs) / 4)))
        if (heartbeatMs > 0) beat = setInterval(sendHeartbeat, heartbeatMs)
        setState('open')
        opening = null
        abandonOpening = null
        if (options.subscribeEvents) {
          for (const channel of eventListeners.keys()) trySend({ t: 'sub', channel })
        }
      },
      (error: unknown) => {
        const code = (error as { code?: unknown } | null)?.code
        // @@@open-abandoned - 开线器放弃了这一问(频道重订上 / 宿主刚起来,见 remoteSessionHost)或它已被后来的一次取代:
        // 这是「正在重连」,❌ 是「连不上」。当场再开(❌ 等退避),等着的调用方接着等新的那次;
        // 只有真的开不成(超时、被拒)才落到下面,说「连不上」。
        if (!disposed && (gen !== generation || code === 'channel_resubscribed' || code === 'host_restarted')) {
          if (gen === generation) {
            generation += 1
            opening = null
            warn('会话页宿主开线被放弃,当场重开', { code })
          }
          return connect()
        }
        if (gen === generation) {
          generation += 1
          opening = null
          abandonOpening = null
          setState('closed')
          // 开线器说那台机器此刻够不着(离线):这就是离线,❌ 记成「连不上」、❌ 退避空转 —— 停在 closed,
          // 它回来时由调用方 reconnectNow;有人要用它时再 connect 一次(当场又说够不着,不出网)。
          if (code !== 'unreachable') {
            warn('会话页宿主连不上', { error: String(error) })
            options.onOpenFailed?.(error)
            // A protocol mismatch needs an upgraded endpoint; retrying the same versions cannot repair it.
            if (code !== 'client_outdated' && code !== 'server_outdated') scheduleRetry()
          }
        }
        // 开线失败的原因码(那台机器的咕咕 server 太旧 / SSH 要先登录……)带给调用方,界面按码说人话;原文只进日志。
        // 版本错位说清是哪一边旧(两边各报协议,见 taskhost.open);别的失败一律「连不上」。
        const text = code === 'server_outdated' ? failureText('hostTooOld') : code === 'client_outdated' ? failureText('clientTooOld') : failureText('hostUnreachable')
        throw Object.assign(new Error(text), typeof code === 'string' ? { code } : {})
      },
    )
    return opening
  }

  const requestPort = async (channel: string): Promise<number> => {
    await connect()
    const portChannel = `${channel}:port`
    // 传输层:通道名是调用方给的(宿主口 / 端口),不是壳通道。
    const connectChannel = `${channel}:connect`
    return new Promise<number>((resolve, reject) => {
      awaitingPorts.set(portChannel, { resolve, reject })
      api.invoke(connectChannel).catch((error: unknown) => {
        awaitingPorts.delete(portChannel)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  const api: SessionHostBridgeApi = {
    invoke: async (channel, ...args) => {
      await connect()
      return new Promise<unknown>((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject })
        try {
          send({ t: 'invoke', id, channel, args })
        } catch (error) {
          pending.delete(id)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
    eventSend: (channel, data) => {
      void connect()
        .then(() => send({ t: 'send', channel, data }))
        .catch(() => undefined)
    },
    eventOn: (channel, cb) => {
      let set = eventListeners.get(channel)
      if (!set) {
        eventListeners.set(channel, (set = new Set()))
        if (options.subscribeEvents) {
          if (state === 'open') trySend({ t: 'sub', channel })
          // 有人在听就要有线:懒连(连上时会把全部订阅报一遍)。
          else void connect().catch(() => undefined)
        }
      }
      set.add(cb)
      return () => {
        const current = eventListeners.get(channel)
        if (!current?.delete(cb) || current.size > 0) return
        eventListeners.delete(channel)
        if (options.subscribeEvents) trySend({ t: 'unsub', channel })
      }
    },
    getPathForFile: () => '',
    requestWirePort: async (channel) => {
      await requestPort(channel)
    },
  }

  const openWireTransport = async (channel: string): Promise<WireTransport> => {
    const portChannel = `${channel}:port`
    directChannels.add(portChannel)
    const portId = await requestPort(channel)
    const sink = wirePorts.get(portId)
    if (!sink) throw new Error(failureText('hostConnectionLost'))
    let closed = false
    return {
      post(message) {
        if (closed || !wirePorts.has(portId)) throw new Error(failureText('hostConnectionLost'))
        send({ t: 'pm', port: portId, msg: message })
      },
      onMessage(cb): Unsubscribe {
        sink.onMessage.add(cb)
        return () => sink.onMessage.delete(cb)
      },
      onDisconnect(cb): Unsubscribe {
        sink.onDisconnect.add(cb)
        return () => sink.onDisconnect.delete(cb)
      },
      close() {
        if (closed) return
        closed = true
        if (wirePorts.delete(portId)) trySend({ t: 'pc', port: portId })
      },
    }
  }

  return {
    api,
    openWireTransport,
    state: () => state,
    onStateChange: (cb) => {
      stateListeners.add(cb)
      return () => stateListeners.delete(cb)
    },
    hello: () => lastHello,
    connect,
    reconnectNow,
    close: () => {
      disposed = true
      unwatchPeer?.()
      unwatchPeer = null
      unwatchReachability?.()
      unwatchReachability = null
      if (retryTimer) clearTimeout(retryTimer)
      generation += 1
      abandonOpening?.()
      abandonOpening = null
      opening = null
      stopTimers()
      pipe?.close()
      pipe = null
      setState('closed')
      failAll('[session-host] client closed')
    },
  }
}

/**
 * 客户端心跳拍子(设备连接用,线没有 ping):宿主一拍的一半。与宿主同拍时,两边相位漂到一起,一拍里就可能一个 hb 都没有
 * (醒着也会被关窗),冻住多短都可能已被关;半拍保证宿主每一拍里至少收到一次,也让 frozenMs 有 10 s。
 */
export const SESSION_HOST_CLIENT_HEARTBEAT_MS = HOST_WS_HEARTBEAT_MS / 2
