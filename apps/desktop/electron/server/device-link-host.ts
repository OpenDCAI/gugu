/**
 * #6264 远程 SSH 的咕咕 server 上,「设备连接」的账号进程这一侧:添加这台机器的那台桌面经 SSH 来的那条线。
 *
 * 照 VS Code Remote-SSH:本机客户端 ↔ SSH ↔ server 的本机套接字。桌面经 SSH 跑 `gugu-server link`,
 * 它把标准输入输出接到这个账号的 attach 套接字上;这里把每条连接当成一条「设备 RPC 频道」来答:
 * 与咕咕云转来的设备 RPC **同一张处理表**(设置、资源库、已安排、文件、审阅、会话列表与时间线、投递、导入……),
 * 同一种信封、同一种推送。所以两条通道的行为只有一份,差别只在「字节走哪」。
 * 连外面那层也一样:每条消息都是 Realtime 广播的形状 `{ type: 'broadcast', event: 'broadcast', payload: 信封 }`
 * (两端的解析都先剥这一层,平铺的信封会把请求自己的 payload 当成信封读 —— 见 core/cloud/payload.ts)。
 *
 * 信任边界是操作系统用户(能经 SSH 以这个系统用户登上来的人,本来就读得到这个账号的一切文件):
 * 请求信封上的 user_id 一律换成这个账号自己,❌ 信对端报的。
 */
import {
  createDeviceRpcRequestHandler,
  type DeviceRpcHandlers,
} from '@gugu/core/cloud/deviceRpcResponder'
import { SESSION_HOST_FRAME_EVENT, SESSION_HOST_RPC } from '@shared/lib/ipc/session-host-device-frames'

// 终端的输入(桌面 → 机器:`{t:'invoke', channel:'pty.sendInput'}`)与输出(机器 → 桌面:`{t:'event', channel:'pty:data.<id>'}`)。
// 帧是 JSON 文本,t 与 channel 都在 args / data 之前(session-host-client、frame-host 的写法),只看开头一截就够,
// 大帧拆成几片时看第一片;不依赖键的先后。
const HEAD_CHARS = 256
const TERMINAL_OUTPUT_CHANNEL = /"channel":"pty:data[."]/

/** 一片是不是终端的输入或输出(拆开的大帧只看第一片)。 */
function isTerminalPiece(piece: unknown): boolean {
  if (!piece || typeof piece !== 'object') return false
  const { f, p } = piece as { f?: unknown; p?: unknown }
  if (typeof f !== 'string' || (p !== undefined && p !== 0)) return false
  const head = f.slice(0, HEAD_CHARS)
  if (head.includes('"t":"invoke"')) return head.includes('"channel":"pty.sendInput"')
  if (head.includes('"t":"event"')) return TERMINAL_OUTPUT_CHANNEL.test(head)
  return false
}

/**
 * 设备连接上的这一条信封算不算「在用」(云电脑的管家据此判闲置,见 core/cloud/remoteTunnel.ts 的 noteTunnelActivity):
 * 白名单,只认会话页宿主帧里的终端输入与输出。❌ 心跳、状态轮询(taskhost.call)、打开窗口、订阅、别的调用、机器推来的变动
 * —— 那些是「光连着」(总控 2026-10-15 定)。请求(帧在 payload.frames)与推送(帧在 frames)两种形状都认。纯函数。
 */
export function isTunnelUse(envelope: unknown): boolean {
  if (!envelope || typeof envelope !== 'object') return false
  const e = envelope as { type?: unknown; payload?: unknown; frames?: unknown }
  if (e.type !== SESSION_HOST_RPC.frame && e.type !== SESSION_HOST_FRAME_EVENT) return false
  const frames = Array.isArray(e.frames) ? e.frames : (e.payload as { frames?: unknown } | null | undefined)?.frames
  return Array.isArray(frames) && frames.some(isTerminalPiece)
}

export type DeviceLinkSession = { handle(message: unknown): void; dispose(): void }

export function createDeviceLinkHost(options: {
  /** 这个账号自己的用户 id(server 的账号进程由 GUGU_SERVER_ACCOUNT 指定)。 */
  userId: () => string | null
  /** 每条连接一份处理器,与云端频道「按频道建、按频道拆」同一条规矩(处理器可能握着会话订阅)。 */
  createHandlers: () => { handlers: DeviceRpcHandlers; dispose: () => void }
  warn?: (message: string) => void
  /** 这条连接上有人在用(终端的输入与输出,见 isTunnelUse;应答不算,它跟着请求来):心跳据此报「隧道最近一次有流量」。 */
  onActivity?: () => void
}): (send: (message: unknown) => void) => DeviceLinkSession {
  return (send) => {
    const userId = options.userId()
    if (!userId) throw new Error('这个账号还没登录,不接设备连接')
    const host = options.createHandlers()
    const handleRequest = createDeviceRpcRequestHandler({
      warn: options.warn,
      handlers: host.handlers,
    })
    let open = true
    const publish = (payload: unknown) => {
      if (open) send(asBroadcast(payload))
    }
    const publishEvent = (payload: unknown) => {
      if (open && isTunnelUse(payload)) options.onActivity?.()
      publish(payload)
    }
    return {
      handle(message) {
        if (!open || !message || typeof message !== 'object') return
        const inner = (message as { payload?: unknown }).payload
        if (!inner || typeof inner !== 'object') return
        if (isTunnelUse(inner)) options.onActivity?.()
        void handleRequest(asBroadcast({ ...(inner as Record<string, unknown>), user_id: userId }), publish, publishEvent)
      },
      dispose() {
        if (!open) return
        open = false
        host.dispose()
      },
    }
  }
}

/** 与 Realtime 广播同一个外壳(见文件抬头)。 */
export function asBroadcast(payload: unknown): { type: 'broadcast'; event: 'broadcast'; payload: unknown } {
  return { type: 'broadcast', event: 'broadcast', payload }
}
