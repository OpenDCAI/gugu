/**
 * `gugu-server link [--account <账号 id>] [--adopt-ssh]`(#6264 远程 SSH 的机器:添加它的那台桌面与它之间的一切走 SSH)。
 *
 * 照 VS Code Remote-SSH「本机客户端 ↔ SSH ↔ server 的本机套接字」:桌面经 `ssh -T … exec gugu-server link`
 * 起它,它把自己的标准输入输出**原样**接到这个账号的 attach 套接字上(先发一帧 L 打招呼,见 attach-protocol.ts)。
 * 之后桌面与账号进程直接说帧,这里只搬字节,不解析 —— 一条连接一直开着,上面并发多问、推送事件。
 *
 * 标准输出:先是一行 LINK_READY_MARK(之前的任何字节是用户 rc 打的,桌面丢掉),之后全是二进制帧。
 *
 * --adopt-ssh:装这台机器的那台桌面接上来时带着。这个账号还没记「是怎么登上的」(老版本装的)就记成远程 SSH ——
 *   设备列表据此标它的连法、机器上限据此不把它算进远程隧道那一档。已经记着的不改(见 server-layout.writeServerConnectVia)。
 *
 * 账号进程此刻没在跑(套接字还没有 / 还是上一个进程留下的死套接字):**等它起来**,❌ 当场退出 —— 守护进程几秒内就会把它
 * 拉起来(换版、崩了重起),桌面那头这条连接一直在等,套接字一出现当场接上;❌ 让桌面按退避一遍遍重开、在两拍之间干等。
 * 只看套接字所在目录的变化(fs.watch),❌ 轮询;最多等 LINK_SERVER_WAIT_MS(比桌面等「接上了」的 30 s 短一截,见那里)。
 *
 * 退出码(LINK_EXIT):0 正常断开;2 用法错(老版本对不认识的命令也是 2 = 太旧);3 账号进程没在跑(等满了也没起来);
 * 4 账号进程拒绝了(原因任意,照实报 —— ❌ 当成太旧);5 这台机器上没登这个账号;
 * 6 账号进程说设备连接协议对不上(明确的版本信号,标准错误上带 LINK_PROTOCOL_MISMATCH_MARK 与双方协议号)。
 *
 * ⚠️ 只在 CLI 里跑:不碰 electron、不加载主进程。
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { REMOTE_PROTOCOL_VERSION } from '@gugu/core/cloud/serverMachineHealth'
import {
  ATTACH_PROTOCOL_VERSION,
  encodeJsonFrame,
  FRAME,
  LINK_EXIT,
  LINK_PROTOCOL_MARK,
  LINK_PROTOCOL_MISMATCH_MARK,
  LINK_READY_MARK,
  parseJson,
  ptyAttachSocketPath,
  type AttachError,
} from '../session/main/core/pty/attach/attach-protocol'
import { describeConnectError, pickAttachAccount } from './account-call'
import { listAccounts, writeServerConnectVia, type ServerAccount } from './server-layout'

const ID = /^[A-Za-z0-9_-]{1,128}$/

/**
 * 账号进程没在跑时最多等它多久。桌面等「接上了」是 30 s(ssh-link.ts 的 LINK_OPEN_TIMEOUT_MS),从拉起 ssh 算;
 * 这里从第一次连不上算,前面还有 ssh 握手、登录 shell 的 rc、node 起 CLI。得在桌面超时杀掉它之前自己给出结论
 * (退 3 = 没在跑),否则原因会被桌面说成「超时 / 连不上」⇒ 留出 10 s。
 */
export const LINK_SERVER_WAIT_MS = 20_000

/** 这两种 = 账号进程此刻没在听(还没起来 / 死了留下的套接字),值得等;别的错误照实报。 */
const NOT_LISTENING = new Set(['ENOENT', 'ECONNREFUSED'])

type WatchDir = (dir: string, onChange: () => void) => () => void

export const watchDir: WatchDir = (dir, onChange) => {
  const watcher = fs.watch(dir, () => onChange())
  // 监听本身出错(目录被删 / 句柄失效):❌ 让进程崩成退出码 1(桌面会归成「连不上」);当成一次变化再连 ——
  // 连不上就接着等到截止,照实退 3。
  watcher.on('error', () => onChange())
  return () => watcher.close()
}

export type LinkArgs = { account: string | null; adoptSsh: boolean }

export function parseLinkArgs(args: readonly string[]): LinkArgs | { error: string } {
  let account: string | null = null
  let adoptSsh = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--adopt-ssh') adoptSsh = true
    else if (arg === '--account') account = args[++i] ?? ''
    else if (arg.startsWith('--account=')) account = arg.slice('--account='.length)
    else return { error: '用法:gugu-server link [--account <账号 id>] [--adopt-ssh]' }
    if (account !== null && !ID.test(account)) return { error: '--account 后面要写账号 id' }
  }
  return { account, adoptSsh }
}

/**
 * 账号进程回的第一帧:L(空)= 接上了;E = 拒绝(老进程不认 L 也回 E)。
 * 返回 null = 还不够一帧;否则给出结论和这一帧之后剩下的字节(已经是设备连接的数据,要原样交给桌面)。
 */
export function readLinkAck(buffer: Buffer): { ok: true; rest: Buffer } | { ok: false; error: AttachError | null } | null {
  if (buffer.length < 5) return null
  const type = buffer.readUInt8(0)
  const length = buffer.readUInt32BE(1)
  if (buffer.length < 5 + length) return null
  if (type === FRAME.link) return { ok: true, rest: buffer.subarray(5 + length) }
  if (type === FRAME.error) return { ok: false, error: parseJson<AttachError>(buffer.subarray(5, 5 + length)) }
  return { ok: false, error: null }
}

/**
 * 账号进程拒绝了设备连接:退出码与标准错误上打什么。只有 protocol_mismatch 是版本信号(退出码 6 + 标记行);
 * 其它任何拒绝(包括说不清原因的)都是 4,原文照打,❌ 冒充太旧。纯函数。
 */
export function linkRefusal(error: AttachError | null): { code: number; stderr: string } {
  const message = error?.message ?? '账号进程拒绝了设备连接(没有说原因)'
  if (error?.code === 'protocol_mismatch' && error.protocol) {
    const { server, client } = error.protocol
    return {
      code: LINK_EXIT.protocolMismatch,
      stderr: `${LINK_PROTOCOL_MISMATCH_MARK} server=${server} client=${client}\n${message}\n`,
    }
  }
  return { code: LINK_EXIT.refused, stderr: `${error?.code ? `${error.code}: ` : ''}${message}\n` }
}

type Io = {
  stdin: NodeJS.ReadableStream
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
}

export async function runLink(
  args: readonly string[],
  io: Io = process,
  deps: {
    accounts?: () => ServerAccount[]
    adopt?: (account: ServerAccount) => void
    connect?: (socketPath: string) => net.Socket
    watch?: WatchDir
    waitMs?: number
  } = {},
): Promise<number> {
  const parsed = parseLinkArgs(args)
  if ('error' in parsed) {
    io.stderr.write(`${parsed.error}\n`)
    return LINK_EXIT.usage
  }
  const account = pickAttachAccount((deps.accounts ?? listAccounts)(), parsed.account)
  if ('error' in account) {
    io.stderr.write(`${account.error}\n`)
    return LINK_EXIT.notSignedIn
  }
  if (parsed.adoptSsh) {
    try {
      const adopt = deps.adopt ?? ((a: ServerAccount) => void writeServerConnectVia(a.dataDir, 'ssh', { onlyIfUnknown: true }))
      adopt(account)
    } catch (error) {
      // 记不下来只是这台还会被别处列出、还接云端转来的 RPC —— 连接本身照样接。
      io.stderr.write(`没能记下「这台机器是远程 SSH」:${error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  return new Promise<number>((resolve) => {
    const socketPath = ptyAttachSocketPath(account.dataDir)
    const connect = deps.connect ?? ((p) => net.connect(p))
    let socket: net.Socket | null = null
    let acked = false
    let settled = false
    // 等账号进程起来的那一段:目录监听 + 截止计时;没在等 = null。
    let waiting: { stop: () => void; again: boolean } | null = null
    const stopWaiting = () => {
      waiting?.stop()
      waiting = null
    }
    const done = (code: number) => {
      if (settled) return
      settled = true
      stopWaiting()
      socket?.destroy()
      // 等标准输出写完再退:管道上是异步的,马上退会截掉最后一块。
      io.stdout.write('', () => resolve(code))
    }
    const notRunning = (detail: string) => {
      io.stderr.write(`${detail}\n`)
      done(LINK_EXIT.serverNotRunning)
    }
    /** 账号进程没在听:等它的套接字出现再连。目录本身都没有 = 从没起来过,照实报。 */
    const waitForServer = (error: NodeJS.ErrnoException) => {
      if (waiting) {
        // 目录变了、连上去还是没人听(套接字刚删还没建 / 刚建好还没 listen):接着等下一次变化。
        // 兜住「建好还没 listen」那一下靠的是 attach-server.ts 在 listen 之后那次 chmod:它在同一个目录上再出一次事件。
        // ⚠️ 挪走 / 删掉那次 chmod 之前,先让这里在 listen 完成后另有一次可等的变化,否则会一直等到截止。
        if (waiting.again) {
          waiting.again = false
          attempt()
        }
        return
      }
      let stopWatch: () => void
      try {
        stopWatch = (deps.watch ?? watchDir)(path.dirname(socketPath), () => {
          if (!waiting) return
          if (socket) waiting.again = true
          else attempt()
        })
      } catch {
        return notRunning(describeConnectError(error, account.email))
      }
      const timer = setTimeout(
        () => notRunning(`等了 ${Math.round((deps.waitMs ?? LINK_SERVER_WAIT_MS) / 1000)} 秒,账号进程还是没起来。${describeConnectError(error, account.email)}`),
        deps.waitMs ?? LINK_SERVER_WAIT_MS,
      )
      waiting = { stop: () => { stopWatch(); clearTimeout(timer) }, again: false }
      // 开始监听之前它可能刚好起来了:监听挂上之后再试一次,❌ 漏掉那一下。
      attempt()
    }
    const attempt = () => {
      if (settled || socket) return
      const current = connect(socketPath)
      socket = current
      let pending: Buffer = Buffer.alloc(0)
      current.once('connect', () => {
        current.write(encodeJsonFrame(FRAME.link, { v: ATTACH_PROTOCOL_VERSION }))
      })
      current.on('data', (chunk: Buffer) => {
        if (acked) {
          io.stdout.write(chunk)
          return
        }
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
        const ack = readLinkAck(pending)
        if (!ack) return
        if (!ack.ok) {
          const refusal = linkRefusal(ack.error)
          io.stderr.write(refusal.stderr)
          return done(refusal.code)
        }
        acked = true
        stopWaiting()
        pending = Buffer.alloc(0)
        io.stdout.write(`\n${LINK_PROTOCOL_MARK} ${REMOTE_PROTOCOL_VERSION}\n${LINK_READY_MARK}\n`)
        if (ack.rest.length) io.stdout.write(ack.rest)
        io.stdin.on('data', (data: Buffer | string) => {
          current.write(typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
        })
        io.stdin.on('end', () => current.end())
        io.stdin.on('error', () => current.end())
        io.stdin.resume?.()
      })
      current.on('error', (error: NodeJS.ErrnoException) => {
        if (acked) return done(0)
        if (socket !== current) return
        socket = null
        current.destroy()
        if (error.code && NOT_LISTENING.has(error.code)) return waitForServer(error)
        notRunning(describeConnectError(error, account.email))
      })
      current.on('close', () => {
        if (acked) return done(0)
        if (socket !== current) return
        socket = null
        notRunning('账号进程没有应答就断开了')
      })
    }
    attempt()
  })
}
