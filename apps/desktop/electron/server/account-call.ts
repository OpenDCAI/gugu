/**
 * 经本机 attach 套接字问这个账号的进程一句(C 帧 → R / E 帧)。`gugu-server open-url` 用它把「打开网页」交回账号进程。
 *
 * ⚠️ 只在 CLI 里跑:不碰 electron、不加载主进程,起得快(每问一次就起一次)。
 */
import net from 'node:net'
import {
  ATTACH_EXIT,
  ATTACH_PROTOCOL_VERSION,
  encodeJsonFrame,
  FRAME,
  FrameDecoder,
  parseJson,
  ptyAttachSocketPath,
  type AttachError,
} from '../session/main/core/pty/attach/attach-protocol'
import type { ServerAccount } from './server-layout'

/** Released CLI callers may name the current identity, but cannot select a directory. */
export function accountRequestError(account: ServerAccount | null, requested: string | null): string | null {
  if (!account?.signedIn) return '这台机器上还没有登录咕咕账号。'
  if (requested && requested !== account.userId) return `当前账号是 ${account.email ?? account.userId}，与请求的账号 ${requested} 不符。`
  return null
}

/** 连不上套接字时的人话:进程没在跑 / 太旧(还没有这个套接字)。 */
export function describeConnectError(error: NodeJS.ErrnoException, email: string | null): string {
  const who = email ?? '这个账号'
  if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
    return `${who}的咕咕 server 未运行或版本太旧。执行 gugu-server status 查看。`
  }
  return `连不上${who}的咕咕 server 进程:${error.message}`
}

/**
 * 拿到应答 = 原样字节;否则给退出码 + 一句人话。
 */
export function callAccountProcess(
  account: { dataDir: string; email: string | null },
  request: { type: string; payload: unknown },
  options: { timeoutMs?: number } = {},
): Promise<{ reply: Buffer } | { code: number; message: string }> {
  return new Promise((resolve) => {
    const socket = net.connect(ptyAttachSocketPath(account.dataDir))
    const decoder = new FrameDecoder()
    let settled = false
    const timer = options.timeoutMs === undefined ? null : setTimeout(() => {
      done({ code: ATTACH_EXIT.serverNotRunning, message: '账号进程没有及时应答' })
    }, options.timeoutMs)
    const done = (outcome: { reply: Buffer } | { code: number; message: string }) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      socket.destroy()
      resolve(outcome)
    }
    socket.once('connect', () => {
      socket.write(encodeJsonFrame(FRAME.call, { v: ATTACH_PROTOCOL_VERSION, ...request }))
    })
    socket.on('data', (chunk: Buffer) => {
      let frames
      try {
        frames = decoder.push(chunk)
      } catch (error) {
        return done({ code: 1, message: `协议出错:${error instanceof Error ? error.message : String(error)}` })
      }
      for (const frame of frames) {
        if (frame.type === FRAME.reply) return done({ reply: frame.payload })
        if (frame.type === FRAME.error) {
          const error = parseJson<AttachError>(frame.payload)
          return done({ code: ATTACH_EXIT.refused, message: error?.message ?? '账号进程拒绝了这次请求' })
        }
      }
    })
    socket.on('error', (error: NodeJS.ErrnoException) => {
      done({ code: ATTACH_EXIT.serverNotRunning, message: describeConnectError(error, account.email) })
    })
    socket.on('close', () => done({ code: ATTACH_EXIT.serverNotRunning, message: '账号进程没有应答就断开了' }))
  })
}
