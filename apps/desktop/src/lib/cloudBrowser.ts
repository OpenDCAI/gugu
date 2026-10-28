// #7199 云浏览器 · 桌面 / 手机这一头的连线(契约见 session/shared/cloud-browser.ts)。
//
//   · 状态与小图:问那台云电脑的会话页宿主(`taskhost.call` → `cloudBrowser.status / snapshot`),设备 RPC,桌面手机都通。
//   · 实时画面 + 接管:桌面经远程隧道把云电脑本机上那个 websocket 端口转一个本机端口(`remotePorts.open`,与会话页
//     浏览器打开那台机器的 localhost 同一条路),再直连它。手机没有隧道,只看小图。
import { rpc } from '@renderer/lib/ipc'
import { platform } from '../platform'
import { callDeviceRpc } from './deviceRpc'
import { rendererLogger } from './log'
import { cloudHostSuspended } from './cloudHostSuspended'
import { SESSION_HOST_RPC } from '../session/shared/lib/ipc/session-host-device-frames'
import {
  CLOUD_BROWSER_PROTOCOL,
  CLOUD_BROWSER_TICKET_PREFIX,
  parseCloudBrowserServerMessage,
  type CloudBrowserClientMessage,
  type CloudBrowserServerMessage,
  type CloudBrowserSnapshot,
  type CloudBrowserStatus,
} from '../session/shared/cloud-browser'

export class CloudBrowserCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'CloudBrowserCallError'
  }
}

type RpcResult<T> = { success: true; data: T } | { success: false; error: { type?: string } }

async function callCloudBrowser<T>(deviceId: string, method: 'status' | 'snapshot', args: unknown[], timeoutMs: number): Promise<RpcResult<T>> {
  if (cloudHostSuspended(deviceId)) throw new CloudBrowserCallError('unreachable', 'cloud computer is sleeping or waking')
  const reply = await callDeviceRpc<{ value: unknown }>(deviceId, SESSION_HOST_RPC.call, { channel: `cloudBrowser.${method}`, args }, { timeoutMs })
  if (reply.error) throw new CloudBrowserCallError(reply.error.code, reply.error.message)
  const value = reply.result?.value as RpcResult<T> | null | undefined
  if (!value || typeof value !== 'object' || typeof value.success !== 'boolean') throw new CloudBrowserCallError('invalid_reply', 'the cloud computer gave no browser state')
  return value
}

/** 那台云电脑上的浏览器此刻怎样。老版本的 server 没有这个动词 —— 调用方据 `code` 判「不支持」、不再问。 */
export async function fetchCloudBrowserStatus(deviceId: string): Promise<CloudBrowserStatus> {
  const result = await callCloudBrowser<CloudBrowserStatus>(deviceId, 'status', [], 8_000)
  if (!result.success) throw new CloudBrowserCallError(result.error.type ?? 'failed', 'cloud browser status failed')
  return result.data
}

/** 一张小图(手机上的预览)。没有页签 = null。 */
export async function fetchCloudBrowserSnapshot(deviceId: string, tabId: string | null, maxWidth: number): Promise<CloudBrowserSnapshot | null> {
  const result = await callCloudBrowser<CloudBrowserSnapshot>(deviceId, 'snapshot', [{ tabId, maxWidth }], 10_000)
  if (!result.success) return null
  return result.data
}

/** 这个宿主有没有远程隧道那条路(Electron 桌面才有;手机、网页版只看小图)。 */
export function canOpenLiveBrowser(): boolean {
  return platform.capabilities.sessionHost
}

export type CloudBrowserLinkState = 'connecting' | 'open' | 'closed' | 'failed'

export type CloudBrowserLinkHandlers = {
  onMessage: (message: CloudBrowserServerMessage) => void
  onState: (state: CloudBrowserLinkState) => void
}

const linkLog = rendererLogger('cloud-browser/link')

const KEEPALIVE_MS = 15_000
const CONNECT_TIMEOUT_MS = 30_000

/**
 * 一条实时连接(连接超时 30 s、每 15 s 一拍 keepalive、断了按 1 s 起翻倍、封顶 30 s 重连)。
 * 端口转发由这里拿、由这里还;❌ 连接断了还占着那条转发。
 */
export class CloudBrowserLink {
  private socket: WebSocket | null = null
  private keepalive: ReturnType<typeof setInterval> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private backoffMs = 1_000
  private disposed = false
  /** 第几次连:手动重连 / 退避重连 / 销毁都会让还在路上的那次作废(❌ 两条连接同时开着、旧的超时拆掉新的)。 */
  private attempt = 0
  private forwarded: { remotePort: number } | null = null
  private lastConfig: CloudBrowserClientMessage | null = null
  private readonly holder = `cloud-browser-${Math.random().toString(36).slice(2, 10)}`

  constructor(
    private readonly deviceId: string,
    private readonly endpoint: () => Promise<{ port: number; token: string } | null>,
    private readonly handlers: CloudBrowserLinkHandlers,
  ) {}

  start(): void {
    void this.connect()
  }

  send(message: CloudBrowserClientMessage): boolean {
    if (message.type === 'config') this.lastConfig = message
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false
    // 网络卡住时 ❌ 越堆越多(缓冲过 64 KiB 就丢,画面帧的 ack / 鼠标移动丢了下一条会补上)。
    if (this.socket.bufferedAmount > 64 * 1024 && (message.type === 'input_mouse' || message.type === 'ack' || message.type === 'keepalive')) return false
    this.socket.send(JSON.stringify(message))
    return true
  }

  /** 手动「重新连接」。 */
  reconnect(): void {
    this.backoffMs = 1_000
    this.teardownSocket()
    void this.connect()
  }

  dispose(): void {
    this.disposed = true
    this.attempt += 1
    this.clearRetry()
    this.teardownSocket()
    this.releaseForward()
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private releaseForward(): void {
    const forwarded = this.forwarded
    this.forwarded = null
    if (forwarded) void rpc.remotePorts.release({ deviceId: this.deviceId, remotePort: forwarded.remotePort, holder: this.holder }).catch(() => undefined)
  }

  private teardownSocket(): void {
    if (this.keepalive) clearInterval(this.keepalive)
    this.keepalive = null
    const socket = this.socket
    this.socket = null
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null
      try {
        socket.close()
      } catch {
        // already closed
      }
    }
  }

  /** 断了 / 连不上:原因进日志(界面只说「连接已断开 · 重新连接」),按退避重连。 */
  private scheduleRetry(reason: string): void {
    if (this.disposed) return
    linkLog.info({ deviceId: this.deviceId, reason, retryInMs: this.backoffMs }, 'cloud browser link down')
    this.handlers.onState('closed')
    this.clearRetry()
    this.retryTimer = setTimeout(() => void this.connect(), this.backoffMs)
    this.backoffMs = Math.min(30_000, this.backoffMs * 2)
  }

  private async connect(): Promise<void> {
    if (this.disposed) return
    this.clearRetry()
    const attempt = ++this.attempt
    const stale = () => this.disposed || attempt !== this.attempt
    this.handlers.onState('connecting')
    let endpoint: { port: number; token: string } | null
    try {
      endpoint = await this.endpoint()
    } catch (error) {
      if (stale()) return
      return this.scheduleRetry(error instanceof Error ? error.message : String(error))
    }
    if (stale()) return
    if (!endpoint) return this.handlers.onState('failed')
    if (this.forwarded && this.forwarded.remotePort !== endpoint.port) this.releaseForward()
    const opened = await rpc.remotePorts.open({ deviceId: this.deviceId, sessionId: 'cloud-browser', remotePort: endpoint.port, holder: this.holder }).catch((failure: unknown) => {
      linkLog.warn({ deviceId: this.deviceId, failure: String(failure) }, 'cloud browser port forward threw')
      return { success: false as const, error: { type: 'failed' as const } }
    })
    if (!opened.success) {
      if (stale()) return
      return this.scheduleRetry(`tunnel: ${'reason' in opened.error ? String(opened.error.reason) : opened.error.type}`)
    }
    this.forwarded = { remotePort: endpoint.port }
    if (stale()) {
      // 转发开好时这条连接已经销毁了:当场还掉(销毁那会儿转发还没回来,没还成)。
      if (this.disposed) this.releaseForward()
      return
    }
    const socket = new WebSocket(`ws://127.0.0.1:${opened.data.localPort}/live`, [CLOUD_BROWSER_PROTOCOL, `${CLOUD_BROWSER_TICKET_PREFIX}${endpoint.token}`])
    this.socket = socket
    const timeout = setTimeout(() => {
      if (this.socket === socket && socket.readyState !== WebSocket.OPEN) {
        this.teardownSocket()
        this.scheduleRetry('timeout')
      }
    }, CONNECT_TIMEOUT_MS)
    socket.onopen = () => {
      clearTimeout(timeout)
      this.backoffMs = 1_000
      this.handlers.onState('open')
      if (this.lastConfig) socket.send(JSON.stringify(this.lastConfig))
      this.keepalive = setInterval(() => this.send({ type: 'keepalive' }), KEEPALIVE_MS)
    }
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      const message = parseCloudBrowserServerMessage(event.data)
      if (message) this.handlers.onMessage(message)
    }
    socket.onerror = () => undefined
    socket.onclose = () => {
      clearTimeout(timeout)
      if (this.socket !== socket) return
      this.teardownSocket()
      this.scheduleRetry('closed')
    }
  }
}
