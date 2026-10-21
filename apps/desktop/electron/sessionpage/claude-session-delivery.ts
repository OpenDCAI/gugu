// @@@sessionpage TASKPAGE-FUSION claude-tui — claude 原生 TUI 会话的**入站**投递(spec ⑧:走 agent 自身
// 控制通道把消息作为新一轮输入交付;owner #85 已废弃「pty 注入」设定)。
//
// 通道 = claude 自己的 **rendezvous socket**:启动时用两个环境变量把它打开并指定路径 ——
//   CLAUDE_BG_BACKEND=daemon
//   CLAUDE_BG_RENDEZVOUS_SOCK=<path>
// 然后往这个 unix socket 写一行 JSON,消息就作为新一轮输入进了**活着的那个会话进程**(就是用户在会话页
// 面板里看的那个)。这两个变量在 claude 2.1.216 的二进制里实测存在。
//
// ❌ 不要再用 `claude --resume … -p`(本仓 2026-07-25 之前的做法):那会**另起一个进程**接同一个会话文件,
// 而面板里那个进程仍持有自己的旧节点 —— claude 的会话是一棵树(每条记录带 parentUuid),两个写入者必然分叉。
// 实测后果:同一个 session 文件长出两个叶子,一条 18 轮(面板看到的)、一条 35 轮(投递那条),**没有任何一条
// 路径包含全部内容**,于是面板永远看不到收到的消息、agent 自己也不知道收过 —— 破坏了「一个 session = 一个
// agent = 一份记忆」这个不变量(owner 定性)。
//
// 协议纪律来自 spexcode(github.com/shuxueshuxue/spexcode,spec-cli/src/harness.ts)用真事故换来的三条,
// 照搬其结论、代码自写:
//   ① daemon **只保留一个连接**:新连接会 destroy 旧连接,连同它**收到但还没解析**的行一起丢弃。所以
//      「写成功」不等于「送到」(它们的现场:面板显示已发送,claude transcript 里查无此事)。
//   ② 因此把 `reply` 和一个 `repaint` 探针**当作一个 chunk 一次写**:daemon 在一个同步循环里解析一个 chunk
//      的完整行,于是这一对要么都被解析、要么都没有 —— 结果可判定。
//   ③ 判定:收到 `repaint-done` = 它前面那行 reply 已被解析(顺序屏障)→ 确认送达;连接先关/ECONNRESET/EPIPE
//      = 整块没被解析(被新连接踢掉)→ 重连重发(有界重试,不会重复投递,因为那是已证实的丢失);
//      墙钟到点但连接仍开着 = 对方忙在延迟处理,不是已证实丢失 → 只报「已写入通道、未确认」,
//      不能冒称确认送达,也不能盲目重发制造重复消息。
import { createConnection } from 'node:net'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSessionTuiDeliveryToolNames } from '@gugu/session-plugins/agents'
import { registerSessionpageDeliveryTarget } from './sessionpage-delivery-owner-registry'
import { createLogger } from '../lib/logger'

/** 就绪门的日志走宿主 logger(console 债务棘轮;与 session-injection 的 deliveryLogger 同形)。 */
const readinessLog = () => createLogger('sessionpage/claude-readiness')
type ReadinessEntry = {
  state: ClaudeSessionReadiness
  deadline: ReturnType<typeof setTimeout> | null
  release: (() => void) | null
  waiters: Array<{ resolve: () => void; reject: (error: Error) => void }>
}

export interface ClaudeSessionRegistration {
  guguAgentUserId: string
  /** 会话页会话 id(= claude 的 session id;teardown 用它认领要清理的登记)。 */
  sessionId: string
  /** 任务 worktree —— 仅作诊断展示。 */
  cwd: string
  /** 该会话所属的 gugu 群(spec ⑨),给注入的 gugu MCP 用。 */
  chatId: string | null
  /** 这条会话跑的 harness —— rendezvous 拓扑可被多家选用,注入时机按这家的声明查。 */
  providerId: string
}

/**
 * Windows 上这条通道的前缀。写成 `String.raw` 是有原因的:它的四个反斜杠一个都不能少,
 * 写成转义序列就要数层数 —— 数错一层得到的是一条连不上、却长得很像对的路径(#6110 第一次手写就错了一层)。
 */
export const CLAUDE_WIN_RENDEZVOUS_PIPE_PREFIX = String.raw`\\.\pipe\gugu-rv-`

/**
 * 这个会话的 rendezvous 通道路径 —— 启动时由 `CLAUDE_BG_RENDEZVOUS_SOCK` 告诉 claude,投递时连它。
 * 截短 id:unix socket 路径有 ~104 字节上限,而 macOS 的 tmpdir 本身就有 50 字节。
 *
 * win32 是**命名管道**,不是 tmpdir 里的文件(#6110):claude 是 Bun,拿到一条 tmpdir 路径会在 `%TEMP%`
 * 下建出一个 AF_UNIX socket 文件;宿主却是 Node,Windows 上 `net.createConnection({ path })` 只认命名管道
 * —— 连那个文件必得 `connect EACCES`,而且更早一步就挡住了:`existsSync` 对它一律回 false(stat 拿到
 * EACCES,existsSync 把任何错误都读成「不存在」),于是投递在 socket 门就被判成「会话不在线」,
 * 真实原因(Node 根本连不上 Bun 的 AF_UNIX 文件)一个字都没露出来。claude 与 Node 都认
 * `\\.\pipe\…`,所以 win32 一律走命名管道:它是内核对象,不占 tmpdir,也不会留下残骸。
 *
 * `platform` 只为判据存在 —— 两个分支的形状必须在任何一台宿主上都能读,
 * ❌ 让 win32 那支只有站在 Windows 上才判得了(那样 CI 永远证不了它)。
 */
export function claudeRendezvousSock(
  sessionId: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const id = sessionId.replace(/-/g, '').slice(0, 20)
  if (platform === 'win32') return `${CLAUDE_WIN_RENDEZVOUS_PIPE_PREFIX}${id}`
  return join(tmpdir(), `gugu-rv-${id}.sock`)
}

/**
 * 有没有人在听这条 rendezvous 通道(连一下:通 = 活着;ECONNREFUSED / ENOENT = 没人)。连着没回话 = 可能只是忙,当活着。
 * 「这个文件能不能删」只问这一句 —— 启动扫描与起会话前的清理同一个判据。
 */
export function rendezvousListening(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ path })
    const done = (alive: boolean) => {
      socket.destroy()
      resolve(alive)
    }
    socket.setTimeout(1_000, () => done(true))
    socket.once('connect', () => done(true))
    socket.once('error', (error: NodeJS.ErrnoException) => done(!(error.code === 'ECONNREFUSED' || error.code === 'ENOENT')))
  })
}

/**
 * 起会话前清掉**没人听的**残留 socket 文件(unix socket 不会在进程非正常退出时自动 unlink)。
 * 有人在听就不碰:宿主重启后接回 tmux 里还活着的 claude 也走这一步,那时听的正是这条会话自己 ——
 * 删了它,claude 仍守着一个没有路径的 inode,此后每次投递 connect 都是 ENOENT(判没人听),直到 claude 重起。
 * (真要新起一个 claude 而旧的还在听:claude 自己会 unlink 再 bind,接管这条路径,v2.1.293 实测。)
 * win32 没有这一步:命名管道是内核对象,最后一个句柄关掉就没了,不存在「残留」可清。
 */
export async function clearStaleRendezvousSock(
  sessionId: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === 'win32') return
  const sock = claudeRendezvousSock(sessionId, platform)
  if (await rendezvousListening(sock)) return
  await unlink(sock).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
}

/** 已死会话留下的 rendezvous 文件:多老才算(刚起的会话可能 bind 了还没 listen,那一瞬连它也是拒绝)。 */
const STALE_RENDEZVOUS_MIN_AGE_MS = 60_000
const RENDEZVOUS_FILE = /^gugu-rv-[0-9a-f]{1,20}\.sock$/

export type RendezvousSweepDeps = {
  dir: string
  list: (dir: string) => Promise<string[]>
  stat: (path: string) => Promise<{ isSocket: () => boolean; uid: number; mtimeMs: number }>
  /** 有没有人在听(见 rendezvousListening)。 */
  listening: (path: string) => Promise<boolean>
  remove: (path: string) => Promise<void>
  uid: number
  now: number
}

/**
 * #6264 启动时清一次 tmp 里已经没人听的 rendezvous 文件(会话被杀、进程崩掉时 claude 来不及删;服务器常驻几周
 * 就攒下一片)。只动**自己**的(同 uid)、是 socket、超过一分钟、连上去被拒的 —— 另一个咕咕实例正在用的连得通,
 * 不碰。一次 readdir + 每个候选一次连接,只在启动时跑,❌ 不常驻扫。返回清掉了几个。
 */
export async function sweepStaleRendezvousSocks(deps: RendezvousSweepDeps): Promise<number> {
  let names: string[]
  try {
    names = await deps.list(deps.dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (!RENDEZVOUS_FILE.test(name)) continue
    const path = join(deps.dir, name)
    try {
      const info = await deps.stat(path)
      if (!info.isSocket() || info.uid !== deps.uid || deps.now - info.mtimeMs < STALE_RENDEZVOUS_MIN_AGE_MS) continue
      if (await deps.listening(path)) continue
      await deps.remove(path)
      removed += 1
    } catch {
      // 别人的 / 刚被删 / 读不了:不碰
    }
  }
  return removed
}

/** 生产装配:真 tmpdir、真连接。win32 没有这回事(命名管道不留残骸)。 */
export async function sweepStaleRendezvousSocksNow(): Promise<number> {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return 0
  const { readdir, lstat } = await import('node:fs/promises')
  return sweepStaleRendezvousSocks({
    dir: tmpdir(),
    list: (dir) => readdir(dir),
    stat: (path) => lstat(path),
    listening: rendezvousListening,
    remove: (path) => unlink(path),
    uid: process.getuid(),
    now: Date.now(),
  })
}

/** 启动 claude TUI 时要加的环境变量(argv 一字不动 —— 覆盖 argv 会丢掉初始任务文本)。 */
export function claudeRendezvousEnv(
  sessionId: string,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  return {
    CLAUDE_BG_BACKEND: 'daemon',
    CLAUDE_BG_RENDEZVOUS_SOCK: claudeRendezvousSock(sessionId, platform),
  }
}

export type DeliveryOutcome =
  | {
      ok: true
      /** 只有 repaint-done 才能证明 reply 已被 daemon 解析。 */
      acknowledged: boolean
      /** UTF-8 bytes handed to the rendezvous socket (message text is never logged). */
      bytes?: number
    }
  | {
      ok: false
      error: string
      /** UTF-8 bytes prepared for the rendezvous socket before a write error, if any. */
      bytes?: number
      /** true = 已证实"整块没被解析"(被并发连接踢掉),调用方应当重发。 */
      kicked?: boolean
      /** The mapped session is no longer able to accept bytes; durable delivery should remain pending. */
      unavailable?: boolean
      /** 传输层连不上(连接错误既非被踢、也非对面没在听)—— ❌ 不得被读成会话不在线(#6110)。 */
      transport?: boolean
    }

/** 单测替身:替掉真 socket 往返。 */
export type RendezvousSend = (sockPath: string, text: string, wallMs: number) => Promise<DeliveryOutcome>

export const CLAUDE_DELIVERY_MAX_ATTEMPTS = 3
export const CLAUDE_RETRY_BACKOFF_MS = [250, 500] as const

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

class ClaudeSessionUnavailableError extends Error {}
/**
 * 就绪预算到点仍无 tools/list:与「不可用」不同,这是要响亮抛到每个入口的失败(spec delivery-routing #4896)。
 * `deliveryRejectedBeforeAdmission` 是给 outbox drain 看的结构标记:provider 一个字节都没收到,行该落 failed
 * 而不是停在 dispatching(❌ instanceof:会话页 bundle 与宿主 bundle 各自求值同一份源)。
 */
export class ClaudeSessionNotReadyError extends Error {
  readonly deliveryRejectedBeforeAdmission = true
}

/**
 * gugu MCP 就绪预算:#5033 实测 claude 起来后约 2s 才连 gugu MCP,取其 30 倍只为让「一直没就绪」显形
 * (❌ 不是 sleep、❌ 不重试)。到点转 overdue,在等的消息响亮失败;迟到的 tools/list 仍算就绪。
 */
export const CLAUDE_MCP_READY_BUDGET_MS = 60_000
/** 就绪信号的来源:装上 markReady,返回取消订阅。claude TUI 的来源 = GuguMcpHost.onToolsListed(该会话的 grant)。 */
export type ClaudeReadySource = (markReady: () => void) => () => void
/**
 * claude TUI 的就绪来源 = 这条会话的卡送出了 `tools/list`(`GuguMcpHost`)。
 * 接回 = 引擎没换:它可能在卡发出之后、这里登记之前就已经 list 过(钩子在中间等平台票),那一刻没人在听 ⇒
 * 先读这张卡的状态,满足就当场就绪,❌ 干等下一次事件。新起的引擎此刻还没 spawn,只等事件。
 * 判据与沿用平台票同一个(`start === 'reattach'`,sessionpage-platform-hooks.ts)。
 */
export function toolsListedReadySource(
  host: { onToolsListed(key: string, listener: () => void): () => void; hasListedTools(key: string): boolean },
  grantKey: string,
  start: 'fresh' | 'reattach',
): ClaudeReadySource {
  return (markReady) => {
    const release = host.onToolsListed(grantKey, markReady)
    if (start === 'reattach' && host.hasListedTools(grantKey)) markReady()
    return release
  }
}
export type ClaudeSessionReadiness = 'awaiting' | 'ready' | 'overdue'
export interface ClaudeSessionLiveHooks {
  /** 会话转为可投递就绪(spec delivery-routing「session-live 的产地」):宿主在这里踢读者 + 排 outbox。 */
  onLive: (registration: ClaudeSessionRegistration) => void
  /** 预算到点仍未就绪:宿主在这里让两份账本上在等的消息响亮失败。 */
  onOverdue: (registration: ClaudeSessionRegistration, detail: { budgetMs: number }) => void
}

/** daemon 在新连接到来时 destroy 旧连接,而我们的 chunk 还没被读走 ⇒ 已证实整块丢失,重发是安全的。 */
const RENDEZVOUS_KICKED_CODES = new Set(['ECONNRESET', 'EPIPE'])
/**
 * 「对面确实没在听」的**封闭**集合 —— 只有这两个配让上层把会话判成不可投递(not-live:保留债务、不响亮)。
 * 其余连接错误一律是**传输层连不上**,必须以传输失败自己的面孔抛出(#6110):EACCES 从前落进
 * 「既不 kicked 也不 unavailable」的缝里,报出去的却是「目标不在线」,于是排查一直在查就绪门,
 * 而真正的原因是宿主(Node)根本连不上那条通道。
 * ❌ 往这个集合里添 code 之前先回答:它真的能证明对面没在听吗?证明不了就不属于这里。
 */
const RENDEZVOUS_PEER_ABSENT_CODES = new Set(['ENOENT', 'ECONNREFUSED'])

/** 连接错误的三分类。`transport` 是那条「连不上 ≠ 不在线」的判决,判据直接读它。 */
export type RendezvousErrorClass = {
  /** 已证实整块没被解析(被并发连接踢掉)→ 可重发。 */
  kicked: boolean
  /** 对面没在听 → 会话不可投递,债务由上层保留。 */
  unavailable: boolean
  /** 传输层连不上 —— 既不重发也❌不冒充 not-live,原样响亮抛出。 */
  transport: boolean
}

export function classifyRendezvousError(code: string): RendezvousErrorClass {
  const kicked = RENDEZVOUS_KICKED_CODES.has(code)
  const unavailable = RENDEZVOUS_PEER_ABSENT_CODES.has(code)
  return { kicked, unavailable, transport: !kicked && !unavailable }
}

const realSend: RendezvousSend = (sockPath, text, wallMs) =>
  new Promise((resolve) => {
    let settled = false
    let conn: ReturnType<typeof createConnection> | null = null
    let bytesWritten = 0
    const done = (outcome: DeliveryOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(wall)
      try {
        conn?.destroy()
      } catch {
        /* 已经没了 */
      }
      resolve({ ...outcome, bytes: bytesWritten })
    }
    // 墙钟到点而连接仍开着 = 对方可能忙,但没有 repaint-done 就不能冒称确认送达。
    // 此时重发也不安全:reply 可能已经被解析,只是确认迟到。
    const wall = setTimeout(() => done({ ok: true, acknowledged: false }), wallMs)
    try {
      conn = createConnection({ path: sockPath })
    } catch (error) {
      done({ ok: false, error: `连接 rendezvous socket 抛错:${String(error)}` })
      return
    }
    conn.on('error', (error: NodeJS.ErrnoException) => {
      const code = error?.code ?? String(error)
      const { kicked, unavailable, transport } = classifyRendezvousError(code)
      done({
        ok: false,
        kicked,
        unavailable,
        transport,
        error: transport
          // fail loud:说清这是**传输层**连不上,而不是让它顶着「会话不在线」那张脸出去(#6110)。
          ? `连不上 rendezvous 通道(${code}:${sockPath})—— 这是传输层连不上,不是「会话不在线」;`
            + `消息没有送达。Windows 上这条通道必须是命名管道(${CLAUDE_WIN_RENDEZVOUS_PIPE_PREFIX}…),`
            + '对着 unix socket 文件 connect 必得 EACCES'
          : `rendezvous socket 出错(${code})—— 消息没有送达`,
      })
    })
    conn.on('close', () =>
      done({ ok: false, kicked: true, error: 'daemon 解析这条消息之前连接就断了(被并发连接踢掉)—— 没有送达' }),
    )
    // 一次写入 = 一个 chunk:reply 与 repaint 不可分割(见文件头 ②)
    conn.on('connect', () =>
      (() => {
        const payload = `${JSON.stringify({ type: 'reply', text })}\n${JSON.stringify({ type: 'repaint' })}\n`
        bytesWritten = Buffer.byteLength(payload, 'utf8')
        conn?.write(payload)
      })(),
    )
    let buf = ''
    conn.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let nl = buf.indexOf('\n')
      while (nl >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        nl = buf.indexOf('\n')
        let type = ''
        try {
          type = (JSON.parse(line) as { type?: string })?.type ?? ''
        } catch {
          continue // 心跳/状态行等非 JSON 或无关行,忽略
        }
        if (type === 'repaint-done') return done({ ok: true, acknowledged: true })
        if (type === 'reply-rejected' || type === 'auth-rejected') {
          return done({ ok: false, error: `daemon 拒收这条消息(${type})—— 没有送达` })
        }
        if (type === 'shutting-down') {
          return done({ ok: false, unavailable: true, error: 'agent 正在退出 —— 没有送达' })
        }
      }
    })
  })

class ClaudeSessionDeliveryRegistry {
  readonly deliveryTargetName = 'claude-session'
  readonly deliveryToolNames = resolveSessionTuiDeliveryToolNames('claude')
  private readonly byAgent = new Map<string, ClaudeSessionRegistration>()
  private readonly bySession = new Map<string, ClaudeSessionRegistration>()
  /**
   * 就绪门(#4896):登记 ≠ 可投递。登记发生在 claude 进程 spawn 之前,socket 出现也早于它连上 gugu MCP;
   * 只有该会话的 gugu MCP 送出 tools/list 才是 live 转换。在这之前每次注入判 not-live(读者游标不动,
   * `session_message` 得 SESSION_DIRECT_NOT_LIVE,outbox 行保持 pending),❌ 不写 socket、❌ 不排队等。
   */
  private readonly readiness = new Map<string, ReadinessEntry>()
  private liveHooks: ClaudeSessionLiveHooks | null = null
  private sendImpl: RendezvousSend = realSend
  /** gugu MCP 就绪预算(tools/list 未到就转 overdue,响亮);单测可调。 */
  readyBudgetMs = CLAUDE_MCP_READY_BUDGET_MS
  /** 一次写入等 `repaint-done` 的墙钟。到点仍连着 = 已入通道但未确认,不重发。 */
  wallMs = 10_000
  /** 被踢是已证实的整块丢失 → 重发;有界,耗尽即响亮失败。 */
  attempts = CLAUDE_DELIVERY_MAX_ATTEMPTS

  /** 单测注入用。 */
  setSend(impl: RendezvousSend | null): void {
    this.sendImpl = impl ?? realSend
  }

  /** 宿主在启动时装一次:live 转换与预算到点各做什么归宿主,本注册表只报事实。 */
  setLiveHooks(hooks: ClaudeSessionLiveHooks | null): void {
    this.liveHooks = hooks
  }

  readinessOf(sessionId: string): ClaudeSessionReadiness | null {
    return this.readiness.get(sessionId)?.state ?? null
  }

  /** Resolve only after this generation's tools/list admission signal has promoted it to live. */
  waitUntilReady(sessionId: string): Promise<void> {
    const entry = this.readiness.get(sessionId)
    if (!entry) {
      return Promise.reject(new ClaudeSessionNotReadyError(
        `[sessionpage] claude 会话 ${sessionId} 没有就绪登记(重开没有建立新的投递代际)`,
      ))
    }
    if (entry.state === 'ready') return Promise.resolve()
    if (entry.state === 'overdue') return Promise.reject(this.readinessTimeoutError(sessionId))
    return new Promise((resolve, reject) => {
      entry.waiters.push({ resolve, reject })
    })
  }

  register(reg: ClaudeSessionRegistration, options: { readySource: ClaudeReadySource }): void {
    if (!reg.guguAgentUserId || !reg.sessionId || !reg.cwd || !reg.providerId) {
      throw new Error('[sessionpage] claude 投递登记缺字段(agent / sessionId / cwd / providerId 必须齐全)')
    }
    if (typeof options?.readySource !== 'function') {
      throw new Error('[sessionpage] claude 投递登记缺就绪来源(readySource)—— 没有它这条会话永远不会转 live')
    }
    const previousByAgent = this.byAgent.get(reg.guguAgentUserId)
    if (previousByAgent && previousByAgent.sessionId !== reg.sessionId) {
      this.bySession.delete(previousByAgent.sessionId)
      this.clearReadiness(previousByAgent.sessionId)
    }
    const previousBySession = this.bySession.get(reg.sessionId)
    if (previousBySession && previousBySession.guguAgentUserId !== reg.guguAgentUserId) {
      this.byAgent.delete(previousBySession.guguAgentUserId)
    }
    this.byAgent.set(reg.guguAgentUserId, reg)
    this.bySession.set(reg.sessionId, reg)
    // 重新登记(resume / 重开)从头计预算:上一段进程的就绪不代表这一段的。
    this.clearReadiness(reg.sessionId)
    const entry: ReadinessEntry = { state: 'awaiting', deadline: null, release: null, waiters: [] }
    this.readiness.set(reg.sessionId, entry)
    entry.deadline = setTimeout(() => this.markOverdue(reg.sessionId), this.readyBudgetMs)
    entry.deadline.unref?.()
    entry.release = options.readySource(() => this.markReady(reg.sessionId))
  }

  /** 就绪事实到达(该会话的 gugu MCP 送出 tools/list)。幂等;迟到(overdue 后)仍算就绪并照常转 live。 */
  markReady(sessionId: string): void {
    const entry = this.readiness.get(sessionId)
    const reg = this.bySession.get(sessionId)
    if (!entry || !reg) return // 已 teardown:迟到的事实没有会话可转
    if (entry.state === 'ready') return
    const late = entry.state === 'overdue'
    entry.state = 'ready'
    if (entry.deadline) clearTimeout(entry.deadline)
    entry.deadline = null
    for (const waiter of entry.waiters.splice(0)) waiter.resolve()
    const fields = { sessionId, agentUserId: reg.guguAgentUserId, late }
    if (late) readinessLog().warn(fields, 'claude 会话 gugu MCP 已就绪(tools/list),迟于预算 —— 转 live')
    else readinessLog().info(fields, 'claude 会话 gugu MCP 已就绪(tools/list)—— 转 live')
    this.liveHooks?.onLive(reg)
  }

  private markOverdue(sessionId: string): void {
    const entry = this.readiness.get(sessionId)
    const reg = this.bySession.get(sessionId)
    if (!entry || !reg || entry.state !== 'awaiting') return
    entry.state = 'overdue'
    entry.deadline = null
    const error = this.readinessTimeoutError(sessionId)
    for (const waiter of entry.waiters.splice(0)) waiter.reject(error)
    // 只报事实给宿主;那一条 error 日志由宿主的 onOverdue 落(❌ 同一事件两处各记一条)。
    this.liveHooks?.onOverdue(reg, { budgetMs: this.readyBudgetMs })
  }

  private readinessTimeoutError(sessionId: string): ClaudeSessionNotReadyError {
    return new ClaudeSessionNotReadyError(
      `[sessionpage] claude 会话 ${sessionId} 的 gugu MCP 在 ${this.readyBudgetMs}ms 内没有就绪`
        + '(宿主没为它送出过 tools/list)—— 消息未投递。请看该终端:它是否连上了 gugu MCP、是否停在登录/信任提示',
    )
  }

  private clearReadiness(sessionId: string): void {
    const entry = this.readiness.get(sessionId)
    if (!entry) return
    if (entry.deadline) clearTimeout(entry.deadline)
    try {
      entry.release?.()
    } catch (error) {
      readinessLog().warn({ sessionId, err: error instanceof Error ? error.message : String(error) }, 'claude 会话就绪订阅取消失败')
    }
    const error = new ClaudeSessionNotReadyError(
      `[sessionpage] claude 会话 ${sessionId} 的就绪登记已取消(这一代不再可投递)`,
    )
    for (const waiter of entry.waiters.splice(0)) waiter.reject(error)
    this.readiness.delete(sessionId)
  }

  /** 注入时机声明按这条会话上那家 harness 的 descriptor 查(spec session-injection)。 */
  sessionProviderSurface(
    sessionId: string,
  ): { providerId: string; surface: 'tui' } | null {
    const reg = this.bySession.get(sessionId)
    return reg ? { providerId: reg.providerId, surface: 'tui' } : null
  }

  /** 会话真的结束了 → 摘掉登记(下次投递会响亮失败,而不是投给一个死会话)。 */
  teardown(
    sessionId: string,
    replaceAfterRelease?: (registration: ClaudeSessionRegistration) => void,
  ): void {
    const reg = this.bySession.get(sessionId)
    if (!reg) return
    this.bySession.delete(sessionId)
    this.byAgent.delete(reg.guguAgentUserId)
    this.clearReadiness(sessionId)
    replaceAfterRelease?.(reg)
  }

  unregisterAgent(guguAgentUserId: string, onReleased?: () => void): void {
    const reg = this.byAgent.get(guguAgentUserId)
    if (reg) {
      this.byAgent.delete(guguAgentUserId)
      if (this.bySession.get(reg.sessionId) === reg) {
        this.bySession.delete(reg.sessionId)
        this.clearReadiness(reg.sessionId)
      }
    }
    // 释放契约:恰好一次,在同步移除点(未持有则立即)。rendezvous socket 的生命周期归会话进程
    // 自己,这里没有 transport 处置 —— 释放就是同步的。
    onReleased?.()
  }

  /** Owner 交接编排的同步释放点(与 unregisterAgent 同一动作:本注册表没有异步处置)。 */
  releaseAgentClaim(guguAgentUserId: string): void {
    this.unregisterAgent(guguAgentUserId)
  }

  chatIdForAgent(guguAgentUserId: string): string | null {
    return this.byAgent.get(guguAgentUserId)?.chatId ?? null
  }

  /** 非 null = 这个 agent 是我(claude TUI 会话)的,投递归我。 */
  liveSessionIdByAgent(guguAgentUserId: string): string | null {
    return this.byAgent.get(guguAgentUserId)?.sessionId ?? null
  }

  deliveryKeyForSession(sessionId: string): string | null {
    return this.bySession.has(sessionId) ? sessionId : null
  }

  async tryInjectSessionMessage(
    sessionId: string,
    message: { id: string; text: string; kind?: 'ordinary' | 'session-direct' },
  ): Promise<boolean> {
    return this.tryInjectMessage(sessionId, message.text)
  }


  async injectMessage(sessionId: string, text: string): Promise<void> {
    const reg = this.bySession.get(sessionId)
    if (!reg) {
      throw new ClaudeSessionUnavailableError(
        `[sessionpage] claude 会话 ${sessionId} 没有投递登记(会话已结束?)—— 拒绝投递(fail-loud)`,
      )
    }
    const readiness = this.readiness.get(sessionId)?.state ?? null
    if (readiness === 'awaiting') {
      throw new ClaudeSessionUnavailableError(
        `[sessionpage] claude 会话 ${sessionId} 的 gugu MCP 尚未就绪(还没收到 tools/list)—— 本次判 not-live,就绪转 live 时再拉`,
      )
    }
    if (readiness === 'overdue') {
      // 只说观测到的事实(没收到这条会话的 tools/list),❌ 不替它断言成因:claude 还没连上 gugu MCP、停在登录/信任
      // 提示、或这是一次没有重新初始化 MCP 的重连(tmux reattach),从宿主这一侧同形。
      throw new ClaudeSessionNotReadyError(
        `[sessionpage] claude 会话 ${sessionId} 的 gugu MCP 在 ${this.readyBudgetMs}ms 内没有就绪`
          + '(宿主没为它送出过 tools/list)—— 消息未投递。请看该终端:它是否连上了 gugu MCP、是否停在登录/信任提示',
      )
    }
    // 「通道在不在」只由这一次 connect 判(ENOENT / ECONNREFUSED = 没人听 ⇒ not-live),❌ 先看 socket 文件:
    // 文件在不代表有人听,文件不在也只是另一种「没人听」,两份判据迟早对不上(#6992 清理那一侧就是 connect 判的)。
    const sock = claudeRendezvousSock(sessionId)
    let last: DeliveryOutcome = { ok: false, error: '未尝试' }
    let attempted = 0
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      attempted = attempt
      last = await this.sendImpl(sock, text, this.wallMs)
      if (last.ok) {
        const message = last.acknowledged
          ? `[sessionpage] claude 第 ${attempt} 次投递已确认送达(repaint-done):session=${sessionId}:bytes=${last.bytes ?? 0}`
          : `[sessionpage] claude 第 ${attempt} 次投递已写入通道(未确认送达):session=${sessionId}:bytes=${last.bytes ?? 0}`
        if (attempt > 1) console.warn(message)
        else console.log(message)
        return
      }
      console.warn(
        `[sessionpage] claude 第 ${attempt} 次投递尝试失败:session=${sessionId}:${last.error}`,
      )
      if (!last.kicked) break // 不是被踢 = 不可重试的失败
      const backoffMs = CLAUDE_RETRY_BACKOFF_MS[attempt - 1]
      if (backoffMs === undefined) break
      await wait(backoffMs)
    }
    const error = last.ok ? '未知原因' : last.error
    const message = `[sessionpage] claude 投递失败:session=${sessionId}:attempts=${attempted}:${error}`
    if (!last.ok && last.unavailable) throw new ClaudeSessionUnavailableError(message)
    throw new Error(message)
  }

  async tryInjectMessage(sessionId: string, text: string): Promise<boolean> {
    try {
      await this.injectMessage(sessionId, text)
      return true
    } catch (error) {
      if (error instanceof ClaudeSessionUnavailableError) return false
      throw error
    }
  }
}

export const claudeSessionDelivery = new ClaudeSessionDeliveryRegistry()
// spec session-injection「认领者是注册表」:rendezvous 认领者自注册,owner 编排与 router 从
// 注册表消费 —— 内核不再具名 import 这一家。
registerSessionpageDeliveryTarget(claudeSessionDelivery)
