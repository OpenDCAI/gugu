/**
 * #7233 设备 RPC 在咕咕云上的「一个发问端一条线」(协议 9),发问端这一侧 —— 渲染层(手机 / 网页 / 桌面窗口,
 * src/lib/deviceRpc.ts)和主进程(agent 的 session_* 跨机器,electron/device-rpc-requester.ts)共用这一份。
 *
 * 一台机器两条 topic:
 * - 共用的 `gugu:<dev>:rpc`:一直订着。只在上面报到(`taskhost.attach`),听宿主起来(`taskhost.ready`)、活着(`taskhost.alive`)。
 * - 自己的 `gugu:<dev>:rpc:<asker>`:报到前先订上,宿主收到报到后也订上它、在它上面回报到。之后这一端的每一问都发在
 *   这条上,回包与窗口回帧也只回这条 —— 别的客户端不订它,一份都收不到(改前这台机器上每个开着的客户端各收一份:
 *   对照实测,一部手机往上翻取图的 7.77 MB 回包、传的 3 MB 附件,另一部手机和网页各收一整份)。
 *
 * 不在线上了就重新报到:宿主离开这条之前会在上面说一声 `taskhost.detached`(空闲关 / 让位给别的发问端),宿主重启会在共用
 * topic 上说 `taskhost.ready`;那一声丢了,一问超时 → 请求方调 `recover()` 重新报到、原样重发一次(deviceRpcRequester)。
 *
 * 两条线一个看门狗规则(#840:后端卡住时广播悄悄不投,socket 与它的心跳照旧活着,只有「该到的广播没到」说得出来):
 * 宿主每 60 s 在共用 topic 和每条它在的 asker topic 上各发一条 alive;任何一条 2 分钟没收到任何东西就算死。
 * 渲染层的频道那层自己有这个看门狗(realtimeChannel.ts 的 stale watchdog,判死就重订);主进程的频道没有,由这里的
 * `watchdog` 选项来做。
 *
 * 任何一条断过又订上(看门狗判死后重订、socket 断了又连上)都一样处理:整条管道作废(`rejoined`),请求方换一条新管道
 * —— 两条重新订、重新报到 —— 把在途的问原样重发一次(deviceRpcRequester;同一个 request_id,宿主去重)。断着那段推来的
 * 帧丢了,调用方的 onRejoined 让开着的窗口作废重开。
 */
import {
  createDeviceRpcRequestEnvelope,
  DEVICE_RPC_ALIVE,
  DEVICE_RPC_ATTACH,
  DEVICE_RPC_DETACHED,
  DEVICE_RPC_STALE_MS,
  deviceRpcAskerChannelName,
  deviceRpcChannelName,
  deviceRpcFrameType,
  deviceRpcReplyType,
  parseDeviceRpcReply,
} from './deviceRpcProtocol'
import { DeviceRpcChannelError, DeviceRpcRefused, type DeviceRpcPipe, type DeviceRpcPipeHandlers } from './deviceRpcRequester'
import { MIN_SERVER_PROTOCOL, REMOTE_PROTOCOL_VERSION } from './serverMachineHealth'

/** 订上一条私有 topic 之后手里的那一条:往上发,关掉(交回的 promise 在这条退完时落定)。 */
export type DeviceTopic = { send(message: unknown): Promise<void>; close(): void | Promise<void> }

export type DeviceTopicHandlers = {
  onMessage(payload: unknown): void
  /** 这条订上过、断了又重新订上了(频道那层的看门狗判死后重订也算):中间的帧可能丢了。 */
  onRejoined(): void
  /** 这条再也订不上了(被拒 —— 设备已不在账号名下):整条管道作废。 */
  onClosed(error: unknown): void
}

/** 订上一条 topic;订上了才 resolve,订不上就 reject。 */
export type JoinDeviceTopic = (topic: string, handlers: DeviceTopicHandlers) => Promise<DeviceTopic>

export type AttachedDeviceRpcPipeOptions = DeviceRpcPipeHandlers & {
  deviceId: string
  /** 这个发问端的 id:一个请求方实例一个,整段生命里不变(❌ 用会话页窗口的 client —— 它每开一次窗口都换)。 */
  asker: string
  userId: () => Promise<string>
  join: JoinDeviceTopic
  /** 报到那一问多久没回算失败(含订上自己那条)。 */
  attachTimeoutMs?: number
  newRequestId?: () => string
  /** 断过又订上了(管道随即作废、换新的):调用方据此作废开着的窗口 —— 断着那段推给它们的帧丢了。 */
  onRejoined?: () => void
  /** 频道那层没有看门狗时(主进程)由这里判:两条中任何一条 `staleMs` 没收到任何东西 ⇒ 管道作废,换新的。 */
  watchdog?: { staleMs?: number; checkEveryMs?: number; now?: () => number }
}

export const DEVICE_RPC_ATTACH_TIMEOUT_MS = 12_000

/**
 * 同名的 topic 退完再订。realtime-js(2.103)的 channel(topic) 在同名那条还没退完(phx_leave 的应答还没回)时把它交回来:
 * 订在一条正在退的频道上等不到 SUBSCRIBED,它退完还把新的这次一起带走。宿主重启那一声 ready 一来自己那条当场退、
 * 下一问当场又订,正撞上(10-16 mac1:手机此后一句都没问出去)。一个进程一份 —— 同一个进程里的管道共用一个 realtime 连接。
 */
const leavingTopics = new Map<string, Promise<void>>()

function leaveTopic(name: string, topic: DeviceTopic): void {
  let closing: unknown
  try {
    closing = topic.close()
  } catch {
    closing = undefined
  }
  const done: Promise<void> = Promise.all([leavingTopics.get(name), Promise.resolve(closing).catch(() => undefined)]).then(() => {
    if (leavingTopics.get(name) === done) leavingTopics.delete(name)
  })
  leavingTopics.set(name, done)
}

/**
 * 订上共用 topic 之后 resolve;报到在第一次发问时做。
 * 管道属于开它的那个账号:先认出是谁、再订(私有 topic 按账号放行,报到也报这个人)。没登录 ⇒ 账号那层的错原样抛出,
 * ❌ 先去订、被服务端拒成「连不上」。换了账号,旧账号的 topic 会被拒、整条作废,请求方按新账号重开。
 */
export async function openAttachedDeviceRpcPipe(options: AttachedDeviceRpcPipeOptions): Promise<DeviceRpcPipe> {
  const owner = await options.userId()
  const { deviceId, asker } = options
  const sharedName = deviceRpcChannelName(deviceId)
  const askerName = deviceRpcAskerChannelName(deviceId, asker)
  const attachTimeoutMs = options.attachTimeoutMs ?? DEVICE_RPC_ATTACH_TIMEOUT_MS
  const newRequestId = options.newRequestId ?? (() => globalThis.crypto.randomUUID())
  const now = options.watchdog?.now ?? (() => Date.now())

  let closed = false
  let shared: Promise<DeviceTopic> | null = null
  let watchdogTimer: ReturnType<typeof setInterval> | null = null
  let mine: Promise<DeviceTopic> | null = null
  let attached: Promise<void> | null = null
  /** 正在等的那一声报到应答:共用 topic 上(旧机器回 unknown_method)和自己那条上(新机器)都认。 */
  let attachWaiter: { requestId: string; settle(reply: ReturnType<typeof parseDeviceRpcReply>): void } | null = null
  const heard = { shared: now(), mine: now() }
  /** 已经订上的 topic(→ 名字):管道作废时当场关(❌ 等它的 promise 下一拍):断过又订上的那一刻,等着「订上」的那一问不能再从旧线发出去。 */
  const opened = new Map<DeviceTopic, string>()
  const joinedBy = new WeakMap<Promise<DeviceTopic>, DeviceTopic>()
  const track = (name: string, joining: Promise<DeviceTopic>): Promise<DeviceTopic> => {
    void joining.then((topic) => {
      joinedBy.set(joining, topic)
      if (closed) leaveTopic(name, topic)
      else opened.set(topic, name)
    }, () => undefined)
    return joining
  }
  /** 订:同名那条还在退就等它退完(见 leavingTopics)。 */
  const join = async (name: string, handlers: DeviceTopicHandlers): Promise<DeviceTopic> => {
    await leavingTopics.get(name)
    if (closed) throw new DeviceRpcChannelError('device channel closed', 'closed')
    return options.join(name, handlers)
  }

  const fail = (error: unknown) => {
    if (closed) return
    close()
    options.onClosed(error)
  }

  /** 宿主不在自己那条上了(或说不准):下一问之前重新报到。自己那条一并离开 —— 它只在报到着时开着(看门狗才有 alive 可等)。 */
  const detach = () => {
    attached = null
    const joining = mine
    mine = null
    if (!joining) return
    // 已经订上的当场退、当场记下「在退」(紧接着的下一问要等它退完再订);还在订的,订上了再退。
    const leave = (topic: DeviceTopic) => {
      if (opened.delete(topic)) leaveTopic(askerName, topic)
    }
    const topic = joinedBy.get(joining)
    if (topic) leave(topic)
    else void joining.then(leave, () => undefined)
  }

  /** 断过又订上 / 看门狗判死:整条作废,请求方换新管道、重发在途的问(见文件头)。 */
  const rejoined = (why: string) => {
    if (closed) return
    fail(new DeviceRpcChannelError(why, 'rejoined'))
    options.onRejoined?.()
  }

  const takeAttachReply = (payload: unknown): boolean => {
    if (!attachWaiter) return false
    const reply = parseDeviceRpcReply(payload)
    if (!reply || reply.requestId !== attachWaiter.requestId || reply.type !== deviceRpcReplyType(DEVICE_RPC_ATTACH)) return false
    attachWaiter.settle(reply)
    return true
  }

  const joinShared = (): Promise<DeviceTopic> =>
    join(sharedName, {
      onMessage: (payload) => {
        if (closed) return
        heard.shared = now()
        if (takeAttachReply(payload)) return
        const type = deviceRpcFrameType(payload)
        if (type === DEVICE_RPC_ALIVE) return
        // 宿主刚起来:它手里没有任何发问端了。帧照样交出去(会话页窗口据此重开)。
        if (type === 'taskhost.ready') detach()
        options.onMessage(payload)
      },
      onRejoined: () => rejoined(`${sharedName} rejoined`),
      onClosed: fail,
    })

  const joinMine = (): Promise<DeviceTopic> =>
    join(askerName, {
      onMessage: (payload) => {
        if (closed) return
        heard.mine = now()
        if (takeAttachReply(payload)) return
        const type = deviceRpcFrameType(payload)
        if (type === DEVICE_RPC_ALIVE) return
        if (type === DEVICE_RPC_DETACHED) {
          detach()
          return
        }
        options.onMessage(payload)
      },
      onRejoined: () => rejoined(`${askerName} rejoined`),
      onClosed: fail,
    })

  const attach = (): Promise<void> => {
    attached ??= new Promise<void>((resolve, reject) => {
      // 期限从这一刻算,订上自己那条也在里面:那一步卡住也要到期失败、下一问重来,❌ 无期限地等(一问超时前什么都发不出去)。
      let requestId: string | null = null
      let expired = false
      const timer = setTimeout(() => {
        expired = true
        if (requestId && attachWaiter?.requestId === requestId) attachWaiter = null
        reject(new DeviceRpcChannelError(requestId
          ? `no answer to ${DEVICE_RPC_ATTACH} on ${sharedName} within ${attachTimeoutMs} ms`
          : `could not join ${askerName} within ${attachTimeoutMs} ms`, 'unreachable'))
      }, attachTimeoutMs)
      void (async () => {
        mine ??= track(askerName, joinMine())
        await mine
        // 到期了才订上:这次报到已经算失败(自己那条在订上后离开),❌ 再报到一次
        if (expired) return
        heard.mine = now()
        const id = newRequestId()
        requestId = id
        const reply = await new Promise<ReturnType<typeof parseDeviceRpcReply>>((settle, failSend) => {
          attachWaiter = {
            requestId: id,
            settle: (value) => {
              attachWaiter = null
              settle(value)
            },
          }
          void Promise.resolve(shared)
            .then((s) => s!.send({
              type: 'broadcast',
              event: 'broadcast',
              payload: createDeviceRpcRequestEnvelope(DEVICE_RPC_ATTACH, id, owner, { asker, protocol: REMOTE_PROTOCOL_VERSION }),
            }))
            .catch(failSend)
        })
        if (reply?.error) throw new DeviceRpcRefused(reply.error)
        const protocol = (reply?.result as { protocol?: unknown } | undefined)?.protocol
        if (typeof protocol !== 'number' || protocol < MIN_SERVER_PROTOCOL) {
          throw new DeviceRpcRefused({ code: 'server_outdated', message: '请更新那台机器上的咕咕' })
        }
      })().then(
        () => {
          clearTimeout(timer)
          resolve()
        },
        (error: unknown) => {
          clearTimeout(timer)
          if (requestId && attachWaiter?.requestId === requestId) attachWaiter = null
          reject(error)
        },
      )
    })
    const attempt = attached
    // 报到没成:下一问再试(❌ 卡在一个失败了的 promise 上)。自己那条一并离开。
    attempt.catch(() => {
      if (attached === attempt) detach()
    })
    return attempt
  }

  shared = track(sharedName, joinShared())
  await shared

  if (options.watchdog) {
    const staleMs = options.watchdog.staleMs ?? DEVICE_RPC_STALE_MS
    watchdogTimer = setInterval(() => {
      if (closed) return
      const t = now()
      // 自己那条只在报到着时才等 alive(宿主只在它在的那条上发)。
      if (t - heard.shared >= staleMs) rejoined(`nothing on ${sharedName} for ${staleMs} ms`)
      else if (attached && mine && t - heard.mine >= staleMs) rejoined(`nothing on ${askerName} for ${staleMs} ms`)
    }, options.watchdog.checkEveryMs ?? 30_000)
  }

  function close() {
    closed = true
    if (watchdogTimer) clearInterval(watchdogTimer)
    attachWaiter = null
    mine = null
    attached = null
    for (const [topic, name] of opened) leaveTopic(name, topic)
    opened.clear()
  }

  return {
    send: async (message) => {
      // 报到成了、还没发出去时宿主又说了 detached(让位 / 空闲):再报到一次再发。
      for (let attempt = 0; attempt < 2; attempt++) {
        if (closed) throw new DeviceRpcChannelError('device channel closed', 'closed')
        await attach()
        const topic = mine
        if (topic) return (await topic).send(message)
      }
      throw new DeviceRpcChannelError('detached twice while sending', 'closed')
    },
    recover: () => detach(),
    close,
  }
}
