/**
 * #7199 手机当设备 —— 让云端的助理找得到、调得动这台手机:
 *  ① 登记:把自己写进设备行(gugu_devices,host_kind = phone),动作清单随行(capabilities.actions);
 *  ② 心跳:每 30 秒一次 —— 库那边 2 分钟没心跳就判离线,调用方据此当场说「手机上的咕咕没开」,❌ 假装发出去;
 *  ③ 收调用:订这台手机自己的设备 RPC 频道(gugu:{device_id}:rpc,私有,库按设备归属放行),请执行交给 core 的设备动作 host(与桌面同一份收发规矩)。
 *
 * 只在咕咕开着(含「后台守着」)时活着 —— 第一版不接推送(owner 2026-10-15)。被划掉之后心跳停,2 分钟后判离线。
 * 先登记再订频道:频道的放行看「这台设备在不在这个账号名下」,行还没有就会被拒。
 */
import { useSyncExternalStore } from 'react'
import {
  deviceRpcChannelName,
  isSubscribeFailure,
  subscribeStatusName,
} from '@gugu/core/cloud/deviceRpcProtocol'
import { dataClient, identityDb } from '../../lib/supabase'
import { chatService } from '../../lib/chat'
import {
  subscribeAuthenticatedRealtimeChannel,
  unsubscribeAuthenticatedRealtimeChannel,
  type ManagedRealtimeChannel,
} from '../../lib/realtimeChannel'
import { rendererLogger } from '../../lib/log'
import { platform } from '../../platform'
import {
  type DeviceActionsCapability,
} from '@gugu/core/shared/deviceActions'
import {
  type DeviceActionCallRecord,
} from '@gugu/core/cloud/deviceActionHost'
import {
  buildPhoneActionsCapability,
  capabilityFingerprint,
  phoneActionByName,
  type PhoneOsState,
} from './phoneActionCatalog'
import { createPhoneActionProvider, mergeCallRecord } from './phoneActionProvider'
import { nativePhoneActions, type NativeHealthStatus, type PhoneDeviceInfo } from './nativePhoneActions'
import { createPhoneDeviceRpcHost } from './phoneDeviceRpcHost'
import type { JoinDeviceTopic } from '@gugu/core/cloud/deviceRpcAttach'
import { readPhoneDataStatus } from './phoneDataActions'
import { phoneDeviceRow } from './phoneDeviceRow'
import {
  effectiveGrants,
  groupGranted,
  phoneDeviceId,
  phoneInstallId,
  readPhoneDeviceSettings,
  subscribePhoneDeviceSettings,
} from './phoneDeviceSettings'

const log = rendererLogger('mobile/phone-device')

/** 心跳间隔。库那边 2 分钟没心跳判离线(gugu_devices 的离线清扫),30 秒留足三次失手的余量。 */
export const PHONE_HEARTBEAT_MS = 30_000

export type PhoneDeviceLink =
  | { state: 'off' }
  | { state: 'connecting' }
  | { state: 'online'; since: number }
  | { state: 'error'; message: string; at: number }

/** 「最近调用」的一条:host 记下的那份 + 动作的中文名。 */
export interface PhoneActionCall extends DeviceActionCallRecord {
  title: string
}

export const RECENT_CALLS_LIMIT = 30

export interface PhoneDeviceSnapshot {
  link: PhoneDeviceLink
  /** 系统此刻给了什么;还没读到 = null。 */
  os: PhoneOsState | null
  info: PhoneDeviceInfo | null
  deviceId: string | null
  /** 最近一次心跳成功的时刻。 */
  lastHeartbeatAt: number | null
  recent: readonly PhoneActionCall[]
}

const OFF: PhoneDeviceSnapshot = { link: { state: 'off' }, os: null, info: null, deviceId: null, lastHeartbeatAt: null, recent: [] }
let snapshot: PhoneDeviceSnapshot = OFF
const listeners = new Set<() => void>()

function publish(next: Partial<PhoneDeviceSnapshot>): void {
  snapshot = { ...snapshot, ...next }
  for (const listener of [...listeners]) listener()
}

export function subscribePhoneDevice(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePhoneDevice(): PhoneDeviceSnapshot {
  return useSyncExternalStore(subscribePhoneDevice, () => snapshot, () => OFF)
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** 系统此刻给了什么。设置页「去授权」回来、App 回到前台、每次心跳前都重读。 */
export async function readPhoneOsState(): Promise<PhoneOsState> {
  const [runtime, special, health, data] = await Promise.all([nativePhoneActions.checkPermissions(), nativePhoneActions.specialStatus(), readHealthStatus(), readPhoneDataStatus()])
  return { runtime, special, health, data }
}

/** 网页比安装包新时,原生还没有 healthStatus:如实标成「这个版本读不了」(old_app),❌ 让整份系统状态读失败。 */
async function readHealthStatus(): Promise<NativeHealthStatus> {
  try {
    return await nativePhoneActions.healthStatus()
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    if (code === 'UNIMPLEMENTED' || /not implemented|No method \w+ found/i.test(String((error as { message?: unknown } | null)?.message ?? ''))) {
      return { supported: false, granted_types: [], background_supported: false, background_granted: false, old_app: true }
    }
    throw error
  }
}

interface Session {
  stop: () => void
  /** 停下之后:等还在路上的那一拍心跳落地(断开时先等它,再删设备行 —— ❌ 删完又被它写回来)。 */
  drain: () => Promise<void>
  /** 授权或系统权限变了:重读、重新登记(不等下一拍心跳)。 */
  refresh: () => Promise<void>
}

let session: Session | null = null

/**
 * 开始当设备(总开关开着、登录着时由 PhoneDeviceRoot 调)。同一时刻只有一份;再调一次先停旧的。
 * `noticeLabel`:常驻通知上那句话 —— 正在被调用时说调的是什么,其余时候说「助理可以用这台手机」。
 */
export function startPhoneDevice(options: {
  userId: string
  noticeLabel: (running: readonly PhoneActionCall[]) => string
  claimNotice: (label: string) => () => void
}): () => void {
  session?.stop()
  const { userId } = options
  let alive = true
  let deviceId: string | null = null
  let installId: string | null = null
  let info: PhoneDeviceInfo | null = null
  let os: PhoneOsState | null = null
  let capability: DeviceActionsCapability | null = null
  let channel: ManagedRealtimeChannel | null = null
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let releaseNotice: (() => void) | null = null
  let noticeText: string | null = null
  let beating: Promise<void> | null = null
  let joined = false
  let collecting = false

  let recent: PhoneActionCall[] = []

  const updateNotice = () => {
    // 停了之后(在途的调用这时才结束)❌ 再把常驻通知挂回来:stop 已经放手,再挂上就没人收了。
    if (!alive) return
    const label = options.noticeLabel(recent.filter((call) => !call.finishedAt))
    if (label === noticeText) return
    const previous = releaseNotice
    noticeText = label
    releaseNotice = options.claimNotice(label)
    previous?.()
  }

  const provider = createPhoneActionProvider({
    action: phoneActionByName,
    granted: (group) => alive && groupGranted(readPhoneDeviceSettings(userId), group),
    os: () => os,
    manifest: () => capability?.actions ?? [],
    record: (entry) => {
      if (!alive) return
      const title = phoneActionByName(entry.action)?.title ?? entry.action
      recent = mergeCallRecord(recent, { ...entry, title }, RECENT_CALLS_LIMIT)
      publish({ recent })
      updateNotice()
    },
  })

  let rpcHost: ReturnType<typeof createPhoneDeviceRpcHost> | null = null
  const join: JoinDeviceTopic = (name, handlers) => new Promise((resolve, reject) => {
    let topic: ManagedRealtimeChannel | null = null
    let joined = false
    const timer = setTimeout(() => { reject(new Error('手机设备频道订阅超时')); if (topic) unsubscribeAuthenticatedRealtimeChannel(topic) }, 12_000)
    const create = () => dataClient.channel(name, { config: { private: true, broadcast: { self: false, ack: true } } })
      .on('broadcast', { event: '*' }, handlers.onMessage)
    topic = subscribeAuthenticatedRealtimeChannel(create, `phone-device-asker:${name}`, {
      shouldSubscribe: () => alive,
      reconnectWhenIdle: false,
      onSubscribed: () => {
        clearTimeout(timer)
        if (joined) { handlers.onRejoined(); return }
        joined = true
        resolve({ send: async (message) => { await topic!.send(message as Parameters<ManagedRealtimeChannel['send']>[0]) }, close: async () => { if (topic) await unsubscribeAuthenticatedRealtimeChannel(topic) } })
      },
      onStatus: (status, err) => {
        if (!isSubscribeFailure(status)) return
        const error = err ?? new Error(`手机设备频道断开:${subscribeStatusName(status)}`)
        if (!joined) {
          clearTimeout(timer)
          reject(error)
          if (topic) void unsubscribeAuthenticatedRealtimeChannel(topic).catch((error: unknown) => log.warn({ error: errorText(error) }, 'failed phone topic cleanup'))
        }
        else handlers.onClosed(error)
      },
    })
  })

  const rebuildCapability = () => {
    if (!os) return false
    const next = buildPhoneActionsCapability(effectiveGrants(readPhoneDeviceSettings(userId)), os)
    if (capability && capabilityFingerprint(capability) === capabilityFingerprint(next)) return false
    capability = next
    return true
  }

  const heartbeat = async (): Promise<void> => {
    if (!alive || !deviceId || !installId || !info) return
    try {
      os = await readPhoneOsState()
      publish({ os })
    } catch (error) {
      log.warn({ error: errorText(error) }, 'phone os state unreadable')
    }
    // 读系统那一下要等原生:这期间断开了(总开关关掉 / 退出登录)⇒ 这一拍不写,❌ 把刚删掉的设备行又写回来。
    if (!alive) return
    rebuildCapability()
    if (!capability) return
    const row = phoneDeviceRow({ deviceId, userId, installId, info, actions: capability, nowIso: new Date().toISOString() })
    const { error } = await identityDb.from('gugu_devices').upsert(row as never, { onConflict: 'device_id' })
    if (!alive) return
    if (error) {
      log.warn({ error: error.message }, 'phone device heartbeat failed')
      publish({ link: { state: 'error', message: error.message, at: Date.now() } })
      throw new Error(error.message)
    }
    publish({ lastHeartbeatAt: Date.now() })
    rpcHost?.beat()
    // 上一拍失败亮过「没连上」,这一拍写进去了、频道也在 ⇒ 回到已连接。
    if (joined && snapshot.link.state === 'error') publish({ link: { state: 'online', since: Date.now() } })
  }

  // 原生那边只在「通知与勿扰」连着时记新通知;断开 / 停下当场清空(behavior:手机上的数据只在被调用时读)。
  const syncCollecting = () => {
    const on = alive && groupGranted(readPhoneDeviceSettings(userId), 'notifications')
    if (on === collecting) return
    collecting = on
    void nativePhoneActions.setNotificationCollecting({ on }).catch((error: unknown) => log.warn({ error: errorText(error) }, 'notification collecting not switched'))
  }

  const beat = (): Promise<void> => {
    // 一次只跑一拍:上一拍还在路上(弱网)时,这一拍并进去,❌ 两个 upsert 赛跑。
    beating ??= heartbeat().finally(() => { beating = null })
    return beating
  }

  const subscribe = () => {
    if (!deviceId) return
    const id = deviceId
    const createChannel = () => {
      channel = dataClient
        .channel(deviceRpcChannelName(id), { config: { private: true, broadcast: { self: false, ack: true } } })
        .on('broadcast', { event: '*' }, (message) => {
          void rpcHost?.onShared(message).catch((error: unknown) => log.warn({ error: errorText(error) }, 'phone device request failed'))
        })
      return channel
    }
    channel = subscribeAuthenticatedRealtimeChannel(createChannel, `phone-device:${id}`, {
      shouldSubscribe: () => alive,
      // 这条频道只在被调用时才有消息:❌ 空闲 2 分钟就判它停滞、退订重订(每次重订有一两秒收不到请求,还白耗手机电)。
      // 连接真断了由 Realtime 自己的心跳重连;漏掉的请求调用方 10 秒后会再发一次。
      reconnectWhenIdle: false,
      onSubscribed: () => {
        joined = true
        void channel?.send({ type: 'broadcast', event: 'broadcast', payload: { type: 'taskhost.ready' } }).catch((error: unknown) => log.warn({ error: errorText(error) }, 'phone ready announce failed'))
        publish({ link: { state: 'online', since: snapshot.link.state === 'online' ? snapshot.link.since : Date.now() } })
      },
      onStatus: (status, err) => {
        if (!isSubscribeFailure(status)) return
        const message = err instanceof Error ? err.message : `频道没订上:${subscribeStatusName(status)}`
        joined = false
        log.warn({ status: subscribeStatusName(status), error: message }, 'phone device channel failed')
        publish({ link: { state: 'error', message, at: Date.now() } })
      },
    })
  }

  const boot = async () => {
    publish({ link: { state: 'connecting' } })
    try {
      info = await nativePhoneActions.deviceInfo()
      installId = phoneInstallId(info.install_key ?? null)
      deviceId = phoneDeviceId(installId, userId)
      rpcHost = createPhoneDeviceRpcHost({ userId, deviceId, provider, join,
        replyShared: async (payload) => { if (!channel) return; await channel.send({ type: 'broadcast', event: 'broadcast', payload }) },
        warn: (message) => log.warn({ message }, 'phone device RPC'),
      })
      os = await readPhoneOsState()
      publish({ info, os, deviceId })
      rebuildCapability()
      await beat()
      if (!alive) return
      subscribe()
      heartbeatTimer = setInterval(() => { void beat().catch(() => undefined) }, PHONE_HEARTBEAT_MS)
    } catch (error) {
      if (!alive) return
      log.warn({ error: errorText(error) }, 'phone device start failed')
      publish({ link: { state: 'error', message: errorText(error), at: Date.now() } })
      // 第一拍没写进去(网络、令牌刚换):照样起心跳,下一拍成功后再订频道。
      if (!heartbeatTimer) {
        heartbeatTimer = setInterval(() => {
          void beat().then(() => { if (alive && !channel) subscribe() }).catch(() => undefined)
        }, PHONE_HEARTBEAT_MS)
      }
    }
  }

  const unsubscribeSettings = subscribePhoneDeviceSettings(() => {
    syncCollecting()
    // 总开关关了:马上就会停下、删设备行,❌ 再补一拍心跳去和删除赛跑。
    if (!readPhoneDeviceSettings(userId).enabled) return
    // 关掉一组:登记清单立刻改(❌ 等下一拍心跳 —— 助理会在这 30 秒里照旧调);正在跑的,host 在下一次报进度 / 交结果前拦下。
    if (rebuildCapability()) void beat().catch(() => undefined)
  })
  // 回到前台(多半刚从系统设置里改完权限):先直接重读系统、当场更新页面,清单变了再补一拍心跳。
  // ❌ 只调 beat():上一拍还在路上时会并进那一拍,读到的是去系统设置之前的旧值(模拟器实测:页面多等了一拍心跳才变)。
  const refreshOs = async (): Promise<void> => {
    if (!alive) return
    os = await readPhoneOsState()
    publish({ os })
    if (!rebuildCapability()) return
    const pending = beating
    if (pending) await pending.catch(() => undefined)
    await beat()
  }
  const unsubscribeActive = platform.subscribeAppActive?.((active) => {
    if (active) void refreshOs().catch((error: unknown) => log.warn({ error: errorText(error) }, 'phone os state refresh failed'))
  }) ?? (() => undefined)

  updateNotice()
  syncCollecting()
  void boot()

  const current: Session = {
    stop: () => {
      if (!alive) return
      alive = false
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      unsubscribeSettings()
      unsubscribeActive()
      rpcHost?.dispose()
      if (channel) {
        try {
          unsubscribeAuthenticatedRealtimeChannel(channel)
        } catch {
          /* 频道已经没了 */
        }
        channel = null
      }
      releaseNotice?.()
      releaseNotice = null
      syncCollecting()
      if (session === current) session = null
      // 系统权限的读数留着:设置页关掉总开关之后仍要显示各组「系统给没给」。
      publish({ ...OFF, os: snapshot.os, info: snapshot.info })
    },
    refresh: refreshOs,
    drain: async () => {
      await beating?.catch(() => undefined)
    },
  }
  session = current
  return current.stop
}

/** 设置页「去授权」回来后:立刻重读系统、重新登记。 */
export async function refreshPhoneDevice(): Promise<void> {
  if (session) {
    await session.refresh()
    return
  }
  // 没在当设备(总开关关着)也要让设置页看到系统的真值。
  publish({ os: await readPhoneOsState() })
}

/**
 * 断开:停掉、把设备行删掉 —— 助理那边当场看不到这台手机,❌ 留一行等 2 分钟后判离线(那期间它还会被调)。
 * 删不掉(没网)照样停:心跳一停,2 分钟后库会判它离线。
 */
export async function disconnectPhoneDevice(userId: string): Promise<{ removed: boolean }> {
  const deviceId = snapshot.deviceId ?? (() => {
    try {
      return phoneDeviceId(phoneInstallId(), userId)
    } catch {
      return null
    }
  })()
  const current = session
  current?.stop()
  await current?.drain()
  if (!deviceId) return { removed: false }
  try {
    await chatService.removeDevice(deviceId)
    return { removed: true }
  } catch (error) {
    log.warn({ error: errorText(error) }, 'phone device row not removed')
    return { removed: false }
  }
}
