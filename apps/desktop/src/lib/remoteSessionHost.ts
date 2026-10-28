// #6264 桌面这一侧:经「设备连接」开一条到那台机器会话页宿主的帧线(一套工作台;宿主一侧见
// electron/session/main/host-ws/device-session-host.ts)。线挑哪条(远程 SSH → SSH link,远程隧道 → 咕咕云)
// 在 deviceRpc.ts 里,这里不分叉。
//
// 手机走的也是这一条(手机不报 `desktop`:咕咕 server 按桌面的版本挑跑哪一版,手机不算)。
//
// 版本错位:那台机器不认 `taskhost.open`,或开窗口的应答里报的协议低于 MIN_SERVER_PROTOCOL,开线失败并带
// SessionHostTooOldError,界面据此把这台机器标成「版本太旧」,❌ 退回别的界面。
import { unwrapPayload } from '@gugu/core/cloud/payload'
import { desktopReportId, MIN_SERVER_PROTOCOL, REMOTE_PROTOCOL_VERSION } from '@gugu/core/cloud/serverMachineHealth'
import type { DesktopHello } from '@gugu/core/cloud/serverDesktopVersions'
import { DeviceRpcTimeoutError } from '@gugu/core/cloud/deviceRpcRequester'
import { callDeviceRpc, subscribeDeviceRpcEvents } from './deviceRpc'
import { desktopMatchVersion, isSshMachine, requestSshServerUpgrade, usesDeviceLink, waitForTunnel } from './sshLinkChannel'
import { rendererLogger } from './log'
import type { SessionHostPipe, SessionHostPipeOpener } from '../session/shared/lib/ipc/session-host-client'
import {
  createPieceJoiner,
  createSeqOrderer,
  SESSION_HOST_FRAME_EVENT,
  SESSION_HOST_READY_EVENT,
  SESSION_HOST_RPC,
  toPieces,
  type SessionHostFrameBatch,
  type SessionHostPiece,
} from '../session/shared/lib/ipc/session-host-device-frames'

/**
 * 每条窗口开、关各一行,带 client(那台机器上 device-session-host 按同一个 client 记开与关):两头的日志据此对上是哪一条窗口。
 * 2026-10-27 那次「开机时会话起不来」,桌面这头只有一句不带 client 的「连接关闭」,对不上那台机器上的哪一条。
 */
const log = rendererLogger('session-host/device')

export class SessionHostTooOldError extends Error {
  /** 与会话 / 资源库各处认「版本太旧」的同一个码(connection-status 的 TOO_OLD_CODES)。 */
  readonly code = 'server_outdated'
  constructor() {
    super('session host too old')
    this.name = 'SessionHostTooOldError'
  }
}

/** 开线 / 发帧的一次设备 RPC 等多久(咕咕云一来一回 + 那台机器处理)。 */
const OPEN_TIMEOUT_MS = 15_000
const FRAME_TIMEOUT_MS = 20_000
const DEVICE_LINK_FRAME_ATTEMPTS = 3
/**
 * 桌面连别的机器时,只装着心跳的那一批等应答多久(#156)。那台机器收下一批就当场回(不等处理,device-session-host 的
 * `taskhost.frame`),心跳又小:设备连接连着三次没确认才关窗口,期间补发同一 seq。咕咕云上没回还会重新报到、原样
 * 再问一次(#7233),所以最长 2 × 这个数。真实 SSH 断线不等这些期限,当场失败在途请求。
 */
export const HEARTBEAT_REPLY_TIMEOUT_MS = 4_000

export type RemoteSessionHostPipeOptions = {
  /**
   * 给了 = 心跳兼探活,只装着心跳的那一批等这么久(桌面连别的机器:HEARTBEAT_REPLY_TIMEOUT_MS)。
   * 不给 = 心跳与办事的那一批一样等 FRAME_TIMEOUT_MS(手机:蜂窝网一切换就是几秒,❌ 几秒没回就断线重开、重新订阅)。
   */
  heartbeatReplyTimeoutMs?: number
}

export type DeviceRpcDeps = {
  call: typeof callDeviceRpc
  subscribe: typeof subscribeDeviceRpcEvents
  newClientId: () => string
  isSshMachine: (deviceId: string) => boolean
  requestUpgrade: (deviceId: string) => Promise<boolean>
  requestCloudUpgrade?: (deviceId: string) => Promise<boolean>
  /** 开窗口时报给那台机器的「这台桌面是哪一版」(那台咕咕 server 据此让这个账号跑匹配的版本);拿不到 = 不报。 */
  desktop?: () => Promise<DesktopHello | null>
  waitForTunnel?: (deviceId: string) => Promise<void>
  usesDeviceLink?: (deviceId: string) => boolean
  ensureAwake?: (deviceId: string) => Promise<void>
}

declare const __APP_VERSION__: string | undefined

let selfId: Promise<string | null> | null = null

/** 主进程给的本机设备 id:要等它看过一轮当前账号(开机时 0.7–1.8 s,mac1 实测),所以只在没有上次那份时等。 */
function liveSelfId(): Promise<string | null> {
  // 按需加载:平台层一加载就碰渲染层全局,这里只在真开窗口时才要它。
  selfId ??= import('../platform')
    .then(({ platform }) => platform.getLocalDeviceSelfSnapshot?.() ?? null)
    .then((self) => self?.device_id ?? null, () => null)
  return selfId.then((id) => {
    if (!id) selfId = null
    return id
  })
}

/**
 * 上次那份机器列表(devicesCache,按账号记)里标着「本机」的那一行:一台桌面一个设备 id,换版本不变,换账号才换 ——
 * 所以只在缓存属于此刻这个账号时用它。开线不再为它等主进程那一轮(冷启动实测:开线一律卡到它回来,晚 0.3–1.4 s)。
 */
async function cachedSelfId(): Promise<string | null> {
  const [{ sessionCoordinator }, { cachedDevicesAccount, readCachedDevices }] = await Promise.all([
    import('./sessionCoordinator'),
    import('../store/devicesCache'),
  ])
  const owner = await sessionCoordinator.waitForDecidedOwner(0)
  if (!owner.userId || cachedDevicesAccount() !== owner.userId) return null
  return readCachedDevices().find((device) => device.is_current_device === true)?.device_id ?? null
}

/** 这台桌面:设备 id(一台桌面一个,换版本不变)+ 自己的版本 + 说的协议。 */
async function thisDesktop(): Promise<DesktopHello | null> {
  const asked = await desktopMatchVersion()
  const version = asked === undefined ? (typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '') : asked
  if (!version) return null
  const id = (await cachedSelfId().catch(() => null)) ?? (await liveSelfId())
  return id ? { id: desktopReportId(id, version), version, protocol: REMOTE_PROTOCOL_VERSION } : null
}

const defaultDeps: DeviceRpcDeps = {
  call: callDeviceRpc,
  subscribe: subscribeDeviceRpcEvents,
  newClientId: () => crypto.randomUUID().replace(/-/g, ''),
  isSshMachine,
  requestUpgrade: (deviceId) => requestSshServerUpgrade(deviceId),
  requestCloudUpgrade: async deviceId => (await import('./cloudVersionMatch')).requestCloudVersionMatch(deviceId),
  desktop: thisDesktop,
  waitForTunnel,
  usesDeviceLink,
  ensureAwake: async deviceId => {
    if (isSshMachine(deviceId)) return
    const [{ ensureCloudConnectionReady }, { listDevicesOnceIdentified }] = await Promise.all([
      import('./cloudComputerStore'), import('./listDevicesOnceIdentified'),
    ])
    await ensureCloudConnectionReady(deviceId, { isOnline: async id =>
      (await listDevicesOnceIdentified()).some(device => device.device_id === id && device.is_online) })
  },
}

/** 推送到手里时还套着广播外壳(`{ type: 'broadcast', payload: 信封 }`,SSH 设备连接与咕咕云同一个形状):先剥。 */
function batchFor(payload: unknown, client: string): SessionHostFrameBatch | null {
  const body = unwrapPayload(payload) as Partial<SessionHostFrameBatch> & { type?: unknown }
  return isBatchFor(body, client) ? body : null
}

function isHostReady(payload: unknown): boolean {
  return (unwrapPayload(payload) as { type?: unknown } | null)?.type === SESSION_HOST_READY_EVENT
}

function isBatchFor(body: Partial<SessionHostFrameBatch> & { type?: unknown }, client: string): body is SessionHostFrameBatch & { type: string } {
  return (
    body.type === SESSION_HOST_FRAME_EVENT &&
    body.client === client &&
    typeof body.seq === 'number' &&
    Array.isArray(body.frames)
  )
}

/** 手机开的窗口:❌ 报 `desktop`(没有 Electron 桥时 thisDesktop 会拿手机自己的设备 id 冒充一台桌面)。 */
export function openPhoneSessionHostPipe(deviceId: string): SessionHostPipeOpener {
  return openRemoteSessionHostPipe(deviceId, { ...defaultDeps, desktop: undefined })
}

/** 桌面连别的机器开的窗口:心跳兼探活(#156),那台机器没了几秒内就发现。 */
export function openMachineSessionHostPipe(deviceId: string): SessionHostPipeOpener {
  return openRemoteSessionHostPipe(deviceId, defaultDeps, { heartbeatReplyTimeoutMs: HEARTBEAT_REPLY_TIMEOUT_MS })
}

export function openRemoteSessionHostPipe(
  deviceId: string,
  deps: DeviceRpcDeps = defaultDeps,
  options: RemoteSessionHostPipeOptions = {},
): SessionHostPipeOpener {
  const opener: SessionHostPipeOpener = async ({ onFrame, onClose }) => {
    await deps.ensureAwake?.(deviceId)
    await deps.waitForTunnel?.(deviceId)
    const client = deps.newClientId()
    let closed = false
    let live = false
    /** 开线那一问还在路上时频道重接上了:那一问多半随断开的那段丢了,当场放弃,❌ 干等它超时。 */
    let abandonOpen: ((error: Error) => void) | null = null
    const joiner = createPieceJoiner(onFrame)
    const order = createSeqOrderer<SessionHostPiece[]>(joiner)
    /** 听到那台机器多少回(推来的一批、对哪一批的应答)。探活那一问没回,可期间听到过它 = 它还在,只是线上正忙。 */
    let heard = 0
    /** `handoff`:频道换了通道,这条窗口随旧通道作废 —— 客户端当场开新的,❌ 当成断线。 */
    const shut = (reason: string, handoff = false) => {
      if (closed) return
      closed = true
      log.info({ deviceId, client, reason }, 'session host window closed')
      unsubscribe()
      onClose(reason, handoff ? { handoff } : undefined)
    }
    const unsubscribe = deps.subscribe(
      deviceId,
      (payload) => {
        if (closed) return
        if (isHostReady(payload)) {
          // 那台机器上的宿主刚起来:还在开 = 这一问是对着没起来的它发的,放弃它(迟到成功的窗口照旧关掉)。
          // 重开由客户端经 watchPeerRestart 做(它在整段「想连」上都听着,不只在这条管道活着时)。
          abandonOpen?.(Object.assign(new Error('session host restarted while opening'), { code: 'host_restarted' }))
          return
        }
        const batch = batchFor(payload, client)
        if (!batch) return
        heard += 1
        order(batch.seq, batch.frames)
      },
      {
        // 线开好之后频道又(重)接上 = 中间断过:断着的那段推送丢了,关掉重开一条(重开会重新订阅、重新取快照)。
        // 还在开:开线那一问可能是断着时发的,放弃它,由客户端按退避马上再开(手机断网恢复实测:干等要 15 s)。
        // 只有同一条管道断过又订上(`rejoin`)才放弃:频道头一回订上时开线那一问还没发出去,丢不了(冷启动实撞:放弃它 ⇒ 第一条列表晚 5 s)。
        onChannelResubscribed: (rejoin: boolean) => {
          if (live) shut('channel resubscribed')
          else if (rejoin) abandonOpen?.(Object.assign(new Error('channel resubscribed while opening'), { code: 'channel_resubscribed' }))
        },
        // 频道要换到另一条通道上了(新的那条已经接好,deviceRpc 先接后断):开着的窗口先交接 —— 客户端当场开新窗口,
        // 界面照「通着」;旧通道随后撤掉,这条窗口上没回的问一起失败(此时已关,❌ 再关一次)。还在开的那一问发在旧通道上,
        // 放弃它当场再开(与重订上同一条路)。
        // #625 交接的这条窗口让旧通道撤掉前替它说一声关:那台机器按通道收窗口,新通道上的关它对不上号,不说就要等心跳丢了(约 30 s)。
        onChannelSwitching: () => {
          if (live) {
            shut('channel switching transport', true)
            return { type: SESSION_HOST_RPC.close, payload: { client } }
          }
          abandonOpen?.(Object.assign(new Error('channel switching transport while opening'), { code: 'channel_resubscribed' }))
        },
      },
    )
    let opened
    let request: ReturnType<DeviceRpcDeps['call']> | null = null
    try {
      const desktop = await deps.desktop?.().catch(() => null)
      request = deps.call(deviceId, SESSION_HOST_RPC.open, { client, protocol: REMOTE_PROTOCOL_VERSION, ...(desktop ? { desktop } : {}) }, { timeoutMs: OPEN_TIMEOUT_MS })
      opened = await Promise.race([request, new Promise<never>((_, reject) => { abandonOpen = reject })])
    } catch (error) {
      closed = true
      unsubscribe()
      // 放弃了的那一问若迟到成功,那台机器上就多开了一条没人用的窗口:关掉它。
      void request?.then((late) => {
        if (!late.error) void deps.call(deviceId, SESSION_HOST_RPC.close, { client }, { timeoutMs: FRAME_TIMEOUT_MS }).catch(() => undefined)
      }, () => undefined)
      throw error
    }
    abandonOpen = null
    if (opened.error) {
      closed = true
      unsubscribe()
      if (opened.error.code === 'unknown_method') {
        // 远程 SSH 的机器:这台桌面够得着,当场替它升级(升完自动重连);远程隧道的等它空闲时自己升。
        if (deps.isSshMachine(deviceId)) void deps.requestUpgrade(deviceId)
        else void deps.requestCloudUpgrade?.(deviceId)
        throw new SessionHostTooOldError()
      }
      throw Object.assign(new Error(`${opened.error.code}: ${opened.error.message}`), { code: opened.error.code })
    }
    const said = (opened.result as { protocol?: unknown } | undefined)?.protocol
    if (typeof said !== 'number' || said < MIN_SERVER_PROTOCOL) {
      closed = true
      unsubscribe()
      void deps.call(deviceId, SESSION_HOST_RPC.close, { client }, { timeoutMs: FRAME_TIMEOUT_MS }).catch(() => undefined)
      if (deps.isSshMachine(deviceId)) void deps.requestUpgrade(deviceId)
      else void deps.requestCloudUpgrade?.(deviceId)
      throw new SessionHostTooOldError()
    }

    live = true
    log.info({ deviceId, client }, 'session host window opened')
    let outSeq = 0
    let outbox: (string | Uint8Array)[] = []
    let outboxOnlyHeartbeats = true
    let flushScheduled = false
    /** 发出去还没回的批数。 */
    let unanswered = 0
    const flush = () => {
      flushScheduled = false
      const frames = outbox
      // 探活:只装着心跳、前面也没有还没回的批。排在一大批后面的心跳回得慢是在排队,❌ 当成对面没了把正在传的线掐断。
      const probe = options.heartbeatReplyTimeoutMs !== undefined && outboxOnlyHeartbeats && unanswered === 0
      const timeoutMs = probe ? options.heartbeatReplyTimeoutMs! : FRAME_TIMEOUT_MS
      const heardAtSend = heard
      outbox = []
      outboxOnlyHeartbeats = true
      for (const pieces of toPieces(frames)) {
        const batch: SessionHostFrameBatch = { client, seq: outSeq++, frames: pieces }
        unanswered += 1
        void (async () => {
          try {
            for (let attempt = 1; !closed; attempt += 1) {
              try {
                const reply = await deps.call(deviceId, SESSION_HOST_RPC.frame, batch, { timeoutMs })
                // 那台机器已经不认这条窗口(重启过 / 频道换过):断开,客户端会重开一条。
                if (reply.error) shut(`frame rejected: ${reply.error.code} (client ${client})`)
                else heard += 1
                return
              } catch (error) {
                const deviceLink = deps.usesDeviceLink?.(deviceId) === true
                // ACK 可能丢了:只补同一个 client/seq,宿主对已交付的 seq 回成功而不再执行。
                // 不能跳过这批:后面的 seq 会一直等着缺口。普通业务 RPC 不在这里重放。
                if (error instanceof DeviceRpcTimeoutError && deviceLink && attempt < DEVICE_LINK_FRAME_ATTEMPTS) continue
                // 云端探活照旧:期间听到过那台机器就留到下一拍。设备连接补发仍无确认时不能丢掉这个 seq。
                if (probe && !deviceLink && heard !== heardAtSend) return
                shut(`frame not delivered: ${String(error)} (client ${client})`)
                return
              }
            }
          } finally {
            unanswered -= 1
          }
        })()
      }
    }
    const pipe: SessionHostPipe = {
      send: (frame, kind) => {
        if (closed) throw new Error('session host link closed')
        outbox.push(frame)
        if (kind !== 'heartbeat') outboxOnlyHeartbeats = false
        if (!flushScheduled) {
          flushScheduled = true
          queueMicrotask(flush)
        }
      },
      close: () => {
        if (closed) return
        void deps.call(deviceId, SESSION_HOST_RPC.close, { client }, { timeoutMs: FRAME_TIMEOUT_MS }).catch(() => undefined)
        shut('closed')
      },
    }
    return pipe
  }
  // 宿主起来的那一声在这台机器的咕咕云设备频道上,与哪条窗口无关:客户端想连它的整段都听着。
  // 远程 SSH 的机器 ❌ 听:它的 ready 只说在云频道上,SSH 设备连接上没有这一声;那边宿主重起由设备连接自己接回
  // (`gugu-server link` 等账号进程的套接字出现再接上,接上即 onChannelResubscribed)。
  opener.watchPeerRestart = (onRestart) =>
    deps.isSshMachine(deviceId)
      ? () => undefined
      : deps.subscribe(deviceId, (payload) => {
          if (isHostReady(payload)) onRestart()
        })
  return opener
}
