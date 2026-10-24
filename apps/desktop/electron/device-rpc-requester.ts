/**
 * 主进程这一侧开到别的机器的设备 RPC 管道(agent 的 session_* 跨机器,owner 2026-09-30 拍板)。请求与应答的配对是全 app
 * 共用的那一份(@gugu/core/cloud/deviceRpcRequester);这里只有两种管道:咕咕云私有频道,与远程 SSH 的设备连接 ——
 * 后者用窗口那一个 link manager(server/ssh-link-ipc.ts),❌ 另开一份(那会对同一台机器起第二个 `gugu-server link`)。
 */
import { openAttachedDeviceRpcPipe, type DeviceTopic, type JoinDeviceTopic } from '@gugu/core/cloud/deviceRpcAttach'
import { isSubscribeFailure, subscribeStatusName } from '@gugu/core/cloud/deviceRpcProtocol'
import {
  DeviceRpcChannelError,
  type DeviceRpcPipe,
  type DeviceRpcPipeHandlers,
} from '@gugu/core/cloud/deviceRpcRequester'
import {
  subscribeAuthenticatedElectronRealtimeChannel,
  type ElectronManagedRealtimeChannel,
} from './realtime-channel'

/** 窗口那一个 link manager 里,主进程要用的那几样(ssh-link-ipc.ts 的返回值)。 */
export type SharedSshLinks = {
  open(deviceId: string): Promise<{ ok: true } | { ok: false; reason: string; detail: string }>
  send(deviceId: string, message: unknown): boolean
  /** 这台机器的连接上收到的、断了的,也告诉这一位;返回取消。 */
  tap(deviceId: string, handlers: { onMessage(message: unknown): void; onClosed(reason: string): void }): () => void
}

/**
 * 远程 SSH 那条:借窗口那条连接。管道关 = 不再听,❌ 关连接 —— 连接归 link manager(窗口在用、机器被移除、退出时才关)。
 */
export async function openSshDeviceRpcPipe(links: SharedSshLinks, deviceId: string, handlers: DeviceRpcPipeHandlers): Promise<DeviceRpcPipe> {
  const pipe = attachSshDeviceRpcPipe(links, deviceId, handlers)
  try {
    const opened = await links.open(deviceId)
    if (!opened.ok) throw new DeviceRpcChannelError(`ssh link: ${opened.reason} (${opened.detail})`, opened.reason)
    return pipe
  } catch (error) { pipe.close(); throw error }
}

/** File reads may only borrow a link that is already held; this never opens a connection. */
export function attachSshDeviceRpcPipe(links: Pick<SharedSshLinks, 'tap' | 'send'>, deviceId: string, handlers: DeviceRpcPipeHandlers): DeviceRpcPipe {
  const untap = links.tap(deviceId, {
    onMessage: (message) => handlers.onMessage(message),
    onClosed: (reason) => handlers.onClosed(new DeviceRpcChannelError(`device channel closed: ${reason}`, 'closed')),
  })
  return {
    send: async (message) => {
      if (!links.send(deviceId, message)) throw new DeviceRpcChannelError('ssh link is not open', 'closed')
    },
    close: untap,
  }
}

type RealtimeClient<TChannel> = {
  realtime: { setAuth: () => unknown | Promise<unknown> }
  channel: (topic: string, options: { config: { private: boolean; broadcast: { self: boolean; ack: boolean } } }) => TChannel
  removeChannel: (channel: TChannel) => unknown
}

type BroadcastChannel = ElectronManagedRealtimeChannel & {
  on: (kind: 'broadcast', filter: { event: string }, callback: (payload: unknown) => void) => BroadcastChannel
  send: (message: unknown) => Promise<unknown>
}

export const CLOUD_PIPE_SUBSCRIBE_TIMEOUT_MS = 10_000

/** 主进程这一个请求方的发问端 id(#7233):整个进程一个,报到后它的请求、回包都走 `gugu:<dev>:rpc:<asker>`。 */
const MAIN_PROCESS_ASKER = globalThis.crypto.randomUUID().replace(/-/g, '')

/** 订上一条私有 topic(RLS 只对本账号开);`self:false`,自己发的不回给自己。订上之后再断 = 管道作废,下一问重开。 */
function joinElectronTopic<TChannel>(supabase: RealtimeClient<TChannel>, subscribeTimeoutMs: number): JoinDeviceTopic {
  return (topic, handlers) => new Promise<DeviceTopic>((resolve, reject) => {
    const channel = supabase.channel(topic, {
      config: { private: true, broadcast: { self: false, ack: true } },
    }) as unknown as BroadcastChannel
    channel.on('broadcast', { event: 'broadcast' }, (payload) => handlers.onMessage(payload))
    let subscribing: Promise<() => Promise<void>> | null = null
    let left: Promise<void> | null = null
    let closed = false
    let subscribed = false
    /** 交回的 promise 在这条退完时落定(同名的再订要等它,见 deviceRpcAttach)。 */
    const close = (): Promise<void> => {
      closed = true
      if (!subscribing) return Promise.resolve() // 还没交出去:交出来时(下面)当场退
      return (left ??= subscribing.then((unsubscribe) => unsubscribe(), () => undefined))
    }
    const fail = (error: unknown) => {
      clearTimeout(timer)
      void close()
      reject(error)
    }
    const timer = setTimeout(
      () => fail(new DeviceRpcChannelError(`could not subscribe to ${topic}`, 'unreachable')),
      subscribeTimeoutMs,
    )
    subscribing = subscribeAuthenticatedElectronRealtimeChannel({
      realtime: supabase.realtime,
      removeChannel: (removed) => supabase.removeChannel(removed as TChannel),
    }, channel, {
      label: `device-rpc-request:${topic}`,
      onStatus: (status, err) => {
        const name = subscribeStatusName(status)
        if (name === 'SUBSCRIBED' || name.endsWith('.SUBSCRIBED')) {
          if (subscribed) return handlers.onRejoined()
          subscribed = true
          clearTimeout(timer)
          resolve({ send: async (message) => { await channel.send(message) }, close })
          return
        }
        if (!isSubscribeFailure(status)) return
        if (!subscribed) fail(new DeviceRpcChannelError(`device channel subscribe failed: ${name}${err ? ` ${err.message}` : ''}`, 'unreachable'))
        else handlers.onClosed(new DeviceRpcChannelError(`device channel closed: ${name}`, 'closed'))
      },
    })
    if (closed) void close()
    void subscribing.then(() => undefined, fail)
  })
}

/**
 * 咕咕云那条(#7233 协议 9):订上那台机器的共用 topic,第一问时报到,之后在自己那条上问(deviceRpcAttach)。
 * 主进程的频道那层没有 #840 的看门狗,这里开 `watchdog`:两条中任何一条 2 分钟没收到任何东西(宿主每 60 s 一条 alive)
 * ⇒ 两条一起重来、重新报到。
 */
export function openCloudDeviceRpcPipe<TChannel>(input: {
  supabase: RealtimeClient<TChannel>
  deviceId: string
  userId: () => Promise<string>
  subscribeTimeoutMs?: number
} & DeviceRpcPipeHandlers): Promise<DeviceRpcPipe> {
  return openAttachedDeviceRpcPipe({
    deviceId: input.deviceId,
    asker: MAIN_PROCESS_ASKER,
    userId: input.userId,
    join: joinElectronTopic(input.supabase, input.subscribeTimeoutMs ?? CLOUD_PIPE_SUBSCRIBE_TIMEOUT_MS),
    onMessage: input.onMessage,
    onClosed: input.onClosed,
    watchdog: {},
  })
}
