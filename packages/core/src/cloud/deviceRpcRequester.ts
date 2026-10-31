/**
 * 设备 RPC 的请求方 —— 全 app 只有这一份:渲染层(桌面窗口 / 手机,src/lib/deviceRpc.ts)和主进程(agent 的
 * session_* 跨机器,electron/main.ts)都用它。不碰 node / electron,两边都能跑。
 *
 * 它只管「一台机器一条管道上的请求与应答」:发信封、按 request_id 认回复、到期就失败;不是回复的广播交给 onEvent。
 * 管道怎么开(咕咕云私有频道 / 远程 SSH 的设备连接)、断了怎么重开,由调用方的 openPipe 决定。
 */
import {
  createDeviceRpcRequestEnvelope,
  deviceRpcReplyType,
  parseDeviceRpcReply,
  type DeviceRpcError,
  type DeviceRpcResponse,
} from './deviceRpcProtocol'

/** 到一台机器的一条管道:写一条信封;收到的每条广播交给 onMessage。 */
export type DeviceRpcPipe = {
  send(message: unknown): Promise<void>
  close(): void
  /**
   * 一问超时没回:这条管道可能已经不在那台机器的线上(咕咕云:宿主空闲关了 / 挤掉了这个发问端,说 detached 的那一帧丢了)。
   * 有它的管道,请求方先叫它重新报到,再把这一问原样重发一次(同一个 request_id,宿主按它去重)。没有它的(SSH)照旧超时。
   */
  recover?(): void
  /** 匹配到仍在等待的请求的回包(含业务错误):由管道维护自己的存活判断。 */
  onReply?(): void
  /** 这一问最终超时;尚未就绪的管道不通知,不把握手期限当应用链路故障。 */
  onRequestTimeout?(timeoutMs: number): void
}

/**
 * 那台机器明说不接(报到被拒:它太旧 `unknown_method`,或这一端太旧 `client_outdated`)。请求方把它当成这一问的应答
 * (`{ error }`),调用方据此说「请更新」,❌ 当成线断了。
 */
export class DeviceRpcRefused extends Error {
  constructor(readonly error: DeviceRpcError) {
    super(`${error.code}: ${error.message}`)
    this.name = 'DeviceRpcRefused'
  }
}

/** 管道断了:`error` 是管道自己的定性(SSH 的 SshLinkError、频道被拒……),在途的请求都以它失败。 */
export type DeviceRpcPipeHandlers = { onMessage(payload: unknown): void; onClosed(error: unknown): void }

/** 应答没在期限内回来(期限从调用那一刻算,含开管道)。对方可能只是慢 —— ❌ 当成「没送到」去重发有副作用的动作。 */
export class DeviceRpcTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeviceRpcTimeoutError'
  }
}

/** 管道开不起来 / 中途断了。`reason` 是管道自己的定性(signInRequired / outdated / unreachable / closed …)。 */
export class DeviceRpcChannelError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message)
    this.name = 'DeviceRpcChannelError'
  }
}

export type DeviceRpcRequester = {
  call(deviceId: string, type: string, payload: unknown, options: { timeoutMs: number; signal?: AbortSignal }): Promise<DeviceRpcResponse<unknown>>
  /** 只开管道(推送订阅者要先有管道才收得到)。 */
  open(deviceId: string): Promise<void>
  /** 拆掉这台机器的管道,在途的请求以 `error` 失败。 */
  close(deviceId: string, error?: unknown): void
  /**
   * 先接后断换通道时用(#625):这台机器此刻的管道退下来 —— 之后的问都开新管道;退下来的那条还能往那台机器写几句告别
   * (不等应答,如关掉经它开的窗口),写完由调用方 `close` 拆掉,在途的请求那时以 `error` 失败。没有管道 = null。
   */
  retire(deviceId: string): RetiredDeviceRpcPipe | null
  closeAll(error?: unknown): void
}

export type RetiredDeviceRpcPipe = {
  /** 往退下来的那条管道上写一问,不等应答;写出去即落定。 */
  tell(type: string, payload: unknown): Promise<void>
  close(error?: unknown): void
}

type Pending = {
  expectedType: string
  resolve(value: DeviceRpcResponse<unknown>): void
  reject(error: unknown): void
  /** 管道因为断过又订上而作废(`rejoined`):换一条新管道原样重发(只一次);返回 false = 已经重发过了。 */
  reissue(): boolean
}
type Entry = { pipe: Promise<DeviceRpcPipe>; live: DeviceRpcPipe | null; pending: Map<string, Pending> }

export function createDeviceRpcRequester(options: {
  /** 请求信封上的发起人(账号)。 */
  userId: () => Promise<string>
  openPipe: (deviceId: string, handlers: DeviceRpcPipeHandlers) => Promise<DeviceRpcPipe>
  /** 不是回复的广播(设备推来的事件)。 */
  onEvent?: (deviceId: string, payload: unknown) => void
  /** 一次请求超时、管道上又没有别的在途请求时,这条管道留不留(默认不留:下一次调用重开,换掉可能已经死了的那条)。 */
  keepAliveOnTimeout?: (deviceId: string) => boolean
  newRequestId?: () => string
}): DeviceRpcRequester {
  const entries = new Map<string, Entry>()
  const newRequestId = options.newRequestId ?? (() => globalThis.crypto.randomUUID())

  const drop = (deviceId: string, entry: Entry, error: unknown) => {
    if (entries.get(deviceId) === entry) entries.delete(deviceId)
    // #7233 断过又订上(咕咕云的两条线有一条判死重订了):在途的问换一条新管道原样重发一次,❌ 当场失败 —— 宿主按 request_id 去重。
    const again = error instanceof DeviceRpcChannelError && error.reason === 'rejoined'
    for (const pending of [...entry.pending.values()]) {
      if (again && pending.reissue()) continue
      pending.reject(error)
    }
    entry.pending.clear()
    void entry.pipe.then((pipe) => pipe.close(), () => undefined)
  }

  const ensure = (deviceId: string): Entry => {
    const existing = entries.get(deviceId)
    if (existing) return existing
    const entry: Entry = { pipe: undefined as unknown as Promise<DeviceRpcPipe>, live: null, pending: new Map() }
    entry.pipe = options.openPipe(deviceId, {
      onMessage: (payload) => {
        if (entries.get(deviceId) !== entry) return
        const reply = parseDeviceRpcReply(payload)
        if (!reply) {
          options.onEvent?.(deviceId, payload)
          return
        }
        const pending = entry.pending.get(reply.requestId)
        // 同一条频道上还有别人(手机、别的桌面)的请求与应答:只认自己发出去的那一条。
        if (!pending || pending.expectedType !== reply.type) return
        pending.resolve({ result: reply.result, error: reply.error })
      },
      onClosed: (error) => drop(deviceId, entry, error),
    })
    entry.pipe.then((pipe) => { entry.live = pipe }, (error: unknown) => drop(deviceId, entry, error))
    entries.set(deviceId, entry)
    return entry
  }

  return {
    async call(deviceId, type, payload, { timeoutMs, signal }) {
      signal?.throwIfAborted()
      const userId = await options.userId()
      let entry = ensure(deviceId)
      const requestId = newRequestId()
      const message = { type: 'broadcast', event: 'broadcast', payload: createDeviceRpcRequestEnvelope(type, requestId, userId, payload) }
      // 开管道与写信封都算在这次请求的期限里(下面那只计时器);期限已过就不再写 —— 迟到的请求可能有副作用。
      // 写到当时的那条管道上;那条后来作废、这一问换到新管道上重发时,旧那条写失败 ❌ 算到新的头上。
      const write = () => {
        const target = entry
        void (async () => {
          const pipe = await target.pipe
          if (!target.pending.has(requestId)) return
          await pipe.send(message)
        })().catch((error: unknown) => {
          const pending = target.pending.get(requestId)
          if (!pending) return
          if (error instanceof DeviceRpcRefused) pending.resolve({ error: error.error })
          else pending.reject(error)
        })
      }
      const reply = new Promise<DeviceRpcResponse<unknown>>((resolve, reject) => {
        const settle = (finish: () => void) => {
          if (!entry.pending.delete(requestId)) return
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          finish()
        }
        const onAbort = () => settle(() => reject(signal?.reason ?? new Error('aborted')))
        let retried = false
        const onTimeout = () => {
          // #7233:咕咕云的管道上一问没回,可能是那台机器已经不在这个发问端的线上了(空闲关了 / 挤掉了,说 detached 的那一帧
          // 又丢了):重新报到,原样重发一次。同一个 request_id —— 宿主按它去重,已经办过的直接回上次的答复,❌ 再办一遍
          // (上传的一片、发出去的一句都不会重复)。只重发一次,再不回就照实超时。
          const pipe = entry.live
          if (!retried && pipe?.recover && entry.pending.has(requestId)) {
            retried = true
            pipe.recover()
            timer = setTimeout(onTimeout, timeoutMs)
            write()
            return
          }
          settle(() => {
            reject(new DeviceRpcTimeoutError(`no reply to ${type} within ${timeoutMs} ms${retried ? ' (asked twice)' : ''}`))
            entry.live?.onRequestTimeout?.(timeoutMs)
            if (entry.pending.size === 0 && !options.keepAliveOnTimeout?.(deviceId)) {
              drop(deviceId, entry, new DeviceRpcChannelError('dropped after a timeout', 'closed'))
            }
          })
        }
        let timer = setTimeout(onTimeout, timeoutMs)
        signal?.addEventListener('abort', onAbort, { once: true })
        const pending: Pending = {
          expectedType: deviceRpcReplyType(type),
          resolve: (value) => settle(() => {
            entry.live?.onReply?.()
            resolve(value)
          }),
          reject: (error) => settle(() => reject(error)),
          reissue: () => {
            if (retried) return false
            retried = true
            entry.pending.delete(requestId)
            entry = ensure(deviceId)
            entry.pending.set(requestId, pending)
            clearTimeout(timer)
            timer = setTimeout(onTimeout, timeoutMs)
            write()
            return true
          },
        }
        entry.pending.set(requestId, pending)
      })
      write()
      return reply
    },
    async open(deviceId) {
      await ensure(deviceId).pipe
    },
    close(deviceId, error = new DeviceRpcChannelError('requester closed', 'closed')) {
      const entry = entries.get(deviceId)
      if (entry) drop(deviceId, entry, error)
    },
    retire(deviceId) {
      const entry = entries.get(deviceId)
      if (!entry) return null
      entries.delete(deviceId)
      return {
        tell: async (type, payload) => {
          const userId = await options.userId()
          const pipe = await entry.pipe
          await pipe.send({ type: 'broadcast', event: 'broadcast', payload: createDeviceRpcRequestEnvelope(type, newRequestId(), userId, payload) })
        },
        close: (error = new DeviceRpcChannelError('requester closed', 'closed')) => drop(deviceId, entry, error),
      }
    },
    closeAll(error = new DeviceRpcChannelError('requester closed', 'closed')) {
      for (const [deviceId, entry] of [...entries]) drop(deviceId, entry, error)
    },
  }
}
