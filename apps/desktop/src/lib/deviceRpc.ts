import { dataClient, getCurrentAuthUserId } from './supabase'
import { observeRealtimeAuth } from './realtimeSessionManager'
import {
  subscribeAuthenticatedRealtimeChannel,
  unsubscribeAuthenticatedRealtimeChannel,
  type ManagedRealtimeChannel,
} from './realtimeChannel'
import {
  isSubscribeFailure,
  parseDeviceRpcRequest,
  subscribeStatusName,
  type DeviceRpcResponse,
} from '@gugu/core/cloud/deviceRpcProtocol'
import { openAttachedDeviceRpcPipe, type DeviceTopic, type JoinDeviceTopic } from '@gugu/core/cloud/deviceRpcAttach'
import {
  createDeviceRpcRequester,
  DeviceRpcTimeoutError,
  type DeviceRpcPipe,
  type DeviceRpcPipeHandlers,
} from '@gugu/core/cloud/deviceRpcRequester'
import {
  onSshMachineSignedIn,
  openSshLink,
  refreshSshMachines,
  sshMachinesReady,
  subscribeSshMachineIds,
  subscribeTunnelState,
  tunnelSettled,
  usesDeviceLink,
} from './sshLinkChannel'
import { SshLinkError } from './sshLink'

export type { DeviceRpcError, DeviceRpcResponse } from '@gugu/core/cloud/deviceRpcProtocol'

/**
 * #6264 一台机器一条「频道」,两种通道(product spec「两种连法，处处能用」):
 *  · 这台桌面用远程 SSH 添加的机器(有它的 SSH 映射)→ 设备连接(sshLinkChannel.ts),字节只走 SSH,❌ 退回咕咕云;
 *  · 其余(远程隧道、别的桌面、别的电脑用远程 SSH 添加的)→ 咕咕云 Realtime 私有频道。
 * 请求与应答的配对是全 app 共用的那一份(@gugu/core/cloud/deviceRpcRequester,主进程也用它);这里只管两种管道怎么开、
 * 断了怎么重开,以及设备推来的事件交给谁。
 */

// @@@device-rpc-events 设备 → 手机的**推送**(taskhost.frame、消息预览这类)不是请求应答:没有 request_id。监听器登记在
// 管道**之外**,因为管道会被重建(登录切换、订阅失败重连),挂在管道上的监听器会跟着蒸发,而订阅者手里那个取消函数还在 ——
// 那正是「订了但再也收不到」的形状。
const eventListeners = new Map<string, Set<(payload: unknown) => void>>()
const resubscribeListeners = new Map<string, Set<(rejoin: boolean) => void>>()

function listenersFor<T>(registry: Map<string, Set<T>>, deviceId: string): Set<T> {
  let set = registry.get(deviceId)
  if (!set) {
    set = new Set<T>()
    registry.set(deviceId, set)
  }
  return set
}

const hasEventListeners = (deviceId: string) => (eventListeners.get(deviceId)?.size ?? 0) > 0

function dispatchDeviceEvent(deviceId: string, payload: unknown): void {
  for (const listener of [...(eventListeners.get(deviceId) ?? [])]) listener(payload)
}

/** `rejoin`:同一条管道断过又订上了(这期间发出的问可能已随断开的那段丢了);管道新开的那一次订阅不是。 */
function notifyResubscribed(deviceId: string, rejoin: boolean): void {
  for (const listener of [...(resubscribeListeners.get(deviceId) ?? [])]) listener(rejoin)
}

/** 此刻开着的管道走的是哪条通道(清单变了时据此拆掉走错的那条);管道关掉就删。 */
const transports = new Map<string, 'cloud' | 'ssh'>()
/** 交给共用请求方的那份回调 —— 测试钩子从这里把伪造的应答喂回同一条配对路径。 */
const pipeHandlers = new Map<string, DeviceRpcPipeHandlers>()

/**
 * 测试钩子总闸 —— 与 realtimeChannel.ts(#840)同一条守卫,同一个理由:
 * `import.meta.env.DEV` 在打包版里会被 Vite 静态剔除,所以再给一个显式的 opt-in,
 * 让 CDP / Playwright 也能在打包版上开。**默认关**,产品路径一行都不变。
 */
const TEST_HOOKS_ENABLED = (() => {
  if (import.meta.env.DEV) return true
  try {
    return localStorage.getItem('__gugu_test_hooks') === '1'
  } catch {
    return false
  }
})()

/**
 * 假的「设备应答器」:装上之后请求不再真的广播出去,而是交给它,由它自己回一条 reply
 * (走 `__guguInjectDeviceRpcReply`)。宿主侧还没落地时,手机端要能独立开发与验收。
 *
 * ⚠️ 它**只**替掉「把请求送出去」这一步:频道仍然是真的 Realtime 私有频道(真订阅、真 RLS),
 * reply 也仍然走真的配对路径 —— 被替掉的那一段之外全是产品代码。
 */
type DeviceRpcTestResponder = (request: {
  deviceId: string
  type: string
  requestId: string
  payload: unknown
}) => void

function testResponder(): DeviceRpcTestResponder | null {
  if (!TEST_HOOKS_ENABLED) return null
  const candidate = (globalThis as Record<string, unknown>).__guguDeviceRpcResponder
  return typeof candidate === 'function' ? (candidate as DeviceRpcTestResponder) : null
}

const requester = createDeviceRpcRequester({
  userId: getCurrentAuthUserId,
  openPipe,
  onEvent: dispatchDeviceEvent,
  // 设备连接(远程 SSH)不因为一次超时就拆:它的死活由 ssh 自己的心跳判(断了会报 closed);首次连一台机器可能要几秒
  // 握手,拆了重来只会一直在握手。事件订阅者还在时也不拆:拆了它就再也收不到推送,而它没有「请求超时」这种自愈路径。
  keepAliveOnTimeout: (deviceId) => transports.get(deviceId) !== 'cloud' || hasEventListeners(deviceId),
})

/** 开管道前最多等远程隧道多久。上限:调用的缺省期限(5 s,含开管道)。 */
const TUNNEL_SETTLE_MAX_MS = 3_000

async function openPipe(deviceId: string, handlers: DeviceRpcPipeHandlers): Promise<DeviceRpcPipe> {
  await sshMachinesReady()
  // 隧道正在连(开机、那台刚上线):等它出结果再挑,❌ 先开在咕咕云上、通了再换 —— 换的那一下在途的调用全被拒。
  await tunnelSettled(deviceId, TUNNEL_SETTLE_MAX_MS)
  // 远程 SSH 的机器,以及经远程隧道连通了的机器:走设备连接(终端画面不进咕咕云的消息通道)。
  const transport = usesDeviceLink(deviceId) ? 'ssh' : 'cloud'
  const pipe = await (transport === 'ssh' ? openSshPipe : openCloudPipe)(deviceId, handlers)
  transports.set(deviceId, transport)
  pipeHandlers.set(deviceId, handlers)
  return {
    send: pipe.send,
    // #7233 咕咕云那条:一问没回时重新报到、原样重发一次(远程 SSH 那条没有)。漏传它,一次报到卡住之后这一页再也问不出去。
    ...(pipe.recover ? { recover: pipe.recover } : {}),
    close: () => {
      if (pipeHandlers.get(deviceId) === handlers) {
        pipeHandlers.delete(deviceId)
        transports.delete(deviceId)
      }
      pipe.close()
    },
  }
}

/** Supabase Realtime 按 RLS 拒绝加入私有频道时的原话(realtime_channel.ex 的 :unauthorized)。 */
const FORBIDDEN_TOPIC = 'You do not have permissions to read from this Channel topic'

/** 这一页(这个渲染进程)的发问端 id(#7233):报到后它的请求、回包、窗口回帧都走 `gugu:<dev>:rpc:<asker>`。 */
const DEVICE_RPC_ASKER = globalThis.crypto.randomUUID().replace(/-/g, '')

/**
 * 订上一条私有 topic。连上过又断了(手机切去系统选择器再回来就会断)就重新挂起,等重连上:断着时发出去的问会退到 REST
 * 送到那台机器,可它的应答回来时这边还不在频道上,只能干等到超时(#6737)。重连上了 = onRejoined(两条一起重来,见
 * deviceRpcAttach)。频道那层的看门狗(realtimeChannel.ts,#840)照常管它:宿主每 60 s 在两条上各发一条 alive。
 */
const joinCloudTopic: JoinDeviceTopic = (topic, handlers) => new Promise<DeviceTopic>((resolve, reject) => {
  let channel: ManagedRealtimeChannel | null = null
  let alive = true
  let opened = false
  let joined: Promise<void> | null = null
  let markJoined: (() => void) | null = null
  /** 交回的 promise 在这条退完时落定:同名的再订要等它(deviceRpcAttach)。 */
  const close = (): Promise<void> => {
    alive = false
    const leaving = channel
    channel = null
    if (!leaving) return Promise.resolve()
    try {
      return unsubscribeAuthenticatedRealtimeChannel(leaving)
    } catch {
      return Promise.resolve()
    }
  }
  const handle: DeviceTopic = {
    send: async (message) => {
      if (joined) await joined
      if (!channel) throw new Error('Device RPC channel is not initialized')
      await channel.send(message as Parameters<ManagedRealtimeChannel['send']>[0])
    },
    close,
  }
  const createChannel = () => {
    channel = dataClient
      .channel(topic, { config: { private: true, broadcast: { self: false, ack: true } } })
      .on('broadcast', { event: '*' }, (payload) => handlers.onMessage(payload))
    return channel
  }
  channel = subscribeAuthenticatedRealtimeChannel(createChannel, `device-rpc:${topic.slice('gugu:'.length)}`, {
    shouldSubscribe: () => alive,
    onSubscribed: () => {
      markJoined?.()
      markJoined = null
      joined = null
      if (!opened) {
        opened = true
        resolve(handle)
        return
      }
      handlers.onRejoined()
    },
    onStatus: (status, err) => {
      if (!isSubscribeFailure(status)) return
      const name = subscribeStatusName(status)
      const error = err instanceof Error ? err : new Error(`Device RPC channel subscribe failed: ${name}`)
      if (!opened) {
        close()
        reject(error)
        return
      }
      if (!joined) joined = new Promise<void>((rejoined) => { markJoined = rejoined })
      // 库拒绝这个账号读这台设备的频道 = 设备已不在账号名下(被删 / 被同机新 id 替掉):重订只会拿到同一句拒绝。当场拆掉
      // (Realtime 那层见 shouldSubscribe 为假就不再重订),在途的问一并失败。推送订阅方靠自己的周期 call(会话页线的
      // 心跳、手机的订阅保活)重开频道,重开后照常收到 onChannelResubscribed。
      if (error.message.includes(FORBIDDEN_TOPIC)) handlers.onClosed(error)
    },
  })
})

async function openCloudPipe(deviceId: string, handlers: DeviceRpcPipeHandlers): Promise<DeviceRpcPipe> {
  const attached = await openAttachedDeviceRpcPipe({
    deviceId,
    asker: DEVICE_RPC_ASKER,
    userId: getCurrentAuthUserId,
    join: joinCloudTopic,
    onMessage: handlers.onMessage,
    onClosed: handlers.onClosed,
    // 断过又订上(两条一起重来、重新报到):订阅者拿手里的 cursor 补缺口,开着的窗口作废重开。
    onRejoined: () => notifyResubscribed(deviceId, true),
  })
  notifyResubscribed(deviceId, false)
  return {
    send: async (message) => {
      const responder = testResponder()
      if (responder) {
        const request = parseDeviceRpcRequest((message as { payload?: unknown }).payload)
        if (request) responder({ deviceId, type: request.type, requestId: request.request_id, payload: request.payload })
        return
      }
      await attached.send(message)
    },
    recover: () => attached.recover?.(),
    close: () => attached.close(),
  }
}

// ── 远程 SSH:设备连接 ────────────────────────────────────────────────────────

/** 断了之后多久再开一次(只在还有人听推送时):2s 起翻倍,最多一分钟。成本 = 一次 ssh 复用共享连接起一个进程。 */
const SSH_REOPEN_MIN_MS = 2_000
const SSH_REOPEN_MAX_MS = 60_000
const sshReopen = new Map<string, { timer: ReturnType<typeof setTimeout> | null; delay: number }>()

async function openSshPipe(deviceId: string, handlers: DeviceRpcPipeHandlers): Promise<DeviceRpcPipe> {
  // 连接在主进程那头已经断了:只丢掉这边的记录,❌ 再叫主进程关(可能关掉紧接着开的新连接)。
  let closedByLink = false
  const link = openSshLink(deviceId, {
    onMessage: (message) => handlers.onMessage(message),
    onClosed: (reason) => {
      closedByLink = true
      // 在途的问一律当场失败(说清原因),❌ 等到各自超时。
      handlers.onClosed(new SshLinkError(reason, deviceId))
      scheduleSshReopen(deviceId)
    },
  })
  try {
    await link.ready
  } catch (error) {
    link.close()
    throw error
  }
  sshReopen.delete(deviceId)
  // 与 Realtime 同一个信号:(重新)接上了,订阅者拿手里的 cursor 补缺口、重新订阅。新开的连接:旧连接上在途的问已当场失败。
  notifyResubscribed(deviceId, false)
  return {
    send: (message) => link.send(message),
    close: () => {
      if (!closedByLink) link.close()
    },
  }
}

/** 还有人在听这台机器的推送,就隔一会儿再开一条;没人听 = 下一次调用时再开。 */
function scheduleSshReopen(deviceId: string): void {
  if (!hasEventListeners(deviceId)) {
    sshReopen.delete(deviceId)
    return
  }
  const state = sshReopen.get(deviceId) ?? { timer: null, delay: SSH_REOPEN_MIN_MS / 2 }
  if (state.timer) return
  state.delay = Math.min(SSH_REOPEN_MAX_MS, state.delay * 2)
  state.timer = setTimeout(() => {
    state.timer = null
    if (!hasEventListeners(deviceId) || transports.has(deviceId)) return
    void requester.open(deviceId).catch(() => scheduleSshReopen(deviceId))
  }, state.delay)
  sshReopen.set(deviceId, state)
}

/**
 * 清单变了(装上了一台、移除了一台、换了账号):已经开着的管道若走错了通道,就拆掉 —— 下一次调用 / 推送订阅
 * 按新清单重开(有人在听推送的当场重开)。
 */
function reconcileTransports(): void {
  for (const [deviceId, transport] of [...transports]) {
    if ((usesDeviceLink(deviceId) ? 'ssh' : 'cloud') === transport) continue
    requester.close(deviceId, new Error('Device RPC channel was reset: this machine now uses another transport'))
    if (hasEventListeners(deviceId)) void requester.open(deviceId).catch(() => undefined)
  }
}

let transportsWatched = false
function watchTransports(): void {
  if (transportsWatched) return
  transportsWatched = true
  subscribeSshMachineIds(reconcileTransports)
  // 远程隧道连通 / 断了:同样换管道(断了退回咕咕云,聊天照常;通了换到设备连接)。
  subscribeTunnelState(reconcileTransports)
  // 人刚登上了一台:有人在听它的推送就当场重开(❌ 等退避计时);没人听 = 下一次调用时自然走新连接。
  onSshMachineSignedIn((deviceId) => {
    const state = sshReopen.get(deviceId)
    if (state?.timer) clearTimeout(state.timer)
    sshReopen.delete(deviceId)
    if (!hasEventListeners(deviceId) || transports.has(deviceId)) return
    void requester.open(deviceId).catch(() => scheduleSshReopen(deviceId))
  })
}

/**
 * Send an RPC over the device broadcast channel and await a
 * matching reply. Concurrent calls are demultiplexed by request_id.
 */
export async function callDeviceRpc<T>(
  deviceId: string,
  type: string,
  payload: unknown,
  options?: { timeoutMs?: number; signal?: AbortSignal; retryOnTimeout?: boolean },
): Promise<DeviceRpcResponse<T>> {
  if (!deviceId) throw new Error('deviceId is required')
  watchTransports()
  const timeoutMs = options?.timeoutMs ?? 5000
  const maxAttempts = options?.retryOnTimeout ? 2 : 1
  for (let attempt = 1; ; attempt += 1) {
    try {
      return (await requester.call(deviceId, type, payload, { timeoutMs, signal: options?.signal })) as DeviceRpcResponse<T>
    } catch (err) {
      if (!(err instanceof DeviceRpcTimeoutError) || attempt >= maxAttempts) throw err
    }
  }
}

/**
 * Tear down cached device RPC channels. This is part of the runtime recovery
 * path: auth changes and proven stale channels must not reuse old Realtime
 * subscriptions.
 */
function resetDeviceRpcChannels(deviceId?: string): void {
  const error = new Error('Device RPC channel was reset')
  if (deviceId) requester.close(deviceId, error)
  else requester.closeAll(error)
}

let lastAuthUserId: string | null = null

observeRealtimeAuth(({ event, session }) => {
  const nextUserId = session?.user.id ?? null
  if (event === 'SIGNED_OUT' || (event === 'SIGNED_IN' && nextUserId !== lastAuthUserId)) {
    resetDeviceRpcChannels()
    // 远程 SSH 的机器清单是按账号的:换了人就重取(新管道开之前先等它,见 openPipe)。
    void refreshSshMachines()
  }
  lastAuthUserId = nextUserId
})

export const _resetDeviceRpcForTesting = resetDeviceRpcChannels

/**
 * Test-only: simulate a broadcast reply on the open channel for a device.
 * No-op if no channel is open.
 */
export function _injectDeviceRpcReplyForTesting(deviceId: string, payload: unknown): void {
  pipeHandlers.get(deviceId)?.onMessage(payload)
}

/**
 * 订阅这台设备推来的广播事件(非请求应答)。
 *
 * 与 `callDeviceRpc` 共用同一条管道:同一个 deviceId 只有一条订阅,应答按 request_id 路由、其余交给这里的监听器。
 *
 * `onChannelResubscribed` 在每次订阅成功后触发(首次订阅也算,`rejoin` 为假)。断线重连后它是
 * 「补缺口」的唯一信号 —— 重连本身不补历史,订阅者要拿自己手里的 cursor 去 after 一次。
 */
export function subscribeDeviceRpcEvents(
  deviceId: string,
  listener: (payload: unknown) => void,
  options?: { onChannelResubscribed?: (rejoin: boolean) => void },
): () => void {
  if (!deviceId) throw new Error('deviceId is required')
  const events = listenersFor(eventListeners, deviceId)
  events.add(listener)
  const onResubscribed = options?.onChannelResubscribed
  if (onResubscribed) listenersFor(resubscribeListeners, deviceId).add(onResubscribed)
  // 管道要先存在才收得到推送。远程 SSH 的机器此刻连不上:隔一会儿再开(有人在听推送就不能就此放弃,Realtime 那条有
  // 自己的重连)。
  watchTransports()
  void requester.open(deviceId).catch(() => {
    if (usesDeviceLink(deviceId)) scheduleSshReopen(deviceId)
  })

  let released = false
  return () => {
    if (released) return
    released = true
    events.delete(listener)
    if (events.size === 0) eventListeners.delete(deviceId)
    if (onResubscribed) {
      const resubs = resubscribeListeners.get(deviceId)
      resubs?.delete(onResubscribed)
      if (resubs && resubs.size === 0) resubscribeListeners.delete(deviceId)
    }
  }
}

/**
 * Test-only: 把一条**推送事件**塞进这台设备的频道(与 `_injectDeviceRpcReplyForTesting` 同族)。
 * 频道没开着时是 no-op —— 与真实通路一致:没订阅就收不到。
 */
export function _injectDeviceRpcEventForTesting(deviceId: string, payload: unknown): void {
  if (!pipeHandlers.has(deviceId)) return
  dispatchDeviceEvent(deviceId, payload)
}

// @@@device-rpc-test-hooks 运行时守卫下的 window 暴露,让 Playwright/CDP 能从 page.evaluate 调到
// 上面那几个钩子(与 realtimeChannel.ts 的 #840 暴露块同形、同守卫)。应答器本身由测试脚本
// 挂在 `window.__guguDeviceRpcResponder` 上 —— 读的时候现取,所以 addInitScript 里先挂也生效。
if (TEST_HOOKS_ENABLED) {
  const globals = globalThis as Record<string, unknown>
  globals.__guguInjectDeviceRpcReply = _injectDeviceRpcReplyForTesting
  globals.__guguInjectDeviceRpcEvent = _injectDeviceRpcEventForTesting
  globals.__guguResetDeviceRpc = resetDeviceRpcChannels
}
