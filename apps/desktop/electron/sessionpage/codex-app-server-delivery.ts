// @@@sessionpage TASKPAGE-FUSION — codex app-server 控制通道投递(TUI agent 路)。
//
// product spec ⑧ + owner #85/#86:给会话页 TUI agent 投递 DM 时,走 **agent 自身的控制通道**
// 把消息作为新一轮输入交付,**绝不 pty 注入**(pty 是人在终端里输入的通道,写它会撞死用户输入);
// live 通道错误 fail-loud、无兜底；已映射但会话不 live 时由上层记本机有序债务。两者都绝不回退 pty。
//
// codex 的控制通道 = 它原生的 **app-server**。Unix 使用 `unix://<sock>`，Windows 使用
// `ws://127.0.0.1:<port>`；两者都是路径 `/rpc` 的 WebSocket 端点(不是裸字节流!),客户端用 `ws` 连上后
// 发 JSON-RPC。可见的 `codex --remote <endpoint> resume <tid>`
// TUI 只是同一 endpoint 的另一个 WS 客户端、渲染同一 thread；投递客户端往同一 thread 注入一轮，
// 两不相撞、不碰 pty。
// 2026-07-24 在 MBP(npm codex 0.145)端到端证死(WS-over-unix 投一轮 → codex 回「暗号海鸥7号」)。
//
// 一个 TUI agent 会话 = 一个 `codex app-server --listen <endpoint>` 进程(持有会话)+ 一个 WS 投递客户端。
// 三件套:①起 app-server ②会话页后端的 pty 起 `codex --remote … resume <tid>`(remoteTuiArgs)③本模块
// 经 WS 投递(turn/start,忙时 turn/steer)。接进 delivery-bridge 与 provisioning 是上层接线,另见那两处。

import crypto from 'node:crypto'
import WebSocket from 'ws'
import { pluginRegistry, resolveSessionTuiDeliveryToolNames } from '@gugu/session-plugins/agents'
import { NodeExecutionContext, spawnOwnedChild, type OwnedChild } from '@gugu/session-core/exec'
import { harnessSelfUpdateLaunch, HarnessStartupError } from '@gugu/session-core/agents/plugins'
import {
  assertSessionRuntimeCompatible,
  SessionRuntimeCompatibilityError,
  versionProbeEnv,
} from '@main/core/agents/session-runtime-compatibility'
import { onErrorEvents, type SerializedError } from '@gugu/session-shared'
import { isSignInFailure } from '@gugu/session-core/acp'
import { loginShellPathDiagnosis } from '../shellPath'
import { execFile, type ChildProcess } from 'node:child_process'
import { statSync } from 'node:fs'
import { writeCodexModelCatalog } from '../runtime/codex-model-catalog.mjs'
import {
  deleteEnginePidfile,
  markEngineSpawned,
  writeEnginePidfile,
} from '../enginePidReap'
import {
  type SessionpageTurnReceipt,
  type SessionpageDeliveryTarget,
} from './session-injection'
import { registerSessionpageDeliveryTarget } from './sessionpage-delivery-owner-registry'
import type { TurnLifecycleEdge } from './turn-lifecycle-relay'
import {
  launchTmuxBackend,
  type TmuxBackend,
  type TmuxBackendDeps,
} from './tmux-backend'
import {
  appendCodexStderrTail,
  CodexAppServerExitedError,
  createCodexAppServerEndpoint,
  removeCodexAppServerEndpoint,
  resolveCodexAppServerSpawn,
  parseCodexAppServerEndpoint,
  waitForCodexAppServerEndpoint,
  waitForCodexAppServerEndpointWhileAlive,
  waitForCodexAppServerProcessClose,
  type CodexAppServerEndpoint
} from './codex-app-server-transport'
import { lastActionAtIso, pushRecentAction, recentActionList, type RecentActionEntry } from '../recentActionWindow'
import { createLogger } from '../lib/logger'
import {
  observeCodexFork,
  settleCodexForkObservation,
} from '@main/core/sessions/codex-fork-observer'

interface RpcMessage {
  id?: number
  error?: unknown
  result?: unknown
  method?: string
  params?: Record<string, unknown>
}

export type CodexTurnLifecycle = TurnLifecycleEdge

/**
 * #6264 终端(编程)会话的回合失败是不是「登录失效」—— 与聊天会话**同一条**判据(`isSignInFailure`),
 * 输入也同形:codex 桥把 `turn.error` 原样当 JSON-RPC 错误的 `data`,这里拿到的就是那一份 `turn.error`。
 * 用在哪一侧(自家登录 / 咕咕额度)由宿主判,这里只报事实。
 */
export function codexTurnSignInRequired(message: Pick<RpcMessage, 'method' | 'params'>): boolean {
  if (message.method !== 'turn/completed') return false
  const error = (message.params?.turn as { error?: unknown } | undefined)?.error
  if (!error || typeof error !== 'object' || Array.isArray(error)) return false
  const text = (error as { message?: unknown }).message
  return isSignInFailure({
    name: 'CodexTurnError',
    message: typeof text === 'string' ? text : '',
    data: error as SerializedError['data'],
  })
}

export interface CodexAppServerRuntimeOptions {
  platform?: NodeJS.Platform
  startupTimeoutMs?: number
  handshakeTimeoutMs?: number
  turnCompletionTimeoutMs?: number
  sessionId?: string
  onThreadIdChanged?: (threadId: string) => Promise<void>
  /**
   * #6264 这条会话的 TUI 住在 tmux 里时,app-server 也住进 tmux(会话名见 tmux-backend.backendSessionNameFor),
   * 活过宿主进程重启;缺席 = 照旧做宿主的子进程。只对 posix 生效。
   */
  tmuxBackendName?: string
  tmuxBackendDeps?: TmuxBackendDeps
  /** codex 给这条 thread 起了名(见 `observeThreadName`)。 */
  onThreadName?: (name: string) => void
}

const trackedCodexAppServerSessions = new Set<CodexAppServerSession>()
const deliveryLog = createLogger('sessionpage/codex-delivery')

// Long-running Codex turns stay valid, but a lost completion must not retain reply routing forever.
export const CODEX_TURN_COMPLETION_TIMEOUT_MS = 15 * 60_000
const CODEX_TURN_TEARDOWN_SETTLE_TIMEOUT_MS = 30_000

/**
 * Map app-server turn notifications onto the session backend's provider-neutral lifecycle.
 * `turn/completed.turn.status` 是闭合枚举:`interrupted` = 用户打断(被打断的 stop);认不出的状态抛。
 */
export function codexTurnLifecycle(
  message: Pick<RpcMessage, 'method' | 'params'>,
  threadId: string
): CodexTurnLifecycle | null {
  const params = message.params ?? {}
  if (params.threadId !== threadId) return null
  if (message.method === 'turn/started') return { type: 'start' }
  if (message.method !== 'turn/completed') return null

  const turn = params.turn as { status?: unknown } | undefined
  const status = typeof turn?.status === 'string' ? turn.status.toLowerCase() : ''
  if (status === 'failed' || status === 'error') return { type: 'error' }
  if (status === 'interrupted') return { type: 'stop', outcome: 'cancelled' }
  if (status === 'completed') return { type: 'stop' }
  throw new Error(
    `codex app-server turn/completed carries an unknown turn status: ${JSON.stringify(turn?.status ?? null)}`,
  )
}

/** app-server v2 `ThreadActiveFlag`(`thread/status/changed` 的 `status.activeFlags`)。 */
export type CodexWaitFlag = 'waitingOnApproval' | 'waitingOnUserInput'

const CODEX_WAIT_KIND: Readonly<Record<CodexWaitFlag, 'approval' | 'question'>> = {
  // 命令 / 改文件 / 权限的批准,以及 MCP elicitation(codex 把它也记在 waitingOnApproval 上)。
  waitingOnApproval: 'approval',
  // `item/tool/requestUserInput`:模型在问人(Plan 模式下的提问也走这条)。
  waitingOnUserInput: 'question',
}

const CODEX_THREAD_STATUS_TYPES: ReadonlySet<string> = new Set(['notLoaded', 'idle', 'systemError', 'active'])

/**
 * `thread/status/changed` → 等待边。批准与提问的请求本身也会发到这条投递连接,但不由它应答
 * (见 CodexRpcClient 里的反向请求分支);等待边按 `activeFlags` 快照之差出
 * (有待决批准 ⇒ `waitingOnApproval`,有待决提问 ⇒ `waitingOnUserInput`)。
 * 形状对不上就抛;返回 null = 这一帧不是本 thread 的状态变化。
 */
export function codexThreadWaitEdges(
  previous: ReadonlySet<CodexWaitFlag>,
  message: Pick<RpcMessage, 'method' | 'params'>,
  threadId: string,
): { flags: Set<CodexWaitFlag>; edges: TurnLifecycleEdge[] } | null {
  if (message.method !== 'thread/status/changed') return null
  const params = message.params ?? {}
  if (params.threadId !== threadId) return null
  const status = params.status
  if (!status || typeof status !== 'object') {
    throw new Error(`codex app-server thread/status/changed has no status object: ${JSON.stringify(status ?? null)}`)
  }
  const type = (status as { type?: unknown }).type
  if (typeof type !== 'string' || !CODEX_THREAD_STATUS_TYPES.has(type)) {
    throw new Error(`codex app-server thread/status/changed carries an unknown status type: ${JSON.stringify(type ?? null)}`)
  }
  const flags = new Set<CodexWaitFlag>()
  if (type === 'active') {
    const activeFlags = (status as { activeFlags?: unknown }).activeFlags
    if (!Array.isArray(activeFlags)) {
      throw new Error(`codex app-server thread/status/changed active status has no activeFlags array: ${JSON.stringify(activeFlags ?? null)}`)
    }
    for (const flag of activeFlags) {
      if (typeof flag !== 'string' || !Object.hasOwn(CODEX_WAIT_KIND, flag)) {
        throw new Error(`codex app-server thread/status/changed carries an unknown active flag: ${JSON.stringify(flag)}`)
      }
      flags.add(flag as CodexWaitFlag)
    }
  }
  const edges: TurnLifecycleEdge[] = []
  for (const flag of previous) {
    if (!flags.has(flag)) edges.push({ type: 'wait_resolved', waitId: flag })
  }
  for (const flag of flags) {
    if (!previous.has(flag)) edges.push({ type: 'wait', waitKind: CODEX_WAIT_KIND[flag], waitId: flag })
  }
  return { flags, edges }
}

/** `thread/name/updated` 带来的这条 thread 的新名字;别的消息、别的 thread、空名 ⇒ null。 */
export function codexThreadName(
  message: Pick<RpcMessage, 'method' | 'params'>,
  threadId: string
): string | null {
  if (message.method !== 'thread/name/updated') return null
  const params = message.params ?? {}
  if (params.threadId !== threadId) return null
  const name = typeof params.threadName === 'string' ? params.threadName.trim() : ''
  return name || null
}

export interface CodexForkStartedEvent {
  threadId: string
  forkedFromId: string
  parentThreadId: string | null
}

/** Extract a user-visible fork from the broadcast thread/started notification. */
export function codexForkStartedEvent(
  message: Pick<RpcMessage, 'method' | 'params'>,
): CodexForkStartedEvent | null {
  if (message.method !== 'thread/started') return null
  const thread = message.params?.thread
  if (!thread || typeof thread !== 'object') return null
  const record = thread as Record<string, unknown>
  const threadId = typeof record.id === 'string' ? record.id : null
  const forkedFromId = typeof record.forkedFromId === 'string'
    ? record.forkedFromId
    : typeof record.forked_from_id === 'string'
      ? record.forked_from_id
      : null
  const parentThreadId = typeof record.parentThreadId === 'string'
    ? record.parentThreadId
    : typeof record.parent_thread_id === 'string'
      ? record.parent_thread_id
      : null
  if (!threadId || !forkedFromId) return null
  return { threadId, forkedFromId, parentThreadId }
}

/**
 * @@@6112 广播里那条「TUI 自己新建的」thread —— 既不是 fork,也不是 subagent。
 *
 * 判据是**两个血缘字段都空**:`forkedFromId` 有值 = 用户在 TUI 里 rewind 派生出来的分支
 * (那条归 codexForkStartedEvent 管),`parentThreadId` 有值 = subagent 的归属边(它永远不许
 * 顶替产品会话的活动 thread)。两者都空才是「这条 app-server 上刚出生的一条新会话」。
 *
 * 一条会话一个 app-server 进程,所以这条广播在本进程内唯一 —— 不必再按别的字段认领。
 */
export function codexPlainThreadStartedId(
  message: Pick<RpcMessage, 'method' | 'params'>,
): string | null {
  if (message.method !== 'thread/started') return null
  const thread = message.params?.thread
  if (!thread || typeof thread !== 'object') return null
  const record = thread as Record<string, unknown>
  const threadId = typeof record.id === 'string' ? record.id : null
  if (!threadId) return null
  const hasLineage = ['forkedFromId', 'forked_from_id', 'parentThreadId', 'parent_thread_id']
    .some((key) => typeof record[key] === 'string' && record[key])
  return hasLineage ? null : threadId
}

function threadTurns(value: unknown): Array<{ id?: unknown }> | null {
  const response = value && typeof value === 'object' ? value as Record<string, unknown> : null
  const thread = response?.thread && typeof response.thread === 'object'
    ? response.thread as Record<string, unknown>
    : response
  if (!thread || !Array.isArray(thread.turns)) return null
  return thread.turns as Array<{ id?: unknown }>
}

/**
 * Rewind forks copy a strict history prefix, while an explicit `/fork` copies the source history
 * unchanged. A changed turn id at the same position also identifies a rewind after the edited
 * prompt has already been submitted.
 */
export function codexForkRewritesHistory(parent: unknown, child: unknown): boolean {
  const parentTurns = threadTurns(parent)
  const childTurns = threadTurns(child)
  if (!parentTurns || !childTurns) return false
  if (childTurns.length < parentTurns.length) return true
  return childTurns.some((turn, index) => {
    const parentId = parentTurns[index]?.id
    return typeof turn.id === 'string' && typeof parentId === 'string' && turn.id !== parentId
  })
}

/** Map a real app-server item start to the compact action name presence exposes. */
export function codexRecentActionFromEvent(
  message: Pick<RpcMessage, 'method' | 'params'>,
  threadId: string,
): string | null {
  if (message.method !== 'item/started') return null
  const params = message.params ?? {}
  if (typeof params.threadId === 'string' && params.threadId !== threadId) return null
  const item = params.item
  if (!item || typeof item !== 'object') return null
  const record = item as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : ''
  if (type === 'commandExecution') return 'Bash'
  if (type === 'fileChange') return 'Edit'
  if (type === 'webSearch') return 'Search'
  if (type === 'mcpToolCall') {
    const name = record.name ?? record.tool
    return typeof name === 'string' && name ? name : 'MCP'
  }
  if (type === 'agentMessage' || type === 'reasoning' || type === 'contextCompaction') return null
  const name = record.name ?? record.title
  return typeof name === 'string' && name ? name : null
}

export type CodexTurnCompletionStatus = 'completed' | 'failed' | 'unknown'

/** Read only the exact persisted turn from a thread/read response. */
function codexTurnFromThread(value: unknown, threadId: string, turnId: string) {
  const envelope = value as { thread?: unknown } | null
  const thread = envelope && typeof envelope === 'object' && envelope.thread !== undefined
    ? envelope.thread
    : value
  if (!thread || typeof thread !== 'object') return undefined
  const record = thread as { id?: unknown; turns?: unknown }
  if (record.id !== threadId || !Array.isArray(record.turns)) return undefined
  return record.turns.find((candidate) => {
    if (!candidate || typeof candidate !== 'object') return false
    return (candidate as { id?: unknown }).id === turnId
  }) as { status?: unknown; error?: { message?: unknown } } | undefined
}

export function codexTurnCompletionStatus(
  value: unknown,
  threadId: string,
  turnId: string,
): CodexTurnCompletionStatus {
  const turn = codexTurnFromThread(value, threadId, turnId)
  if (!turn) return 'unknown'
  const status = typeof turn.status === 'string' ? turn.status.toLowerCase() : ''
  if (status === 'failed' || status === 'error') return 'failed'
  if (status === 'completed' || status === 'interrupted') return 'completed'
  return 'unknown'
}

function codexTurnFailureMessage(value: unknown): string | null {
  const turn = value as { error?: { message?: unknown } } | undefined
  return typeof turn?.error?.message === 'string' ? turn.error.message : null
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

/** codex 本轮回复(steer 的 expectedTurnId 前置、interrupt 用)。 */
/** 会话被关闭(dispose)导致的失败 —— 调用方据此区分「会话收掉了」与「真出错了」,❌ 不靠比对报错文案。 */
export class CodexSessionClosedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexSessionClosedError'
  }
}

export interface CodexTurnRef {
  /** 起了/插进了一轮 → 该轮 id;queued → codex 队列里那条 submission 的 id(准入身份,不是轮 id)。 */
  turnId: string
  /** @@@6112 交给 codex 自己的队列(`thread/queue/add`),由服务端在 thread 空闲时起轮。 */
  queued?: boolean
  /**
   * queued 时:这一条真正起成的那一轮的 id。以 codex 的 `item/started`(userMessage.clientId =
   * 入队时给的 clientUserMessageId)为准 —— 服务端的事实,❌ 不按时间猜。会话关闭 / 传输断开 → reject。
   */
  dispatched?: Promise<string>
}

type TurnCompletionWaiter = {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class CodexTurnCompletionTracker {
  private readonly waiters = new Map<string, TurnCompletionWaiter>()
  private readonly completedBeforeWait = new Map<string, Error | null>()
  /** turnId → 它被宣告 start 的时刻。存时刻而不只是 id,是为了让「在飞」有一个上界(见 isActive)。 */
  private readonly activeTurnIds = new Map<string, number>()

  constructor(private readonly timeoutMs = CODEX_TURN_COMPLETION_TIMEOUT_MS) {}

  start(turnId: string): void {
    if (turnId) this.activeTurnIds.set(turnId, Date.now())
  }

  // @@@in-flight-upper-bound (#3961) — 「在飞」必须有上界,超过完成预算就不再算在飞。
  //
  // 为什么非有不可:start() 挂在**通知处理器**上,app-server 宣告的每个回合都会进来,包括用户在可见
  // TUI 里自己敲的那些;而建定时器的 timeout() 只在 wait() 里挂,wait() 只走 gugu 自己注入的那条路。
  // ⇒ 一个「被 start 过、没人 wait」的回合,若它的 stop/error 通知丢了,就永远留在这个集合里。
  // 从前这只是账本泄漏(它只让 presence sweep 跳过这个 agent,权威行停在 idle,UI 侧照常自愈);
  // 现在 presence 直接跟着 isActive 走,没有上界就等于把一次丢失的结算通知变成一个**永不消失、
  // 且有权威背书**的「运行中」—— 那正是这次修复要消灭的东西,不能由它自己再造一个。
  //
  // 上界复用本 tracker 自己的完成预算:超过它还没结算,按本模块的契约就是「没在预算内完成」。
  isActive(): boolean {
    const cutoff = Date.now() - this.timeoutMs
    for (const [turnId, startedAt] of this.activeTurnIds) {
      if (startedAt <= cutoff) {
        this.activeTurnIds.delete(turnId)
      }
    }
    return this.activeTurnIds.size > 0
  }

  hasPendingTurn(): boolean {
    return this.activeTurnIds.size > 0 || this.waiters.size > 0
  }

  activeTurnIdsSnapshot(): string[] {
    this.isActive()
    return [...this.activeTurnIds.keys()]
  }

  /**
   * A suspended host advances wall clock while this process cannot observe the
   * provider. Re-arm the bounded waiter after the host resumes so suspension
   * time is not misclassified as a lost turn/completed notification.
   */
  resume(): void {
    const resumedAt = Date.now()
    for (const turnId of this.activeTurnIds.keys()) this.activeTurnIds.set(turnId, resumedAt)
    for (const [turnId, waiter] of this.waiters) {
      clearTimeout(waiter.timer)
      waiter.timer = this.timeout(turnId, waiter.reject)
    }
  }

  wait(turnId: string): Promise<void> {
    if (!turnId) return Promise.reject(new Error('codex app-server returned an empty turn id'))
    if (this.completedBeforeWait.has(turnId)) {
      const error = this.completedBeforeWait.get(turnId)
      this.completedBeforeWait.delete(turnId)
      return error ? Promise.reject(error) : Promise.resolve()
    }
    const existing = this.waiters.get(turnId)
    if (existing) {
      clearTimeout(existing.timer)
      existing.timer = this.timeout(turnId, existing.reject)
      return existing.promise
    }
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    const waiter: TurnCompletionWaiter = {
      promise,
      resolve,
      reject,
      timer: this.timeout(turnId, reject),
    }
    this.waiters.set(turnId, waiter)
    return promise
  }

  complete(turnId: string, error?: Error): void {
    this.activeTurnIds.delete(turnId)
    const waiter = this.waiters.get(turnId)
    if (waiter) {
      this.waiters.delete(turnId)
      clearTimeout(waiter.timer)
      if (error) waiter.reject(error)
      else waiter.resolve()
      return
    }
    this.completedBeforeWait.set(turnId, error ?? null)
    if (this.completedBeforeWait.size > 32) {
      const oldest = this.completedBeforeWait.keys().next().value
      if (oldest) this.completedBeforeWait.delete(oldest)
    }
  }

  dispose(error = new Error('codex app-server session closed before turn/completed')): void {
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.waiters.clear()
    this.completedBeforeWait.clear()
    this.activeTurnIds.clear()
  }

  private timeout(turnId: string, reject: (error: Error) => void): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      if (!this.waiters.delete(turnId)) return
      this.activeTurnIds.delete(turnId)
      reject(new Error(
        `codex app-server turn ${turnId} did not emit turn/completed within ${this.timeoutMs}ms`,
      ))
    }, this.timeoutMs)
  }
}

type TurnStartWaiter = {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class CodexTurnStartTracker {
  private readonly waiters = new Map<string, TurnStartWaiter>()
  private readonly startedBeforeWait = new Set<string>()

  start(turnId: string): void {
    if (!turnId) return
    const waiter = this.waiters.get(turnId)
    if (waiter) {
      this.waiters.delete(turnId)
      clearTimeout(waiter.timer)
      waiter.resolve()
      return
    }
    this.startedBeforeWait.add(turnId)
    if (this.startedBeforeWait.size > 32) {
      const oldest = this.startedBeforeWait.keys().next().value
      if (oldest) this.startedBeforeWait.delete(oldest)
    }
  }

  wait(turnId: string, timeoutMs: number): Promise<void> {
    if (!turnId) return Promise.reject(new Error('codex app-server returned an empty turn id'))
    if (this.startedBeforeWait.delete(turnId)) return Promise.resolve()
    if (this.waiters.has(turnId)) {
      return Promise.reject(new Error(`codex app-server already has a turn/started waiter for ${turnId}`))
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.waiters.delete(turnId)) return
        reject(new Error(
          `codex app-server turn ${turnId} did not emit turn/started within ${timeoutMs}ms`,
        ))
      }, timeoutMs)
      this.waiters.set(turnId, { resolve, reject, timer })
    })
  }

  dispose(error = new Error('codex app-server session closed before turn/started')): void {
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.waiters.clear()
    this.startedBeforeWait.clear()
  }
}

/** codex 回的 JSON-RPC 错:话是 codex 说的(#7103)。不改 `name`:打印与普通 Error 一样。导出只为测试。 */
export class CodexRpcReplyError extends Error {
  constructor(readonly reply: unknown) {
    super(JSON.stringify(reply))
  }

  /** codex 说的那一句:这个错的 message(没有就是 undefined)。 */
  get said(): string | undefined {
    const message = (this.reply as { message?: unknown } | null)?.message
    return typeof message === 'string' ? message.trim() || undefined : undefined
  }
}

/**
 * codex app-server 的 WebSocket JSON-RPC 客户端(端点 `/rpc`),用 `ws`:Unix 走 `ws+unix://<sock>:/rpc`,
 * Windows 走 loopback `ws://host:port/rpc`。握手、分帧、ping 都归 `ws`。全程 fail-loud:未连 / 会话死 / 超时都 THROW。
 */
export class CodexRpcClient {
  private socket: WebSocket | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly eventHandlers: Array<(m: RpcMessage) => void> = []
  onClose?: (error: Error) => void

  /** 连接 endpoint 的 `/rpc` 并完成升级握手。 */
  connect(endpoint: CodexAppServerEndpoint, timeoutMs = 15_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = endpoint.kind === 'unix' ? `ws+unix://${endpoint.socketPath}:/rpc` : `ws://${endpoint.host}:${endpoint.port}/rpc`
      // 与原手写客户端同一个握手:不协商压缩扩展。
      const socket = new WebSocket(url, { perMessageDeflate: false })
      this.socket = socket
      let settled = false
      const timer = setTimeout(() => {
        fail(new Error(`codex app-server WS 握手未在 ${timeoutMs}ms 内完成`))
        socket.terminate()
      }, timeoutMs)
      const fail = (e: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(e)
      }
      socket.on('error', (e) => fail(e instanceof Error ? e : new Error(String(e))))
      socket.on('unexpected-response', (_request, response) => {
        fail(new Error(`codex app-server WS 升级失败: HTTP ${response.statusCode}`))
        socket.terminate()
      })
      socket.on('close', () => {
        if (!settled) fail(new Error('codex app-server WS 连接在握手完成前关闭'))
        for (const p of this.pending.values())
          p.reject(new Error('codex app-server 连接已关闭(fail-loud)'))
        this.pending.clear()
        this.onClose?.(new Error('codex app-server control connection closed before turn/completed'))
      })
      socket.on('open', () => {
        settled = true
        clearTimeout(timer)
        resolve()
      })
      socket.on('message', (data, isBinary) => {
        if (!isBinary) this.onText(data.toString())
      })
    })
  }

  private send(message: unknown): void {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('codex app-server 未连接 — 无法发送(fail-loud,❌ 不回退 pty)')
    }
    socket.send(JSON.stringify(message))
  }

  private onText(s: string): void {
    for (const line of s.split('\n')) {
      if (!line.trim()) continue
      let msg: RpcMessage
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new CodexRpcReplyError(msg.error))
        else p.resolve(msg.result)
      } else if (msg.id !== undefined && msg.method !== undefined) {
        // codex 的【反向请求】(批准、问人……):这条投递连接一条都不答。app-server 把反向请求发给这个
        // thread 上**所有**订阅的连接,第一份应答算数(openai/codex@cd85a26cae00
        // `app-server/src/outgoing_message.rs` `send_request_to_connections`);同一个 thread 上挂着
        // `codex --remote` 那个终端客户端,由它画给人看、由它应答。抢答就是替人表态:#7035 实测这里对
        // `item/tool/requestUserInput` 回 -32601,codex 当场记下 `{"answers":{}}`,终端里的选择器根本没出现过。
        // 也❌ 交给 eventHandlers:它们不是事件。
      } else {
        for (const h of this.eventHandlers) h(msg)
      }
    }
  }

  rpc(method: string, params: unknown, timeoutMs = 20_000): Promise<unknown> {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error(`codex app-server 未就绪 — 无法 ${method}(fail-loud,❌ 不回退 pty)`)
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, { resolve, reject })
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`codex app-server ${method} 未在 ${timeoutMs}ms 内响应(fail-loud)`))
        }
      }, timeoutMs)
      const wrapped: Pending = {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      }
      this.pending.set(id, wrapped)
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  onEvent(h: (m: RpcMessage) => void): void {
    this.eventHandlers.push(h)
  }

  close(): void {
    this.socket?.terminate()
    this.socket = null
  }
}

/** thread/read 结果里挑一个 inProgress 的活跃 turn id(SpexCode `activeTurnIdFromThread`);无 → null。 */
function activeTurnIdFromThread(thread: unknown): string | null {
  const value = thread as { thread?: unknown } | null
  const record = value && typeof value === 'object' && value.thread !== undefined
    ? value.thread
    : thread
  const turns = (record as { turns?: Array<{ id?: string; status?: string }> })?.turns
  if (!Array.isArray(turns)) return null
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]
    if (t?.status === 'inProgress' && t.id) return t.id
  }
  return null
}

/**
 * Codex 拒绝 `thread/read(includeTurns=true)` 的两种说法 —— 与 `runtime/codex-app-server-acp.mjs`
 * 的 `threadReadTurnsRefusal` 同一条判据(两条路各有自己的 RPC 客户端,判据必须一起改):
 *
 *   · `not materialized yet` —— 首条用户消息之前,thread 还没落地。
 *   · `paginated threads do not support …` —— thread 一旦分页就**永远**不再支持(codex 0.145.0)。
 *
 * 两种都降级成「不知道有没有在飞的 turn」,❌ 不把整次投递打挂。错误报文两种形状都收:
 * 这一侧包成 JSON 串,另一侧是裸 message。
 */
function threadReadTurnsRefusal(error: unknown): 'unmaterialized' | 'paginated' | null {
  if (!(error instanceof Error)) return null
  let message = error.message
  try {
    const payload = JSON.parse(error.message) as { message?: unknown }
    if (typeof payload.message === 'string') message = payload.message
  } catch {
    // 裸 message,照原样判
  }
  if (!message.includes('includeTurns')) return null
  if (message.includes('not materialized yet')) return 'unmaterialized'
  if (message.includes('paginated')) return 'paginated'
  return null
}

interface CodexThreadRpc {
  rpc(method: string, params: unknown): Promise<unknown>
}

/**
 * initialize 的握手参数。
 *
 * `experimentalApi` 不是可选装饰:这里用到的 `thread/queue/add`、`thread/settings/update`、
 * `thread/backgroundTerminals/terminate` 在 codex 里都标着 `#[experimental]`
 * (`codex-rs/app-server-protocol/src/protocol/common.rs`),少了它会被 -32600 拒掉。
 *
 * 薄适配器(runtime/codex-app-server-acp.mjs)一直是这么握手的;这里与它对齐。
 */
export const CODEX_INITIALIZE_PARAMS = {
  clientInfo: { name: 'gugu', version: '0' },
  capabilities: { experimentalApi: true },
} as const

/** 关自更新的 argv(#6186):descriptor `selfUpdate` 的唯一读法,见 `harnessSelfUpdateLaunch`。 */
function codexSelfUpdateArgs(): readonly string[] {
  const codexPlugin = pluginRegistry.get('codex')
  if (!codexPlugin) throw new Error('Codex plugin is not registered; refusing to build the remote TUI argv')
  return harnessSelfUpdateLaunch(codexPlugin.capabilities.sessionBundle).args
}

/**
 * 从起 app-server 的那条 argv 里,按键取出要**同样**交给可见 TUI 的 `-c`(逐字原样,同键取最后一格 ——
 * 与 codex 自己「后给的 `-c` 覆盖先给的」一致;用户在设置里补的额外参数排在物化器之后,所以它赢)。
 */
export function codexArgvConfigPins(
  extraArgs: readonly string[] | undefined,
  keys: readonly string[],
): string[] {
  const picked = new Map<string, string>()
  const args = extraArgs ?? []
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] !== '-c' && args[index] !== '--config') continue
    const pair = String(args[index + 1] ?? '')
    // 按「键=」前缀认,❌ 不按第一个 `=` 切:键本身可以带引号里的 `=`(`projects."<路径>".trust_level`)。
    const key = keys.find((candidate) => pair.startsWith(`${candidate}=`))
    if (key) picked.set(key, pair)
    index += 1
  }
  return keys.flatMap((key) => {
    const pair = picked.get(key)
    return pair ? ['-c', pair] : []
  })
}

/**
 * 新建与重开都要让 TUI 看到的那几格:模型窗口,以及工作目录的**按次信任**。
 *
 * 信任(#6264):app-server 起在工作目录的按次信任上(`-c projects={…}`,写法见 codex 插件的
 * codexProjectTrustArgs),TUI 却没有 ——
 * 于是 TUI 一开就弹「Do you trust the contents of this directory?」,用户点「Yes」,codex 就把
 * `[projects."<cwd>"]` **写进用户自己的 `~/.codex/config.toml`**(d22 上那条
 * `[projects."/root/.config/咕咕/task-home"]` 就是这么来的;my-laptop 容器里 codex 0.153.4 实测复现)。
 * 这条会话的推理早已按咕咕给的信任在跑,TUI 这一问既多余又落盘 ⇒ 把**同一格**也给 TUI。
 */
function codexTuiSessionConfigArgs(extraArgs: readonly string[] | undefined): string[] {
  return codexArgvConfigPins(extraArgs, ['model_context_window', 'projects'])
}

const CODEX_DIRECT_ONLY_KEY = 'features.code_mode.direct_only_tool_namespaces'

/**
 * The namespaces code mode puts on the model's own tool list (the materializer's one list: gugu's, plus each App
 * listed up front — session-bundle.ts), pinned on the visible TUI as well. The TUI builds and loads the thread
 * itself (@@@6112), and a thread it builds does not get the app-server's process `-c`: without this pin every gugu
 * tool sits in the `exec` sandbox and the model answers that it has none (#6960 dropped it, 0.2.53-beta.55.1).
 * Encoded by the same rule as the app-server's copy (codexThreadConfigProcessArgs), so the two cannot drift.
 */
function codexTuiDirectOnlyArgs(threadConfig: Readonly<Record<string, unknown>> | undefined): string[] {
  const namespaces = threadConfig?.[CODEX_DIRECT_ONLY_KEY]
  return namespaces === undefined ? [] : codexThreadConfigProcessArgs({ threadConfig: { [CODEX_DIRECT_ONLY_KEY]: namespaces } })
}

/**
 * #6264 新会话的**模型选择**(模型 / 推理强度 / 服务档)翻成 TUI 自己的 `-c`。
 *
 * 为什么是 TUI:@@@6112 起新 thread 由 TUI 建,而远端 TUI 发 `thread/start` 时带的是**它自己配置**
 * 里的 `model` / `service_tier`,推理强度也经它的配置覆盖白名单一起带过去(codex
 * `tui/src/app_server_session.rs` 的 `thread_start_params_from_config` /
 * `config_request_overrides_from_config`,rust-v0.153.4)。服务端照单全收 —— app-server 进程级的
 * `-c model=` 只在请求**没带**模型时才轮得到。于是用户 `~/.codex/config.toml` 里的
 * `model = "gpt-6-astra"` 顶掉了 composer 上选的咕咕模型,中转 403「This token has no access to
 * model gpt-6-astra」(d22 实机,codex 0.153.4)。
 *
 * 官方给的优先级是「CLI `-c` > 用户 config.toml」(learn.chatgpt.com/docs/config-file/config-basic
 * #configuration-precedence),所以把**同一份**选择也钉给 TUI,它发出去的就是用户选的那个 ——
 * 平台模型与 harness 自家模型同一条路,❌ 不改用户的配置文件。
 * provider 不在此列:远端模式 TUI 不发 `model_provider`(同文件 `model_provider_from_config`
 * 的 `Remote => None`),由 app-server 自己的配置决定。
 * resume 不走这里:那一路钉的是 **thread 自己存的**模型(codexTuiThreadSettingsArgs)。
 */
export function codexTuiModelSelectionArgs(extraArgs: readonly string[] | undefined): string[] {
  return codexArgvConfigPins(extraArgs, ['model', 'model_reasoning_effort', 'service_tier'])
}

/**
 * This codex's own bundled catalog (`codex debug models --bundled`) — the platform catalog keeps codex's
 * entry for every model it already knows. Remembered per (binary, PATH, binary mtime) for the life of
 * this process: the answer only changes when the binary does, and every session start would otherwise
 * pay another codex launch. Failures are not remembered.
 */
const codexBundledCatalogs = new Map<string, Promise<string>>()

function codexBundledCatalog(
  codexBin: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  let mtime = ''
  try {
    mtime = String(statSync(codexBin).mtimeMs)
  } catch {
    // A bare name resolved through PATH: key on the name alone.
  }
  const key = [codexBin, env.PATH ?? '', mtime].join('\0')
  const cached = codexBundledCatalogs.get(key)
  if (cached) return cached
  const launch = resolveCodexAppServerSpawn(codexBin, ['debug', 'models', '--bundled'], platform, env)
  const read = new Promise<string>((resolve, reject) => {
    execFile(launch.command, launch.args, {
      env,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}${stderr ? `: ${String(stderr).trim()}` : ''}`))
      else resolve(stdout)
    })
  })
  codexBundledCatalogs.set(key, read)
  read.catch(() => codexBundledCatalogs.delete(key))
  return read
}

/**
 * @@@6112 新会话的权限(`thread/start` 的 `approvalPolicy` / `sandbox`,见 codex 插件的
 * codexThreadPermission)翻成 **TUI 自己的启动参数** `-a` / `-s`。
 *
 * 为什么是 TUI:thread 改由 TUI 新建,权限由**建 thread 的那一方**带上。实测(codex 0.155.1):
 *   · app-server 进程级 `-c approval_policy/sandbox_mode` 对 TUI 建的 thread **不生效**
 *     (thread 落成 on-request + workspaceWrite,用户选的 full-access 被悄悄换成默认档);
 *   · TUI 带 `-a never -s danger-full-access` 建的 thread → never + dangerFullAccess ✅。
 *   (`-a` / `-s` 是 codex TUI 的根级参数,见其 cli.rs。)
 * ⚠️ 认不出的键或非字符串值 **THROW**:悄悄丢掉一格 = 悄悄把这条会话的权限换成默认档。
 */
export function codexTuiPermissionArgs(threadStart?: Readonly<Record<string, unknown>>): string[] {
  const FLAGS: Readonly<Record<string, string>> = { approvalPolicy: '-a', sandbox: '-s' }
  const args: string[] = []
  for (const [key, value] of Object.entries(threadStart ?? {})) {
    if (value === undefined || value === null) continue
    const flag = FLAGS[key]
    if (!flag) {
      throw new Error(
        `codex thread/start 参数 ${key} 没有对应的 TUI 启动参数 —— 新会话由 TUI 新建,它会被整格丢掉。`
        + ' 要么补进 codexTuiPermissionArgs,要么这条路不该让 TUI 建 thread。❌ 不许静默降级。',
      )
    }
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`codex thread/start 参数 ${key} 不是非空字符串(收到 ${typeof value}),翻不成 TUI 的 ${flag}`)
    }
    args.push(flag, value)
  }
  return args
}

/**
 * @@@6112 TUI `resume` 载入 thread 时,把 **thread 自己存的**模型 / 推理强度钉给 TUI(`-c`)。
 *
 * 为什么:TUI 的 resume 请求会带上**它自己配置**里的模型与推理强度(推理强度见上面那份白名单),
 * 冷载入时服务端照单全收 —— 实测(codex 0.155.1):TUI 与 thread 同一个 model provider 时,
 * thread 的模型被换成用户 `~/.codex/config.toml` 的默认模型(GLM 会话被换成 gpt-6-astra,中转 403)。
 * 给 TUI 显式 `-c model=<thread 的模型>` 后,thread 保持原模型 ✅。权限不在此列:TUI 远端 resume
 * 拒绝带权限覆盖(「Permission overrides are not supported when resuming a remote task」)。
 * 数据来自 `thread/read`(不载入 thread,读盘上那份)—— 事实,❌ 不是从咕咕这边的配置推。
 * ⚠️ 读不到模型 **THROW**:缺了它,TUI 就会悄悄把会话换到默认模型。
 *
 * 这份钉子同时决定 **model provider**(#6372):请求里带了模型,服务端就当显式覆盖,整格跳过 thread
 * 存的模型与 provider,provider 取这台 app-server 进程自己的(`-c model_provider=…`)。于是 rollout 里
 * 记的 provider 已不在配置里的旧会话(导入的、换过计费路的)照样由 TUI 载入。实测(codex 0.153.0 /
 * 0.155.1,同一条旧 thread):TUI 不带这份 `-c` → `Model provider \`<旧名>\` not found`;带上 → 载入并对话。
 * ❌ 为了「修 provider」让咕咕先 `thread/resume` 替 TUI 载入:TUI 会变成中途加入,Esc-Esc 回退失效(#6112)。
 * ❌ 给 TUI 传 `-c model_provider`:TUI 本地配置里没有那条 provider 声明,当场报错;远端模式也不转发它。
 */
export function codexTuiThreadSettingsArgs(
  thread: { id?: string; model?: unknown; reasoningEffort?: unknown },
  /**
   * 这次起进程时**指定**的模型 / 推理强度(会话记录里的那一份:换模型重开、咕咕模型)。给了就钉它,
   * 没给才钉 thread 自己存的。❌ 一律钉 thread 的:换模型重开时 thread 里存的正是**旧**模型,
   * TUI resume 会把它带回去 —— app-server 连着咕咕网关、TUI 却请求旧模型,下一轮直接断流
   * (2026-09-23 实测:用户自己的 gpt-5.6-luna → 咕咕 GLM 5.3 Flash,`stream disconnected`)。
   */
  desired?: { model?: string | null; reasoningEffort?: string | null },
): string[] {
  const desiredModel = desired?.model?.trim()
  const desiredEffort = desired?.reasoningEffort?.trim()
  if (desiredModel) {
    // 记录里指定了模型 ⇒ 档位也只听记录:记录没档位 = 用户要 harness 默认(顶栏「思考」复位),
    // ❌ 不拿 thread 里存的旧档位补 —— 那会让复位之后跑的仍是上一档。
    const args = ['-c', `model=${JSON.stringify(desiredModel)}`]
    if (desiredEffort) args.push('-c', `model_reasoning_effort=${JSON.stringify(desiredEffort)}`)
    return args
  }
  if (typeof thread.model !== 'string' || !thread.model.trim()) {
    throw new Error(
      `codex thread/read 没给出 thread${thread.id ? ` ${thread.id}` : ''} 的模型 —— TUI resume 会把它换成用户 config.toml 的默认模型,拒绝继续(fail-loud)。`
        + '请重试恢复；若原记录已删除，请新开一个任务。',
    )
  }
  const args = ['-c', `model=${JSON.stringify(thread.model)}`]
  // 记录里给了档位(顶栏换过「思考」)就钉它,否则沿用 thread 自己那一档。
  const effort = desiredEffort
    || (typeof thread.reasoningEffort === 'string' ? thread.reasoningEffort.trim() : '')
  if (effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(effort)}`)
  return args
}

/**
 * @@@6112 把「本来挂在 `thread/start` 上的那份线程配置」翻成 app-server **进程级** `-c`。
 *
 * 为什么要搬:新会话改成让 TUI 自己建 thread(时序见 codex-pty-provisioning.ts 抬头),咕咕手上
 * 就没有 `thread/start` 那一刻可以挂配置了。实测(codex 0.155.1):
 *   · 进程级 `-c` 被该进程内创建的**每一条** thread 继承 —— 包括不是咕咕建的那条;
 *   · TUI 侧的 `-c` **到不了**远端:它只转发一个固定白名单(model_reasoning_effort /
 *     model_reasoning_summary / model_verbosity / personality / web_search /
 *     bypass_hook_trust,见 codex `tui/src/app_server_session.rs`
 *     `config_request_overrides_from_config`)。所以配置的唯一落点是起 app-server 的那条 argv。
 * 一条会话一个 app-server 进程(见本文件抬头),所以进程级配置天然是这条会话专用的,不串台。
 *
 * `threadConfig` 本来就是扁平的 dotted-path 映射(`mcp_servers.<名>.command` / `.args` /
 * `.env.<名>`),正好是 `-c key=value` 要的形状,不需要 TOML 内联表。
 *
 * ⚠️ 值只收标量与标量数组,其余 **THROW**:`-c` 的右半边按 TOML 解析,**解析失败就当裸字符串收下**
 * (codex 自己的 `CliConfigOverrides` 文档原话)。而 JSON 的对象写法 `{"a":1}` 不是合法 TOML 内联表
 * (`{a = 1}` 才是)—— 悄悄降级的结果是这条配置变成一个字符串字面量:不报错、不生效,和「没配」
 * 长得一模一样。❌ 不许静默。
 */
export function codexThreadConfigProcessArgs(opts: {
  developerInstructions?: string
  threadConfig?: Readonly<Record<string, unknown>>
  /**
   * `thread/start` 的权限载荷(`approvalPolicy` / `sandbox`,见 codex 插件的 codexThreadPermission)。
   *
   * 进程级这一份管的是 **TUI resume 载入**的 thread(重新打开 / 分叉)。实测(codex 0.155.1):
   * approval 随 thread 落盘,**sandbox 不落盘** —— 换一个 app-server 进程 resume,sandbox 取的是
   * 该进程的配置默认值(不带这一格就退回 workspaceWrite,用户选的 full-access 被悄悄换掉;带上则
   * 是 dangerFullAccess ✅)。TUI **新建**的 thread 不吃这一份(TUI 建 thread 时带的是它自己的权限),
   * 那一路走 TUI 的 `-a` / `-s`,见 codexTuiPermissionArgs。
   *
   * ⚠️ 认不出的键 **THROW**:悄悄丢掉一个 thread-start 参数 = 悄悄把这条会话的权限换成默认档。
   */
  threadStart?: Readonly<Record<string, unknown>>
}): string[] {
  const THREAD_START_CONFIG_KEYS: Readonly<Record<string, string>> = {
    approvalPolicy: 'approval_policy',
    sandbox: 'sandbox_mode',
  }
  const isScalar = (value: unknown): boolean =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
  const encode = (key: string, value: unknown): string => {
    if (isScalar(value)) return JSON.stringify(value)
    if (Array.isArray(value) && value.every(isScalar)) return JSON.stringify(value)
    throw new Error(
      `codex 线程配置 ${key} 翻不成进程级 -c:只支持标量与标量数组,收到 ${
        Array.isArray(value) ? 'array(含非标量)' : typeof value
      }。JSON 的对象写法不是合法 TOML 内联表,codex 会把它当裸字符串收下 —— 不报错也不生效。`,
    )
  }
  const args: string[] = []
  const developerInstructions = opts.developerInstructions?.trim()
  if (developerInstructions) {
    args.push('-c', `developer_instructions=${encode('developer_instructions', developerInstructions)}`)
  }
  for (const [key, value] of Object.entries(opts.threadConfig ?? {})) {
    if (value === undefined || value === null) continue
    args.push('-c', `${key}=${encode(key, value)}`)
  }
  for (const [key, value] of Object.entries(opts.threadStart ?? {})) {
    if (value === undefined || value === null) continue
    const configKey = THREAD_START_CONFIG_KEYS[key]
    if (!configKey) {
      throw new Error(
        `codex thread/start 参数 ${key} 没有对应的进程级配置键 —— tuiLoads 下它会被整格丢掉。`
        + ' 要么补进 THREAD_START_CONFIG_KEYS,要么这条路不该用 tuiLoads。❌ 不许静默降级。',
      )
    }
    args.push('-c', `${configKey}=${encode(configKey, value)}`)
  }
  return args
}

/** Start, resume, or fork an app-server thread without parsing CLI argv. */
export async function openCodexThread(
  client: CodexThreadRpc,
  cwd: string,
  forkFromThreadId?: string,
  resumeThreadId?: string,
  developerInstructions?: string,
  config?: Readonly<Record<string, unknown>>,
  threadStart?: Readonly<Record<string, unknown>>,
): Promise<string> {
  const method = forkFromThreadId
    ? 'thread/fork'
    : resumeThreadId
      ? 'thread/resume'
      : 'thread/start'
  // session-page Codex is exposed through a native remote TUI (`codex --remote`). That
  // client rejects model-level dynamic tools with "Dynamic tool calls are not
  // available in TUI yet." Do not declare an affordance this surface cannot execute;
  // the main-chat ACP adapter has its own supported declaration path.
  // Saved permissions belong to every thread-open operation. A resumed/forked
  // thread otherwise falls back to Codex defaults even while Gugu retains the tier.
  const params = forkFromThreadId
    ? {
        threadId: forkFromThreadId,
        cwd,
        ...(developerInstructions ? { developerInstructions } : {}),
        ...(config ? { config } : {}),
        ...(threadStart ? { ...threadStart } : {}),
      }
    : resumeThreadId
      ? {
          threadId: resumeThreadId,
          ...(config ? { config } : {}),
          ...(threadStart ? { ...threadStart } : {}),
        }
      : {
          cwd,
          ...(developerInstructions ? { developerInstructions } : {}),
          ...(config ? { config } : {}),
          ...(threadStart ? { ...threadStart } : {}),
        }
  const started = (await client.rpc(method, params)) as { thread: { id: string } }
  return started.thread.id
}

/**
 * ENOENT 时把「启动时的 PATH 补救到底成没成」一并说出来。
 *
 * 为什么:macOS GUI 起的 app 继承的是**最小 PATH**,codex 无论是 npm 装的 shim(要 node)
 * 还是 brew 装的原生二进制(在 /opt/homebrew/bin),都可能不在里面。产品启动时会跑
 * hydrateLoginShellPath() 去把登录 shell 的 PATH 取回来 —— 但它失败时只是如实返回一个
 * reason,没人读,于是用户只看见「找不到可执行文件」,真因一点痕迹都没有。
 *
 * ❌ 不在这里替用户猜路径:那是拿兜底盖症状,而且会把「PATH 坏了」永久藏起来。
 */
function describePathHydration(): string {
  const diagnosis = loginShellPathDiagnosis()
  if (!diagnosis) return 'PATH 补救:启动时未运行(hydrateLoginShellPath 没被调用过)。'
  if (diagnosis.hydrated) {
    return `PATH 补救:已生效。当时的 PATH=${diagnosis.path}`
  }
  const why = {
    windows: 'Windows 无登录 shell,走 ensureWindowsNpmGlobalBinInPath()',
    'probe-failed': '探测登录 shell 失败(shell 起不来或超时)',
    'invalid-output': '登录 shell 的输出里取不到 PATH(多半被 rc 文件的输出污染了)',
  }[diagnosis.reason]
  return `PATH 补救:**未生效** —— ${why}。所以 app 用的是 GUI 的最小 PATH,找不到 codex 是这一步的后果。`
}

/**
 * 起 app-server 那一段里,哪些失败是 codex 自己说的(#7103 谁拒绝谁说话):起 codex 本体时的系统错误(找不到、没权限)、
 * 它在就绪前自己退出、它回的 JSON-RPC 错、版本 / 运行时不兼容。等端点 / 握手超时一律算咕咕的 —— 咕咕先超时、再去拆
 * 进程,拆的时候 codex 打出来的那几行只进原文与日志;建端点目录、起 tmux 的系统错误也是咕咕的。
 */
function spokenByCodex(error: Error, codexBin: string): boolean {
  if (
    error instanceof CodexAppServerExitedError
    || error instanceof CodexRpcReplyError
    || error instanceof SessionRuntimeCompatibilityError
  ) return true
  const errno = error as NodeJS.ErrnoException
  return errno.syscall === `spawn ${codexBin}` || errno.path === codexBin
}

/**
 * 起步失败写成一段原文,codex 的 stderr 照旧全进(日志与 #2808 都要它)。是 codex 说的 ⇒ `HarnessStartupError`,
 * 第一行放它说的那句 —— 就绪前自己退出:它 stderr 的最后一行非空内容;回 JSON-RPC 错:那个错的 message
 * (❌ stderr:拆进程时会冒出「received SIGTERM」这类行)。界面只显示第一行,咕咕包的那句只进日志;
 * 不是 codex 说的 ⇒ 普通 Error,由起任务失败的分层说成「咕咕这边出错了」(#7103)。导出只为测试。
 */
export function describeCodexStartFailure(
  codexBin: string,
  cause: unknown,
  stderr: string,
  stderrCloseTimeoutMs?: number
): Error {
  const source = cause instanceof Error ? cause : new Error(String(cause))
  // 版本探针跑不起来时,系统错误码在探针记录里(`errno`);`code` 那一格是探针自己的分类。
  const code = source instanceof SessionRuntimeCompatibilityError
    ? source.probe?.errno ?? undefined
    : (source as NodeJS.ErrnoException).code
  const spoken = spokenByCodex(source, codexBin)
  const summary =
    spoken && code === 'ENOENT'
      ? `Codex app-server 启动失败：找不到可执行文件 "${codexBin}"。请安装 Codex CLI，确保桌面 App 的 PATH 能解析该路径，然后重试。\n${describePathHydration()}`
      : `Codex app-server 启动失败（${codexBin}）：${source.message}`
  const stderrTail = stderr.trim()
  const stderrDetails = stderrTail ? `Codex stderr:\n${stderrTail}` : ''
  const incompleteStderr = stderrCloseTimeoutMs === undefined
    ? ''
    : `Codex stderr 可能不完整：进程终止后等待 ${stderrCloseTimeoutMs}ms，输出流仍未关闭。`
  const message = [summary, stderrDetails, incompleteStderr].filter(Boolean).join('\n')
  const said = source instanceof CodexAppServerExitedError
    ? stderrTail.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1)
    : source instanceof CodexRpcReplyError ? source.said : undefined
  const wrapped = spoken
    ? new HarnessStartupError(said ? `${said}\n${message}` : message, { cause: source })
    : new Error(message, { cause: source })
  ;(wrapped as NodeJS.ErrnoException).code = code
  return wrapped
}

/**
 * 一个 codex app-server 会话的控制通道客户端。一个 TUI agent 会话 = 一个 `codex app-server --listen`
 * 进程(Unix socket 或 Windows loopback WebSocket)+ 一个 RPC 客户端。全程 fail-loud:未启动 / 会话死 /
 * 轮次超时都 THROW；只有会话已不 live 才由 registry 返回 false，让上层保留本机债务。
 */
export class CodexAppServerSession {
  private proc: ChildProcess | null = null
  /** #6264 app-server 住在 tmux 里时的那台(与 proc 二选一)。 */
  private backend: TmuxBackend | null = null
  private readonly tmuxBackendName: string | null
  private readonly tmuxBackendDeps: TmuxBackendDeps | undefined
  /** The app-server as an owned tree; `proc` is its root. */
  private appServer: OwnedChild | null = null
  private client: CodexRpcClient | null = null
  private endpoint: CodexAppServerEndpoint | null = null
  private cwd = ''
  private stderrTail = ''
  private readonly platform: NodeJS.Platform
  private readonly startupTimeoutMs: number
  private readonly handshakeTimeoutMs: number
  private readonly turnCompletions: CodexTurnCompletionTracker
  private readonly turnStarts = new CodexTurnStartTracker()
  private readonly onThreadIdChanged?: (threadId: string) => Promise<void>
  private readonly onThreadName?: CodexAppServerRuntimeOptions['onThreadName']
  private threadForkObservationQueue: Promise<void> = Promise.resolve()
  /** 新建与重开都给 TUI 的 `-c`:模型窗口 + 工作目录的按次信任(codexTuiSessionConfigArgs)+ 模型目录。 */
  private modelMetadataArgs: string[] = []
  /** 新建与重开都给 TUI 的 code mode 直接命名空间(codexTuiDirectOnlyArgs);resume 那条放进子命令里。 */
  private tuiDirectOnlyArgs: string[] = []
  /** The `model_catalog_json` file this session wrote for its app-server; removed on dispose. */
  private modelCatalog: Awaited<ReturnType<typeof writeCodexModelCatalog>> | null = null
  /** 这条 app-server 会话的会话键 —— 声明了产品 conversation 就是它,没声明就退化成 agentKey
   *  (pidfile 命名与 `belongsToSession` 的既有语义,一格不动)。 */
  readonly sessionId: string
  /**
   * 这条会话服务的**产品** conversation(会话页那条会话的 id),没声明就是 null。
   * @@@4629 它与上面那个的区别是 fail-loud 的分界:`liveSessionIdByAgent` 只认这一格 ——
   * 退化成 agentKey 的那个**不是** conversation id,拿它去查按 conversation 键控的本机 outbox
   * 会稳定查空,而那正是本次修的那类静默空手。
   */
  readonly productSessionId: string | null
  private readonly pidfileEnabled: boolean
  private recentActionWindow: RecentActionEntry[] = []
  private disposePromise: Promise<void> | null = null
  private terminalError: Error | null = null
  private pidfilePgid: number | null = null
  private pidfileWritePromise: Promise<void> | null = null
  private stderrCloseTimeoutMs: number | undefined
  private threadMaterialization: 'unmaterialized' | 'unknown' | 'materialized' = 'unknown'
  /** 这条 thread 已分页 ⇒ 从此拒绝 includeTurns 读法,别再问第二次。 */
  private threadRefusesTurnsRead = false
  /** = app-server thread.id = codex sessionId;上层据此派生可读代称 `codex_<尾8位>`。 */
  threadId: string | null = null
  /**
   * @@@6112 这条会话的 thread **由 TUI 创建**,咕咕在广播里认领(见 start() 的 `tuiLoads: 'create'`)。
   *
   * armed 期间 `threadId` 是 null,于是 `isLive()` 为假、投递被 fail-loud 挡回 —— 那正是对的:
   * TUI 还没把会话建出来,第一轮没有地方可投。等广播到了再投,见 `waitForTuiThread()`。
   */
  private awaitingTuiThread = false
  private tuiThreadWaiters: Array<{ resolve: (threadId: string) => void; reject: (error: unknown) => void }> = []
  /** 这条 thread 由 TUI 载入(新建或 resume)⇒ 咕咕这条连接要在它载入之后才接入,见 attachToAdoptedThread。 */
  private adoptedFromTui = false
  /** 咕咕接入 TUI 载入的 thread 的那一次按序动作;非 tuiLoads 模式恒为 null。 */
  private adoptedThreadAttached: Promise<void> | null = null
  /** threadId 到位(= 这条会话成为可投递的认领,见 registry.liveSessionIdByAgent)时要通知的人。 */
  private threadLiveListeners: Array<() => void> = []
  /**
   * @@@6112 tuiLoads='create':threadId 由 TUI 建出后,咕咕还要按序接入(attachToAdoptedThread)才算可投递。
   * 「可投递」信号(onThreadLive)等接入完成才发 —— 否则收件箱里的消息会排到用户第一句前面。
   */
  private liveAwaitsAttach = false
  /**
   * @@@6112 咕咕排进 codex 队列、还没起成轮的条目(clientUserMessageId → 条目)。起轮以 codex 的
   * `item/started` 为准;上一轮被中断后队列不自动续跑,咕咕只把**自己的**条目起起来(thread/queue/start)。
   */
  private queuedDeliveries = new Map<string, {
    submissionId: string | null
    resolve: (turnId: string) => void
    reject: (error: unknown) => void
  }>()
  /** tuiLoads='create':TUI 建 thread 时带的权限参数(`-a` / `-s`),见 codexTuiPermissionArgs。 */
  private tuiPermissionArgs: string[] = []
  /** #6264 新会话由 TUI 建 thread ⇒ 用户选的模型 / 推理强度也要钉给 TUI(见 codexTuiModelSelectionArgs)。 */
  private tuiModelSelectionArgs: string[] = []
  /** TUI `resume` 载入时钉住 thread 自己的模型 / 推理强度,见 codexTuiThreadSettingsArgs。 */
  private tuiResumeArgs: string[] = []
  /** tuiLoads='resume':已知 threadId,在等 TUI 把它载入(官方广播 thread/status/changed)。 */
  private awaitingTuiLoad = false
  /** 本 thread 上一份 activeFlags 快照,等待边按它求差。 */
  private waitFlags: ReadonlySet<CodexWaitFlag> = new Set()
  /** 接入动作的**显式**状态(❌ 不靠 race 去猜一个 promise 结没结 —— 那会把「失败」读成「未完成」)。 */
  private attachState: { kind: 'idle' | 'pending' | 'done' } | { kind: 'failed'; error: unknown } = { kind: 'idle' }

  constructor(
    private readonly agentKey: string,
    /** codex 可执行文件 —— 必传,且必须是会话页后端解析给这次会话的那个(见 CodexPtyStartInfo.baseCommand)。
     *  ❌ 别给默认值 `'codex'`:打包后 GUI 进程的 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`,一个静默的
     *  裸名默认值会在真机上变成 `spawn ENOENT`(claude 那条腿实机踩过)。 */
    private readonly codexBin: string,
    private readonly onTurnLifecycle?: (lifecycle: CodexTurnLifecycle) => void,
    runtimeOptions: CodexAppServerRuntimeOptions = {}
  ) {
    this.platform = runtimeOptions.platform ?? process.platform
    this.startupTimeoutMs = runtimeOptions.startupTimeoutMs ?? 15_000
    this.handshakeTimeoutMs = runtimeOptions.handshakeTimeoutMs ?? this.startupTimeoutMs
    this.turnCompletions = new CodexTurnCompletionTracker(runtimeOptions.turnCompletionTimeoutMs)
    this.onThreadIdChanged = runtimeOptions.onThreadIdChanged
    this.onThreadName = runtimeOptions.onThreadName
    this.sessionId = runtimeOptions.sessionId ?? agentKey
    this.productSessionId = runtimeOptions.sessionId ?? null
    this.pidfileEnabled = runtimeOptions.sessionId !== undefined
    this.tmuxBackendName = this.platform !== 'win32' ? runtimeOptions.tmuxBackendName ?? null : null
    this.tmuxBackendDeps = runtimeOptions.tmuxBackendDeps
  }

  /** 引擎进程还在:子进程看退出码,tmux 里那台看 pid(一次 kill(pid, 0))。 */
  private engineRunning(): boolean {
    if (this.backend) return this.backend.isAlive()
    return Boolean(this.proc && this.proc.exitCode === null && this.proc.signalCode == null)
  }

  /** #6264 这条会话的 app-server 住在 tmux 里(宿主退出只断开,不杀)。 */
  isTmuxHosted(): boolean {
    return this.backend !== null
  }

  /**
   * codex 的 TUI 给 thread 起名(0.150+:首条消息完成后开一条 ephemeral 标题线程拟名,再
   * `thread/name/set`;`/rename` 走同一个方法),app-server 把 `thread/name/updated` 广播给每条连接,
   * 投递这条连接不用订阅就收得到。
   */
  private observeThreadName(message: RpcMessage, threadId: string): void {
    const name = codexThreadName(message, threadId)
    if (name) this.onThreadName?.(name)
  }

  belongsToSession(sessionId: string): boolean {
    return this.sessionId === sessionId
  }

  private hasPendingTurn(): boolean {
    return this.turnCompletions.hasPendingTurn()
  }

  /** A dead transport cannot emit turn/completed. Fail its turns now, then allow owned cleanup/reload. */
  private transportClosed(error: Error): void {
    if (this.terminalError) return
    this.terminalError = error
    // TUI 还没建出会话、传输就断了 → 这条会话再也认领不到 thread,等待方 fail-loud(见 waitForTuiThread)。
    this.rejectTuiThreadWaiters(error)
    this.rejectQueuedDeliveries(error)
    const hadPendingTurn = this.hasPendingTurn()
    this.turnCompletions.dispose(error)
    this.turnStarts.dispose(error)
    // Process exit can precede socket close (or leave a descendant holding it).
    // Reject outstanding RPCs as well, including an in-flight turn/interrupt.
    this.client?.close()
    // #6264 tmux 里那台随终端会话一起被收掉(用户在 TUI 里退出了 codex)是会话正常结束,不是故障 ——
    // 只有正在跑的轮被它截断才算一次 error。
    if (hadPendingTurn || (!this.disposePromise && !this.backend)) {
      deliveryLog.error(
        { agent: this.agentKey, sessionId: this.sessionId, err: error.message },
        'codex app-server transport closed',
      )
      this.onTurnLifecycle?.({ type: 'error' })
    }
  }

  private async waitForPendingTurnsToSettle(): Promise<Error | null> {
    const deadline = Date.now() + CODEX_TURN_TEARDOWN_SETTLE_TIMEOUT_MS
    while (this.hasPendingTurn()) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        return new Error(
          `codex app-server teardown timed out waiting for in-flight turn completion after ${CODEX_TURN_TEARDOWN_SETTLE_TIMEOUT_MS}ms`,
        )
      }
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, remaining)))
    }
    return null
  }

  private async interruptActiveTurns(): Promise<void> {
    if (this.terminalError) return
    const client = this.client
    const threadId = this.threadId
    if (!client || !threadId) return
    const turnIds = this.turnCompletions.activeTurnIdsSnapshot()
    await Promise.all(turnIds.map(async (turnId) => {
      try {
        await client.rpc('turn/interrupt', { threadId, turnId })
      } catch {
        // The turn may have completed between the snapshot and interrupt request.
      }
    }))
  }

  /** 端点路径的取值口径:agent + 会话。逐会话唯一是 start()/dispose() 删 sock 的前提(见 transport)。
   *  仍然**确定**(不掺随机):同一条会话重启要能清掉自己上一次留下的 sock。 */
  private get endpointKey(): string {
    return `${this.agentKey}\u0000${this.sessionId}`
  }

  /**
   * @@@6112 认领 TUI 刚建出来的那条会话 —— tuiLoads='create' 下的「拿到 threadId」这一刻。
   *
   * 只认第一条:同一个 app-server 进程后面还会广播别的 thread(compact / subagent / rewind 分支),
   * 那些各有各的处理,❌ 不许顶替产品会话的活动 thread。
   */
  private adoptTuiThread(message: RpcMessage): boolean {
    if (!this.awaitingTuiThread || this.threadId) return false
    const threadId = codexPlainThreadStartedId(message)
    if (!threadId) return false
    this.awaitingTuiThread = false
    this.adoptedFromTui = true
    this.threadId = threadId
    // TUI 一建出来就是空闲的,而且 rollout 要等第一条用户消息才落盘 —— 与 thread/start 同口径。
    this.threadMaterialization = 'unmaterialized'
    deliveryLog.info(
      { agent: this.agentKey, sessionId: this.sessionId, threadId },
      'codex app-server adopted the thread its TUI created',
    )
    const waiters = this.tuiThreadWaiters
    this.tuiThreadWaiters = []
    this.adoptedThreadAttached = this.beginAttach(threadId, { materialize: true })
    this.adoptedThreadAttached.then(
      () => {
        for (const waiter of waiters) waiter.resolve(threadId)
      },
      (error: unknown) => { for (const waiter of waiters) waiter.reject(error) },
    )
    return true
  }

  /**
   * @@@6112 等 TUI 把会话建出来(tuiLoads='create')。已经建好 → 立刻返回。
   *
   * fail-loud:不是这个模式就抛。❌ 不静默返回一个空 id —— 那会让调用方拿着空串去投递,
   * 而投递那一侧只会报「会话未建立」,真因(模式用错了)一点痕迹都不留。
   */
  waitForTuiThread(): Promise<string> {
    const adoptedId = this.threadId
    if (adoptedId && this.adoptedThreadAttached) return this.adoptedThreadAttached.then(() => adoptedId)
    if (adoptedId) return Promise.resolve(adoptedId)
    if (!this.awaitingTuiThread) {
      return Promise.reject(new Error(
        'codex app-server 会话不是 tuiLoads=create 模式 —— 没有「等 TUI 建会话」这回事(fail-loud)',
      ))
    }
    // ❌ 不计时:TUI 建会话之前可能先问用户「信任这个目录吗」—— 那是用户的决定,想多久是他的事
    // (实测 Windows 新目录:60 秒超时把首轮判失败、还拆了 app-server,用户随后点 Yes 就接到一台死掉的服务)。
    // 结束等待的只有客观信号:TUI 建出会话 → resolve;会话被 dispose / app-server 进程退出 → reject。
    return new Promise<string>((resolve, reject) => {
      this.tuiThreadWaiters.push({ resolve, reject })
    })
  }

  /** 会话没等到 TUI 建出 thread 就结束了(dispose / app-server 退出)→ 所有等待方 fail-loud。 */
  private rejectTuiThreadWaiters(error: Error): void {
    const waiters = this.tuiThreadWaiters
    this.tuiThreadWaiters = []
    for (const waiter of waiters) waiter.reject(error)
  }

  /** 会话关闭 / 传输断开 → 还没起轮的排队条目永远等不到起轮,fail-loud。 */
  private rejectQueuedDeliveries(error: Error): void {
    const pending = [...this.queuedDeliveries.values()]
    this.queuedDeliveries.clear()
    for (const entry of pending) entry.reject(error)
  }

  /** `item/started` 的 userMessage 带着入队时的 clientUserMessageId → 认领那一条的轮 id。 */
  private observeQueuedDispatch(message: RpcMessage): void {
    if (message.method !== 'item/started' || message.params?.threadId !== this.threadId) return
    const item = message.params?.item as { type?: unknown; clientId?: unknown } | undefined
    const turnId = message.params?.turnId
    if (item?.type !== 'userMessage' || typeof item.clientId !== 'string' || typeof turnId !== 'string') return
    const entry = this.queuedDeliveries.get(item.clientId)
    if (!entry) return
    this.queuedDeliveries.delete(item.clientId)
    entry.resolve(turnId)
  }

  /**
   * 把咕咕自己排的那一条起成一轮(`thread/queue/start`)。服务端答「已有在跑 / 待起的轮」时,
   * 以 `thread/queue/list` 这一刻的事实判定:条目已不在队列 = 已派发;还在 = 排在那一轮之后,
   * 那一轮正常结束时服务端自动派发。其余拒绝 → THROW。
   */
  private async startQueuedDelivery(client: CodexRpcClient, threadId: string, submissionId: string): Promise<void> {
    try {
      await client.rpc('thread/queue/start', { threadId, queuedSubmissionId: submissionId })
    } catch (error) {
      const listed = (await client.rpc('thread/queue/list', { threadId })) as { data?: Array<{ id?: unknown }> }
      const stillQueued = (listed.data ?? []).some((entry) => entry.id === submissionId)
      if (!stillQueued) return
      if (error instanceof Error && error.message.includes('already has an active or pending turn')) return
      throw error
    }
  }

  /**
   * 上一轮以 interrupted 收尾 → codex 官方语义:队列不自动续跑,等人发话。咕咕的消息是别的 agent
   * 投来的(从前直接 turn/start,从不因用户打断而搁置)⇒ 只把**咕咕自己**最早那一条起起来;
   * 用户自己在 TUI 里排的不碰。
   */
  private resumeQueuedDeliveriesAfterInterrupt(): void {
    const client = this.client
    const threadId = this.threadId
    if (!client || !threadId) return
    const next = [...this.queuedDeliveries.entries()].find(([, entry]) => entry.submissionId)
    if (!next) return
    const [clientId, entry] = next
    this.startQueuedDelivery(client, threadId, entry.submissionId!).catch((error: unknown) => {
      if (this.queuedDeliveries.get(clientId) !== entry) return
      this.queuedDeliveries.delete(clientId)
      deliveryLog.error({ threadId, submissionId: entry.submissionId, err: String(error) }, 'codex queued delivery could not be resumed after an interrupted turn')
      entry.reject(error)
    })
  }

  /**
   * @@@6112 把**咕咕这条连接**接到 TUI 建的那条 thread 上 —— 每一步都以上一步的**返回**为闸,
   * 不重试、不计时、不猜。
   *
   * 为什么要接:turn/started、turn/completed 只发给「start / resume / fork 过这条 thread」的连接
   * (协议里没有 thread/subscribe)。thread 由 TUI 建,咕咕就一条都收不到 —— 咕咕会一直以为回合
   * 在跑,归档等 30 秒超时失败(实测 4/4)。
   *
   * 为什么是这两步、这个顺序:
   *   ① `thread/section/move(sectionId: null)` —— 官方语义「移出分组」(这条 thread 本不在分组里,
   *      归属不变);它在返回**之前**把 thread 写盘并 flush(codex 0.155.1
   *      `ThreadManager::move_thread_to_section`:"Explicit placement must work before the first
   *      turn materializes the thread")。
   *   ② `thread/resume` —— 只认磁盘上的 rollout,所以必须排在 ① 的返回之后;它的返回即订阅成立。
   *      ❌ 不带任何 config:带 override 的 resume 对空闲线程会走「关停 + 冷启」那条分支。
   * 两步都在咕咕投出第一轮**之前**完成(waitForTuiThread 与 deliver 都等它),所以第一轮的开始与结束
   * 通知必然送达,不存在「订阅之前就结束」的窗口。
   *
   * ❌ 不能反过来「咕咕建 thread、写盘、再让 TUI resume 上来」:TUI resume 一条零回合的 thread 后,
   *    别的连接投的回合会让它永远停在 is_task_running(实测 3/3,`?` 面板 to interrupt)。
   */
  private beginAttach(threadId: string, opts: { materialize: boolean }): Promise<void> {
    this.attachState = { kind: 'pending' }
    return this.attachToAdoptedThread(threadId, opts).then(
      () => {
        this.attachState = { kind: 'done' }
        this.liveAwaitsAttach = false
        this.notifyThreadLive()
      },
      (error: unknown) => {
        this.attachState = { kind: 'failed', error }
        throw error
      },
    )
  }

  private async attachToAdoptedThread(threadId: string, opts: { materialize: boolean }): Promise<void> {
    const client = this.client
    if (!client) throw new Error('codex app-server 会话未建立 — 无法接入 TUI 载入的 thread(fail-loud)')
    // 刚被 TUI 新建的 thread 还没落盘,resume 认不到 —— 先写盘;TUI resume 进来的本就在盘上。
    if (opts.materialize) await client.rpc('thread/section/move', { threadId, sectionId: null })
    const resumed = await client.rpc('thread/resume', { threadId })
    this.threadMaterialization = 'materialized'
    if (opts.materialize) {
      // TUI 建的这条日后若要重拉 TUI(崩溃重拉 / 重开),走的是 `resume <tid>`,同样得把 thread 自己的
      // 模型钉给 TUI(见 codexTuiThreadSettingsArgs)—— 否则被用户 config.toml 的默认模型顶掉。
      const read = (await client.rpc('thread/read', { threadId, includeTurns: false })) as {
        thread: { model?: unknown; reasoningEffort?: unknown }
      }
      this.tuiResumeArgs = codexTuiThreadSettingsArgs(read.thread)
    }
    // resume 的返回是订阅成立那一刻服务端的真相:用户若已在 TUI 里抢先敲了一句,这里能看到它在跑
    // (官方 app-server-client README:bootstrap 要用启动响应与之后的事件对账)。
    const running = activeTurnIdFromThread(resumed)
    if (running) {
      this.turnStarts.start(running)
      this.turnCompletions.start(running)
      this.onTurnLifecycle?.({ type: 'start' })
    }
    deliveryLog.info(
      { agent: this.agentKey, sessionId: this.sessionId, threadId },
      'codex app-server attached to the thread its TUI loaded',
    )
  }

  /**
   * TUI 载入 thread、投递连接接入后回调(已接入则立即回调)。新建与重开都由这个事实发 session-live，
   * 接入前的消息留在来源收件箱；启动流程返回描述符不代表 TUI 已就绪。
   */
  onThreadLive(listener: () => void): void {
    if (this.threadId && !this.liveAwaitsAttach) {
      listener()
      return
    }
    this.threadLiveListeners.push(listener)
  }

  private notifyThreadLive(): void {
    const listeners = this.threadLiveListeners
    this.threadLiveListeners = []
    for (const listener of listeners) listener()
  }

  /** activeFlags 快照 → 等待边,经同一条 relay 发出;形状对不上就记下、丢这一帧。 */
  private observeThreadWaits(message: RpcMessage, threadId: string): void {
    let observed: ReturnType<typeof codexThreadWaitEdges>
    try {
      observed = codexThreadWaitEdges(this.waitFlags, message, threadId)
    } catch (error) {
      deliveryLog.error(
        { agent: this.agentKey, sessionId: this.sessionId, threadId, err: String(error) },
        'codex app-server thread/status/changed does not match the protocol; wait edges dropped',
      )
      return
    }
    if (!observed) return
    this.waitFlags = observed.flags
    for (const edge of observed.edges) this.onTurnLifecycle?.(edge)
  }

  private observeTuiLoadedThread(message: RpcMessage): void {
    if (!this.awaitingTuiLoad || !this.threadId) return
    if (message.method !== 'thread/status/changed' || message.params?.threadId !== this.threadId) return
    this.awaitingTuiLoad = false
    const threadId = this.threadId
    deliveryLog.info(
      { agent: this.agentKey, sessionId: this.sessionId, threadId },
      'codex app-server saw its TUI load the thread',
    )
    this.adoptedThreadAttached = this.beginAttach(threadId, { materialize: false })
    this.adoptedThreadAttached.catch((error: unknown) => {
      deliveryLog.error(
        { agent: this.agentKey, sessionId: this.sessionId, threadId, err: String(error) },
        'codex app-server 没能接入 TUI 载入的 thread',
      )
    })
  }

  private observeThreadStarted(message: RpcMessage): void {
    if (this.adoptTuiThread(message)) return
    const fork = codexForkStartedEvent(message)
    const parentThreadId = this.threadId
    // Subagent threads also carry lineage metadata, but their parent_thread_id is the
    // ownership edge and must never replace the product conversation's active thread.
    if (!fork || fork.parentThreadId || !parentThreadId || fork.forkedFromId !== parentThreadId) return

    observeCodexFork(fork.threadId, parentThreadId)
    this.threadForkObservationQueue = this.threadForkObservationQueue
      .then(() => this.reconcileThreadFork(fork.threadId, parentThreadId))
      .catch((error) => {
        settleCodexForkObservation(fork.threadId, false)
        deliveryLog.warn(
          {
            agent: this.agentKey,
            sessionId: this.sessionId,
            threadId: fork.threadId,
            parentThreadId,
            err: String(error),
          },
          'codex app-server fork observation failed',
        )
      })
  }

  private async reconcileThreadFork(childThreadId: string, parentThreadId: string): Promise<void> {
    const client = this.client
    if (!client || this.threadId !== parentThreadId) {
      settleCodexForkObservation(childThreadId, false)
      return
    }

    const [parent, child] = await Promise.all([
      client.rpc('thread/read', { threadId: parentThreadId, includeTurns: true }),
      client.rpc('thread/read', { threadId: childThreadId, includeTurns: true }),
    ])
    if (!codexForkRewritesHistory(parent, child)) {
      // An explicit `/fork` keeps the full history and remains discoverable by the normal
      // rollout scanner, so it still gets its own sidebar conversation.
      settleCodexForkObservation(childThreadId, false)
      return
    }

    this.threadId = childThreadId
    this.threadMaterialization = 'materialized'
    this.threadRefusesTurnsRead = false
    this.recentActionWindow = []
    for (const turnId of this.turnCompletions.activeTurnIdsSnapshot()) {
      this.turnCompletions.complete(turnId)
    }
    await this.onThreadIdChanged?.(childThreadId)
    settleCodexForkObservation(childThreadId, true)
    deliveryLog.info(
      {
        agent: this.agentKey,
        sessionId: this.sessionId,
        parentThreadId,
        threadId: childThreadId,
      },
      'codex app-server adopted TUI rewind thread',
    )
  }

  /**
   * 起 `codex app-server --listen <endpoint>`、WS 握手、initialize,再 thread/start 或
   * thread/fork;返回实际 threadId。
   * opts.extraArgs 拼进 app-server 的 argv,承载 adapter 物化的模型配置；权限由
   * opts.threadStart 进入 thread/start，避免进程 argv 遮住线程设置。MCP 由
   * thread-open 原生 `config` map 与 child env 承载，prompt 块则经 developerInstructions 进入原生
   * thread-open RPC。Codex 继续使用用户真实 `CODEX_HOME` 读取 auth/跨 run 状态；workspace trust 由 capability bundle 的 session-owned overlay 与 `-c` 覆盖提供，用户全局 config.toml 不被改写。这里不补 provider `buildCommand` 的 `notify`：本路径
   * 直接消费 WS `turn/started` / `turn/completed` 驱动会话页后端的 lifecycle,且 divert 时不会加载会话页的 CLI
   * hooks,所以也没有 hook trust 需要 `--dangerously-bypass-hook-trust` 绕过。
   */
  async start(
    cwd: string,
    opts?: {
      extraArgs?: string[]
      threadConfig?: Readonly<Record<string, unknown>>
      threadStart?: Readonly<Record<string, unknown>>
      /** #6387 Installed Apps' skills as extra skill roots of this app-server (see codex session-bundle extensionSkillRoot). */
      skillRoots?: readonly string[]
      env?: NodeJS.ProcessEnv
      developerInstructions?: string
      forkFromThreadId?: string
      resumeThreadId?: string
      /** TUI resume 时要钉给它的模型 / 推理强度,见 `codexTuiThreadSettingsArgs` 的 `desired`。 */
      resumeModel?: { model?: string | null; reasoningEffort?: string | null }
      /**
       * @@@6112 thread 一律由 **TUI** 载入,咕咕从不在这台 app-server 上先载入它:
       *   · 'create' —— TUI 新建(argv 不带 resume),咕咕从广播 `thread/started` 认领(返回 null)。
       *   · 'resume' —— TUI `resume <resumeThreadId>` 载入,咕咕等官方广播
       *     `thread/status/changed`(该 thread 从未载入变为已载入)再订阅。
       *
       * 为什么:TUI 在「一轮正在跑」时接进 thread,此后永久停在 `is_task_running = true`
       * (实测 3/3;上游同源缺陷 openai/codex#43952:resume 时把历史里的 InProgress 轮当成在跑,
       * 丢掉了服务端给的 thread status;「接入进行中的会话」官方本就不支持,#37967)。
       * rewind 的第一道闸正是这个标志 ⇒ Esc-Esc 全程无反应(#6112)。咕咕若先载入,队列里的消息
       * 会立刻起轮,TUI 就又成了「中途加入」—— 所以载入权只给 TUI。
       * fork 不在这里:它要带新身份的 developerInstructions(官方只认 start/fork 时给),由调用方
       * 在一台临时 app-server 上 fork 落盘后,再以 'resume' 交给 TUI 载入。
       */
      tuiLoads?: 'create' | 'resume'
    }
  ): Promise<string | null> {
    this.cwd = cwd
    this.stderrTail = ''
    this.terminalError = null
    try {
      const endpoint = await createCodexAppServerEndpoint(this.endpointKey, this.platform)
      this.endpoint = endpoint
      removeCodexAppServerEndpoint(endpoint)

      // @@@6112 权限两处都带,各管一路(实测依据见 codexThreadConfigProcessArgs 的 threadStart):
      //   · TUI 新建 thread → 吃 TUI 自己的 `-a` / `-s`(见 remoteTuiArgs),进程级那份被它盖掉;
      //   · TUI resume 载入 → sandbox 不随 thread 落盘,吃进程级 `-c sandbox_mode`。
      this.tuiPermissionArgs = opts?.tuiLoads === 'create' ? codexTuiPermissionArgs(opts.threadStart) : []
      this.tuiModelSelectionArgs = opts?.tuiLoads === 'create' ? codexTuiModelSelectionArgs(opts.extraArgs) : []
      // 宿主算好的那一份(#5702)。❌ 不再铺 `...process.env`:worker/腿各自铺全量环境,正是
      // 「同一家 agent 在两条腿上跑在两个不同环境里」的由来。没有宿主那份时才退回本进程的,
      // 那条路只剩测试夹具在走。
      const childEnv = opts?.env ? { ...opts.env } : { ...process.env }
      const codexPlugin = pluginRegistry.get('codex')
      if (!codexPlugin) throw new Error('Codex plugin is not registered; refusing to start app-server')
      // ❌ 不在这里替它把 Windows 壳包好再递进去:那条边界只传得了 `{executable, args}`,
      // 传不了 `windowsVerbatimArguments`,而包好的命令行少了那个开关就是一条散架的命令行
      // (真机症状见 session-runtime-compatibility.ts 里 probeExecutable 的抬头)。
      // 递原始路径,让执行上下文自己的 windows launcher 去包 —— 包壳只有一个属主。
      // @@@engine-preflight (#3685 / #6183) — 用【将要 spawn 的那一份 env】先证明引擎跑得起来,
      // 让「引擎起不来」当场红,而不是变成 15 秒后一条指着 socket 的超时。
      // 版本探针只有这一个属主:它等 `--version` 退出这个事实,❌ 墙钟(这里曾另有一份 spawnSync 10s 的
      // 私有预检,负载高时把「慢」判成「codex 起不来」,还挡住主线程);失败时带出引擎自己的话、errno 与 PATH。
      await assertSessionRuntimeCompatible({
        providerId: 'codex',
        surface: 'app-server',
        descriptor: codexPlugin.capabilities.sessionBundle,
        executable: this.codexBin,
        executionContext: new NodeExecutionContext({ root: cwd, env: childEnv }),
        env: versionProbeEnv(childEnv),
      })
      // 平台模型的 codex 元数据(#5635):物化器把网关目录的事实放进 env,这里写成本会话自有的
      // catalog 文件,app-server 与 remote TUI 都指向它。非平台会话没有事实 ⇒ 不写、不加参数。
      // ⚠️ 必须排在上面那道「引擎跑得起来」的判定**之后**:写 catalog 要先跑一次
      //    `codex debug models --bundled`,codex 不在 PATH 上时它会先炸,把「找不到可执行文件」
      //    盖成一句「请升级 Codex」—— 用户被指去升级一个根本没装上的东西。
      this.modelCatalog?.dispose()
      this.modelCatalog = await writeCodexModelCatalog(
        childEnv,
        () => codexBundledCatalog(this.codexBin, this.platform, childEnv),
      )
      if (this.modelCatalog.windowUnknown.length > 0) {
        deliveryLog.warn(
          { sessionId: this.sessionId, models: this.modelCatalog.windowUnknown },
          'gateway directory states no context window for these platform models; codex sizes them with its unknown-model window',
        )
      }
      this.modelMetadataArgs = [...codexTuiSessionConfigArgs(opts?.extraArgs), ...this.modelCatalog.args]
      this.tuiDirectOnlyArgs = codexTuiDirectOnlyArgs(opts?.threadConfig)
      // @@@6112 thread 由 TUI 载入,咕咕手上没有 `thread/start` / `thread/resume` 可挂配置 ——
      // 改由**进程级** `-c` 承载(实测:MCP 对 create/resume 都生效,以 `mcpServerStatus/list` 为证;
      // developerInstructions 只对 create 生效,resume 沿用 thread 自己存的那份 —— 与从前一致,
      // 从前的 resume 也从不重发指令)。
      const appServerArgs = [
        'app-server',
        '--listen',
        endpoint.address,
        ...(opts?.extraArgs ?? []),
        ...this.modelCatalog.args,
        ...(opts?.tuiLoads
          ? codexThreadConfigProcessArgs({
            developerInstructions: opts.developerInstructions,
            threadConfig: opts.threadConfig,
            threadStart: opts.threadStart,
          })
          : []),
      ]
      const launch = resolveCodexAppServerSpawn(
        this.codexBin,
        appServerArgs,
        this.platform,
        childEnv
      )
      if (this.tmuxBackendName) {
        // #6264 TUI 住在 tmux 里 ⇒ 它的推理进程也住进 tmux(见 tmux-backend.ts):宿主退出只断开,不杀;
        // 新宿主按会话名接回同一台(adopt)。❌ 不写 pidfile:它的生命归 tmux,启动回收不该碰它。
        const backend = await launchTmuxBackend({
          name: this.tmuxBackendName,
          kind: 'codex-app-server',
          endpoint: endpoint.address,
          command: launch.command,
          args: launch.args,
          env: childEnv,
          cwd,
        }, this.tmuxBackendDeps)
        this.backend = backend
        trackedCodexAppServerSessions.add(this)
        await waitForCodexAppServerEndpointWhileAlive(endpoint, () => backend.isAlive(), this.startupTimeoutMs)
      } else {
        const appServer = spawnOwnedChild(launch.command, launch.args, {
          cwd,
          stdio: ['ignore', 'ignore', 'pipe'],
          env: childEnv,
          windowsHide: true,
          windowsVerbatimArguments: launch.windowsVerbatimArguments,
          detached: process.platform !== 'win32',
          onError: (error) => this.reportProcessError(error),
        })
        const proc = appServer.child
        this.proc = proc
        this.appServer = appServer
        proc.once('exit', (code, signal) => {
          if (this.proc !== proc) return
          this.transportClosed(new Error(`codex app-server exited (code=${code}, signal=${signal}) before turn/completed`))
        })
        // @@@unhandled-error-event (#4942) — 为什么在 spawn 的下一行就挂,而不是等 waitForCodexAppServerEndpoint:
        // ① 那个 handler 是**一次性**的,握手成功后 cleanup() 会把它摘掉(摘是对的,它只该活到握手结束),
        //    此后这条长驻引擎进程在整个会话生命周期里就没有 'error' 出口了;
        // ② 就算不摘,spawn 与 waitFor… 之间还隔着 pidfile 落盘的 await,那段窗口一样是裸的。
        // 没有监听者时 Node 把 'error' 抛成未捕获异常 —— 在会话页宿主里等于宿主连同所有会话一起死,而不是
        // 这一条 codex 会话失败。这类失败(spawn 失败、kill 失败、stderr 管道 EPIPE)是**异步**送达的,
        // start() 外面那圈 try/catch 一次也接不住。proc 本体的出口在 spawn 当场(onError);proc.stderr 是另一个独立发射器,挂在这里。
        // ❌ 不是吞错:握手期由那个一次性 handler 照旧 reject,这里只保证「没人接 ⇒ 宿主死」这条路径断掉。
        onErrorEvents([proc.stderr], (error) => this.reportProcessError(error))
        trackedCodexAppServerSessions.add(this)
        proc.stderr?.on('data', (chunk) => {
          this.stderrTail = appendCodexStderrTail(this.stderrTail, chunk)
        })
        if (!proc.pid) throw new Error('codex app-server spawn returned no PID')
        // spawn 时刻与 pid:端点就绪超时(startupTimeoutMs,pidfile 落盘后起算)报错时,凭这一行才分得清
        // 「进程起晚了」与「起了但迟迟不监听」;没有它只能从失败时刻倒推。
        deliveryLog.info(
          { agent: this.agentKey, sessionId: this.sessionId, pid: proc.pid, codexBin: this.codexBin, endpoint: endpoint.address },
          'codex app-server spawned',
        )
        if (this.pidfileEnabled) {
          markEngineSpawned()
          this.pidfilePgid = proc.pid
          this.pidfileWritePromise = writeEnginePidfile({
            pgid: proc.pid,
            ownerMainPid: process.pid,
            engineId: 'codex-app-server',
            agentUserId: this.agentKey,
            conversationId: this.sessionId,
            threadRootId: null,
            cwd,
            command: launch.command,
            args: launch.args,
            startedAt: Date.now(),
          })
        await this.pidfileWritePromise
        }
        await waitForCodexAppServerEndpoint(endpoint, proc, this.startupTimeoutMs)
      }

      const client = new CodexRpcClient()
      this.client = client
      client.onClose = (error) => {
        if (this.client === client) this.transportClosed(error)
      }
      await client.connect(endpoint, this.handshakeTimeoutMs)
      await client.rpc('initialize', CODEX_INITIALIZE_PARAMS)
      client.notify('initialized', {})
      // Before any thread: the roots are the app-server's, so the thread the TUI creates or resumes lists the skills.
      // Adopting a running app-server (below) skips this — it kept the roots it was started with.
      if (opts?.skillRoots?.length) await client.rpc('skills/extraRoots/set', { extraRoots: [...opts.skillRoots] })
      if (opts?.tuiLoads === 'create') {
        // 只 arm 认领:thread 由 TUI 建,threadId 等广播(adoptTuiThread)。事件处理器在下面注册,
        // 而 TUI 要等本函数返回后才被 spawn —— 所以不存在「广播早于监听」的窗口。
        this.awaitingTuiThread = true
        this.liveAwaitsAttach = true
      } else if (opts?.tuiLoads === 'resume') {
        const resumeThreadId = opts.resumeThreadId?.trim()
        if (!resumeThreadId) throw new Error("codex app-server tuiLoads='resume' 缺 resumeThreadId(fail-loud)")
        // 只记下 id、❌ 不载入:载入的是 TUI(`resume <tid>`),咕咕等它的载入广播(见 onEvent)。
        this.threadId = resumeThreadId
        this.adoptedFromTui = true
        this.awaitingTuiLoad = true
        this.liveAwaitsAttach = true
        this.threadMaterialization = 'materialized'
        // TUI 要等本函数返回才 spawn,所以这份读数一定在 TUI 载入之前拿到(见 codexTuiThreadSettingsArgs)。
        const read = (await client.rpc('thread/read', { threadId: resumeThreadId, includeTurns: false })) as {
          thread: { model?: unknown; reasoningEffort?: unknown }
        }
        this.tuiResumeArgs = codexTuiThreadSettingsArgs(read.thread, opts.resumeModel)
      } else {
        this.threadId = await openCodexThread(
          client,
          cwd,
          opts?.forkFromThreadId,
          opts?.resumeThreadId,
          opts?.developerInstructions,
          opts?.threadConfig,
          opts?.threadStart,
        )
        this.threadMaterialization = opts?.forkFromThreadId || opts?.resumeThreadId
          ? 'unknown'
          : 'unmaterialized'
      }
      this.subscribeEvents(client)
      return this.threadId
    } catch (error) {
      // tmux 里那台的 stderr 在日志文件里 —— 拆之前先读(拆的时候会删它)。
      if (this.backend) this.stderrTail = this.backend.stderrTail()
      let cleanupError: unknown
      try {
        await this.dispose()
      } catch (disposeError) {
        cleanupError = disposeError
      }
      const failure = describeCodexStartFailure(
        this.codexBin,
        error,
        this.stderrTail,
        this.stderrCloseTimeoutMs
      )
      if (cleanupError) {
        throw new AggregateError(
          [failure, cleanupError],
          `Codex app-server startup and cleanup both failed: ${failure.message} | ${(cleanupError as Error).message}`,
        )
      }
      throw failure
    }
  }

  /**
   * #6264 接回一台活过上一个宿主进程的 app-server(它住在 tmux 里,TUI 一直连着它)。
   *
   * 与 start() 的差别只有「不起进程」:连上同一个地址、initialize,然后
   *  · 已知 threadId(TUI 早就载入了它)→ 当场按序接入(thread/resume,❌ 带任何 config),
   *    resume 的返回里若有在跑的轮,照 start 的对账口径接上它的完成通知;
   *  · 不知道(TUI 还停在「信任此目录?」,没建出 thread)→ 与 tuiLoads='create' 同样只 arm 认领。
   * 失败 → 抛,且 ❌ 杀那台后台(调用方决定是收掉它另起,还是报错)。
   */
  async adopt(
    cwd: string,
    backend: TmuxBackend,
    opts: {
      threadId?: string | null
      extraArgs?: string[]
      threadStart?: Readonly<Record<string, unknown>>
      /** The same thread config the app-server was started with: the TUI reopened over it needs its direct-only list. */
      threadConfig?: Readonly<Record<string, unknown>>
    },
  ): Promise<string | null> {
    const endpoint = parseCodexAppServerEndpoint(backend.endpoint)
    if (!endpoint) throw new Error(`codex app-server: cannot adopt a backend with endpoint ${backend.endpoint}`)
    this.cwd = cwd
    this.stderrTail = ''
    this.terminalError = null
    this.endpoint = endpoint
    this.backend = backend
    this.modelMetadataArgs = codexTuiSessionConfigArgs(opts.extraArgs)
    this.tuiDirectOnlyArgs = codexTuiDirectOnlyArgs(opts.threadConfig)
    try {
      const client = new CodexRpcClient()
      this.client = client
      client.onClose = (error) => {
        if (this.client === client) this.transportClosed(error)
      }
      await client.connect(endpoint, this.handshakeTimeoutMs)
      await client.rpc('initialize', CODEX_INITIALIZE_PARAMS)
      client.notify('initialized', {})
      trackedCodexAppServerSessions.add(this)
      const threadId = opts.threadId?.trim()
      if (threadId) {
        this.threadId = threadId
        this.adoptedFromTui = true
        this.threadMaterialization = 'materialized'
        this.liveAwaitsAttach = true
        const read = (await client.rpc('thread/read', { threadId, includeTurns: false })) as {
          thread: { model?: unknown; reasoningEffort?: unknown }
        }
        this.tuiResumeArgs = codexTuiThreadSettingsArgs(read.thread)
        this.subscribeEvents(client)
        this.adoptedThreadAttached = this.beginAttach(threadId, { materialize: false })
        await this.adoptedThreadAttached
      } else {
        this.tuiPermissionArgs = codexTuiPermissionArgs(opts.threadStart)
        this.tuiModelSelectionArgs = codexTuiModelSelectionArgs(opts.extraArgs)
        this.awaitingTuiThread = true
        this.liveAwaitsAttach = true
        this.subscribeEvents(client)
      }
      deliveryLog.info(
        { agent: this.agentKey, sessionId: this.sessionId, threadId: this.threadId, pid: backend.pid },
        'codex app-server adopted from tmux after a host restart',
      )
      return this.threadId
    } catch (error) {
      this.detach()
      throw error
    }
  }

  /**
   * #6264 宿主要走了,但 TUI 还在 tmux 里用着这台 app-server:只断开咕咕这条连接,❌ 杀进程、❌ 删套接字。
   * 在等的调用方照 dispose 的口径 fail-loud(会话在这个宿主里确实结束了);新宿主会 adopt 回来。
   */
  detach(): void {
    const closed = new CodexSessionClosedError('codex app-server 会话已断开(宿主退出,后台留在 tmux 里)')
    this.rejectTuiThreadWaiters(closed)
    this.rejectQueuedDeliveries(closed)
    this.turnCompletions.dispose(closed)
    this.turnStarts.dispose(closed)
    const client = this.client
    this.client = null
    client?.close()
    this.backend = null
    this.endpoint = null
    this.threadId = null
    trackedCodexAppServerSessions.delete(this)
  }

  /** 这条连接上的事件 → thread 认领 / 回合生命周期(start 与 adopt 共用)。 */
  private subscribeEvents(client: CodexRpcClient): void {
    client.onEvent((message) => {
      if (this.terminalError) return
      this.observeThreadStarted(message)
      this.observeTuiLoadedThread(message)
      if (!this.threadId) return
      this.observeThreadName(message, this.threadId)
      this.observeQueuedDispatch(message)
      const action = codexRecentActionFromEvent(message, this.threadId)
      if (action) {
        this.recentActionWindow = pushRecentAction(this.recentActionWindow, action, Date.now())
      }
      this.observeThreadWaits(message, this.threadId)
      let lifecycle: CodexTurnLifecycle | null
      try {
        lifecycle = codexTurnLifecycle(message, this.threadId)
      } catch (error) {
        // 这一轮结束了但结局读不出来:记下,按失败收口。
        deliveryLog.error(
          { agent: this.agentKey, sessionId: this.sessionId, err: String(error) },
          'codex app-server turn/completed does not match the protocol; settling the turn as failed',
        )
        lifecycle = { type: 'error' }
      }
      // #6264 这一轮是被「这台机器上的登录不能用了」拒掉的:这件事随失败那条边一起走(宿主据此回写「登录已失效」)。
      if (lifecycle?.type === 'error' && codexTurnSignInRequired(message)) lifecycle = { type: 'error', signInRequired: true }
      const turnId = (message.params?.turn as { id?: unknown } | undefined)?.id
      if (lifecycle?.type === 'start' && typeof turnId === 'string' && turnId) {
        this.threadMaterialization = 'materialized'
        this.turnStarts.start(turnId)
        this.turnCompletions.start(turnId)
      }
      if (
        (lifecycle?.type === 'stop' || lifecycle?.type === 'error')
        && typeof turnId === 'string'
        && turnId
      ) {
        this.turnCompletions.complete(
          turnId,
          lifecycle.type === 'error'
            ? new Error(codexTurnFailureMessage(message.params?.turn)
              ?? `codex app-server turn ${turnId} completed with an error status`)
            : undefined,
        )
      }
      if (lifecycle) this.onTurnLifecycle?.(lifecycle)
      if (
        message.method === 'turn/completed'
        && (message.params?.turn as { status?: unknown } | undefined)?.status === 'interrupted'
      ) this.resumeQueuedDeliveriesAfterInterrupt()
    })
  }

  /**
   * 会话页后端的 pty 用它起**可见 TUI**:`codex --remote <endpoint> resume <tid>`。这是 spec ④「原生 TUI
   * 终端形态」——用户看到的终端与本模块投递用的是同一个 app-server、同一个 thread(不同 WS 客户端)。
   */
  remoteTuiArgs(): string[] {
    if (!this.endpoint) {
      throw new Error('codex app-server endpoint 未建立 — 无法起 --remote TUI(fail-loud)')
    }
    if (this.awaitingTuiThread && !this.threadId) {
      // @@@6112 新会话:**不带 resume**,让 TUI 自己在这台 app-server 上建 thread,咕咕再从
      // 广播里认领它(adoptTuiThread)。`-C` 显式给工作根 —— 线程的 cwd 由建它的那一方决定,
      // 这里建它的是 TUI,不再是咕咕的 `thread/start` cwd 参数。
      // 关自更新(#6186)同上:无子命令时根级 `-c` 与宿主追加的 `-c` 同组,放在末尾即可。
      return [...this.modelMetadataArgs, ...this.tuiDirectOnlyArgs, ...this.tuiModelSelectionArgs, ...this.tuiPermissionArgs, '-C', this.cwd, '--remote', this.endpoint.address, ...codexSelfUpdateArgs()]
    }
    if (!this.threadId) {
      throw new Error('codex app-server thread 未建立 — 无法起 --remote TUI(fail-loud)')
    }
    return [
      ...this.modelMetadataArgs,
      '--remote',
      this.endpoint.address,
      'resume',
      ...this.tuiResumeArgs,
      // 放进子命令,和下面 codexSelfUpdateArgs 同一处(#6186 的读数)。
      ...this.tuiDirectOnlyArgs,
      this.threadId,
      // 这条 argv 整条替换通用终端命令,所以关自更新的那段由这里读同一份声明带上(#6186)。
      // ⚠️ 放在 `resume` **之后**,这是 #6186 的读数:同一 app-server、同一 thread,放在根级而子命令另有 `-c`
      //    (宿主随后会追加 `-c model_provider=…`)⇒ 启动更新菜单照弹(#5877 就是放在前面);放进子命令 ⇒ 不弹。
      //    原因没核出来,不是「根级被丢掉」:codex 源码里 resume/fork 先接上子命令自己的 `-c`,再把根级的插到
      //    最前面,同一个键冲突时子命令的赢(rust-v0.155.0 / rust-v0.156.1 `codex-rs/cli/src/main.rs`
      //    finalize_resume_interactive、`codex-rs/utils/cli/src/config_override.rs:42-45` prepend_root_overrides)。
      ...codexSelfUpdateArgs(),
    ]
  }

  get socketPath(): string {
    return this.endpoint?.kind === 'unix' ? this.endpoint.socketPath : ''
  }

  /**
   * @@@6112 TUI 的新建 / 重开 thread 尚未接入(例如停在「信任此目录?」),而 app-server 仍活着。
   * 这时重拉 TUI 必须复用**这台** app-server(见 codex-pty-provisioning 的复用分支),❌ 不许再起一台。
   */
  isAwaitingTuiThread(): boolean {
    return Boolean(!this.terminalError && this.liveAwaitsAttach && this.attachState.kind !== 'failed' && this.client && this.engineRunning())
  }

  isLive(): boolean {
    return Boolean(
      !this.terminalError
      && !this.liveAwaitsAttach
      && this.client
      && this.endpoint
      && this.threadId
      && this.engineRunning()
    )
  }

  isTurnInFlight(): boolean {
    return this.turnCompletions.isActive()
  }

  recentActionsSnapshot(): { actions: string[]; lastActionAt: string | null } {
    return {
      actions: recentActionList(this.recentActionWindow),
      lastActionAt: lastActionAtIso(this.recentActionWindow),
    }
  }

  /**
   * 投递一条消息作为**新一轮**(spec ⑧「作为新一轮输入交付」)。fresh thread 的第一条投递直接
   * turn/start，因为 Codex 在首条用户消息前不允许 thread/read includeTurns。已 materialize 的 thread 先读
   * inProgress turn:忙 → turn/steer 中途插入(owner #85);闲 → turn/start。steer 输给正在结束的 turn 竞态失败则回退 turn/start。
   */
  async deliver(text: string): Promise<CodexTurnRef> {
    if (this.terminalError) throw this.terminalError
    const client = this.client
    if (!client || !this.threadId) throw new Error('codex app-server 会话未建立(fail-loud)')
    const input = [{ type: 'text', text, text_elements: [] }]
    // @@@6112 TUI 还没载入 / 咕咕还没接入:❌ 不读、不起轮,直接交给 codex 队列 —— 服务端在 TUI
    // 载入之后才起这一轮,TUI 不会「中途加入」(实测:先排队、后 TUI resume,3/3 干净)。
    const attached = this.adoptedThreadAttachedSettled()
    if (!attached) return this.enqueue(client, this.threadId, input)
    let activeTurnId: string | null = null
    if (this.threadMaterialization !== 'unmaterialized' && !this.threadRefusesTurnsRead) {
      try {
        const thread = await client.rpc('thread/read', { threadId: this.threadId, includeTurns: true })
        this.threadMaterialization = 'materialized'
        activeTurnId = activeTurnIdFromThread(thread)
      } catch (error) {
        const refusal = threadReadTurnsRefusal(error)
        if (!refusal) throw error
        if (refusal === 'paginated') this.threadRefusesTurnsRead = true
        else this.threadMaterialization = 'unmaterialized'
      }
    }
    if (activeTurnId) {
      try {
        await client.rpc('turn/steer', {
          threadId: this.threadId,
          input,
          expectedTurnId: activeTurnId
        })
        deliveryLog.info({ threadId: this.threadId, turnId: activeTurnId }, 'codex delivery bytes accepted by app-server steer channel')
        return { turnId: activeTurnId }
      } catch {
        // steer 竞态输给正在结束的 turn → 回退新起一轮。
      }
    }
    // @@@6112 空闲时 ❌ 不 turn/start:外部程序往一个 TUI 在显示的会话里送消息,官方的路是
    // `thread/queue/add`(codex 自带的 `codex queue` 命令、Remote Control 都走它)—— 由服务端在
    // thread 空闲时自己起轮。咕咕自己 turn/start 是「我就是界面」的客户端才用的那条路。
    // 注意官方语义:上一轮被中断(用户按了 Esc)后,队列**不自动续跑**,等人发话。
    return this.enqueue(client, this.threadId, input)
  }

  /** 接入已完成 → true;还没开始 / 还在进行 → false;失败 → 抛(fail-loud)。非 tuiLoads 恒为 true。 */
  private adoptedThreadAttachedSettled(): boolean {
    if (!this.adoptedFromTui) return true
    const state = this.attachState
    if (state.kind === 'failed') throw state.error
    return state.kind === 'done'
  }

  private async enqueue(
    client: CodexRpcClient,
    threadId: string,
    input: Array<Record<string, unknown>>,
  ): Promise<CodexTurnRef> {
    const clientUserMessageId = crypto.randomUUID()
    let entry!: { submissionId: string | null; resolve: (turnId: string) => void; reject: (error: unknown) => void }
    const dispatched = new Promise<string>((resolve, reject) => { entry = { submissionId: null, resolve, reject } })
    dispatched.catch(() => undefined)
    // 先登记再入队:服务端可能在 add 的回应之前就派发并发出 item/started。
    this.queuedDeliveries.set(clientUserMessageId, entry)
    let submissionId: string | undefined
    try {
      const added = (await client.rpc('thread/queue/add', {
        threadId,
        input,
        clientUserMessageId,
      })) as { queuedSubmission?: { id?: string } }
      submissionId = added.queuedSubmission?.id
      if (!submissionId) throw new Error('codex app-server thread/queue/add returned an empty submission id')
      entry.submissionId = submissionId
      // 排进队列的这一条会成为 thread 的第一条用户消息 ⇒ 之后的投递要先读在跑的轮(才能 steer)。
      // 服务端若还没起轮,读会被以「尚未 materialize」拒绝,deliver 里原有的拒绝处理会退回 unmaterialized。
      this.threadMaterialization = 'materialized'
      deliveryLog.info({ threadId, submissionId }, 'codex delivery queued on app-server (thread/queue/add)')
      // 上一轮若被中断,队列停着不动 —— 显式起这一条;没停则服务端答「已有待起的轮」,见 startQueuedDelivery。
      // 只在 TUI 已载入、咕咕已接入之后起:在那之前起轮,TUI 又成了「中途加入」(#6112 的病根)。
      if (this.adoptedThreadAttachedSettled()) await this.startQueuedDelivery(client, threadId, submissionId)
    } catch (error) {
      if (this.queuedDeliveries.get(clientUserMessageId) === entry) this.queuedDeliveries.delete(clientUserMessageId)
      throw error
    }
    return { turnId: submissionId, queued: true, dispatched }
  }

  waitForTurnCompletion(turnId: string): Promise<void> {
    if (this.terminalError) return Promise.reject(this.terminalError)
    return this.turnCompletions.wait(turnId).catch(async (error) => {
      if (!(error instanceof Error) || !error.message.includes('did not emit turn/completed within')) {
        throw error
      }
      const client = this.client
      const threadId = this.threadId
      if (!client || !threadId) throw error
      let status: CodexTurnCompletionStatus = 'unknown'
      let persistedTurn: unknown = undefined
      try {
        persistedTurn = await client.rpc('thread/read', { threadId, includeTurns: true })
        status = codexTurnCompletionStatus(persistedTurn, threadId, turnId)
      } catch {
        throw error
      }
      if (status === 'completed') return
      if (status === 'failed') {
        const detail = codexTurnFailureMessage(codexTurnFromThread(persistedTurn, threadId, turnId))
        throw new Error(
          `codex app-server turn ${turnId} reached a failed terminal state${detail ? `: ${detail}` : ''}`,
        )
      }
      throw error
    })
  }

  async waitForTurnLive(turnId: string, timeoutMs = 8000): Promise<void> {
    if (this.terminalError) throw this.terminalError
    await this.turnStarts.wait(turnId, timeoutMs)
    await new Promise<void>((resolve) => setTimeout(resolve, 700))
    if (this.terminalError) throw this.terminalError
  }

  /**
   * @@@fork-identity 在本会话 thread 的历史末尾追加模型可见条目(官方 `thread/inject_items`)。
   * 目前唯一用途:分叉后补上新 agent 的身份(openai/codex#19045 的临时方案,见 codex-fork-handoff)。
   */
  async injectItems(items: readonly unknown[]): Promise<void> {
    const client = this.client
    if (!client || !this.threadId) throw new Error('codex app-server 会话未建立(fail-loud)')
    await client.rpc('thread/inject_items', { threadId: this.threadId, items })
  }

  /** 往**正在跑的** turn 中途插入(owner #85 的 steer);expectedTurnId 不匹配活跃 turn 则 codex 报错。 */
  async steer(text: string, expectedTurnId: string): Promise<void> {
    const client = this.client
    if (!client || !this.threadId) throw new Error('codex app-server 会话未建立(fail-loud)')
    await client.rpc('turn/steer', {
      threadId: this.threadId,
      input: [{ type: 'text', text, text_elements: [] }],
      expectedTurnId
    })
  }

  /**
   * @@@4526B 取消**当前在飞的**那些轮。dispose 里本来就这么收(只是随后还要等结算再拆进程);
   * owner 删除走的是同一个动作,但**只取消不拆会话** —— 会话与进程的去留是另一件事。
   * 返回 false = 此刻没有在飞的轮,是 no-op 不是失败。
   */
  async cancelActiveTurns(): Promise<boolean> {
    if (!this.isTurnInFlight()) return false
    await this.interruptActiveTurns()
    return true
  }

  /** Re-arm completion deadlines after a host suspend/resume boundary. */
  resumeAfterHostWake(): void {
    this.turnCompletions.resume()
  }

  /** 中断某一轮。 */
  async interrupt(turnId: string): Promise<void> {
    const client = this.client
    if (!client || !this.threadId) throw new Error('codex app-server 会话未建立(fail-loud)')
    await client.rpc('turn/interrupt', { threadId: this.threadId, turnId })
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    const closed = new CodexSessionClosedError('codex app-server 会话已关闭(dispose)')
    this.rejectTuiThreadWaiters(closed)
    this.rejectQueuedDeliveries(closed)
    const dispose = async () => {
      await this.interruptActiveTurns()
      const settleError = await this.waitForPendingTurnsToSettle()
      this.turnCompletions.dispose(settleError ?? undefined)
      this.turnStarts.dispose()
      this.client?.close()
      this.client = null
      const backend = this.backend
      if (backend) {
        await backend.terminate()
        this.backend = null
      }
      const appServer = this.appServer
      if (appServer) {
        await appServer.stop({ graceMs: 5_000, killMs: 1_000 })
        const closeResult = await waitForCodexAppServerProcessClose(appServer.child)
        if (closeResult.status === 'timed-out') this.stderrCloseTimeoutMs = closeResult.timeoutMs
        if (this.pidfilePgid !== null) {
          // Shutdown can race the atomic pidfile write. Let its rename settle before compare-and-delete,
          // otherwise a late rename would recreate a ledger for a group already proved terminal.
          await this.pidfileWritePromise?.catch(() => undefined)
          await deleteEnginePidfile(
            this.agentKey,
            this.sessionId,
            null,
            this.pidfilePgid,
          )
        }
        this.proc = null
        this.appServer = null
        this.pidfilePgid = null
        this.pidfileWritePromise = null
      }
      removeCodexAppServerEndpoint(this.endpoint)
      this.endpoint = null
      this.modelCatalog?.dispose()
      this.modelCatalog = null
      this.threadId = null
      this.threadMaterialization = 'unknown'
      trackedCodexAppServerSessions.delete(this)
      if (settleError) throw settleError
    }
    this.disposePromise = dispose().catch((error) => {
      this.disposePromise = null
      throw error
    })
    return this.disposePromise
  }

  private reportProcessError(error: Error): void {
    deliveryLog.error(
      { agent: this.agentKey, sessionId: this.sessionId, err: error.message },
      'codex app-server process error',
    )
  }

  /** 崩溃 / 信号路径。tmux 里那台 ❌ 杀:它本就该活过宿主(孤儿由 tmux 钩子与下次启动的对账收)。 */
  killProcessGroupSync(): void {
    this.appServer?.kill('SIGKILL')
  }
}

export function trackedCodexAppServerRunCount(): number {
  return trackedCodexAppServerSessions.size
}

export function resumeAllCodexAppServerTurnWaiters(): void {
  for (const session of trackedCodexAppServerSessions) session.resumeAfterHostWake()
}

/**
 * 宿主关停。#6264 住在 tmux 里的只断开(TUI 还在 tmux 里用着它,新宿主会接回);其余照旧拆掉。
 * 终端会话已经不在的那几台由 tmux 的 session-closed 钩子当场收掉,漏网的下次启动对账时收。
 */
export async function disposeAllCodexAppServerSessions(): Promise<void> {
  const sessions = [...trackedCodexAppServerSessions]
  for (const session of sessions) if (session.isTmuxHosted()) session.detach()
  const results = await Promise.allSettled(
    sessions.filter((session) => trackedCodexAppServerSessions.has(session)).map((session) => session.dispose()),
  )
  const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Codex app-server cleanup failed')
}

export function killAllCodexAppServerProcessGroupsSync(): void {
  for (const session of trackedCodexAppServerSessions) session.killProcessGroupSync()
}

/**
 * codex-TUI agent 的投递目标(delivery-bridge 的第二 driver 用):把 gugu agentUserId 映射到它的 codex
 * app-server 会话,`injectMessage` = 往该会话投一条新一轮(turn/start,忙时 steer)。实现 SessionpageDeliveryTarget:
 * 未映射 → `liveSessionIdByAgent` 返回 null(delivery-bridge 透传给下一 target / inner);映射了但会话死 →
 * `tryInjectMessage` 返回 false,上层保留本机债务(❌ 无 pty 兜底)。回复由 agent 经注入的
 * gugu MCP 自发回(与 ACP 路一致),此处不写回、不做 NO_REPLY。
 */
export class CodexAppServerRegistry implements SessionpageDeliveryTarget {
  readonly deliveryTargetName = 'codex-app-server'
  readonly deliveryToolNames = resolveSessionTuiDeliveryToolNames('codex')
  private readonly byAgent = new Map<string, { session: CodexAppServerSession; providerId: string }>()
  private liveHooks: { onLive: (registration: { guguAgentUserId: string; sessionId: string }) => void } | null = null
  private readonly firstDeliveryWaiters = new Map<string, {
    resolve: () => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()

  register(guguAgentUserId: string, session: CodexAppServerSession, providerId: string): void {
    if (!providerId) {
      throw new Error('[sessionpage] codex app-server 投递登记缺 providerId(注入时机声明按它查)')
    }
    const entry = { session, providerId }
    this.byAgent.set(guguAgentUserId, entry)
    // 转 live = TUI 载入 thread 且投递连接已接入。由会话在那一刻回调,
    // 与 claude 腿的 setLiveHooks 同一形状:就绪信号只有一个产地。
    session.onThreadLive(() => {
      if (this.byAgent.get(guguAgentUserId) !== entry) return
      const sessionId = session.productSessionId
      if (!sessionId) return
      this.liveHooks?.onLive({ guguAgentUserId, sessionId })
    })
  }

  /** spec delivery-routing「session-live 的产地」:TUI thread 与投递连接均已接入。 */
  setLiveHooks(hooks: { onLive: (registration: { guguAgentUserId: string; sessionId: string }) => void } | null): void {
    this.liveHooks = hooks
  }

  /** Owner 编排的释放契约名:释放含 app-server 处置(异步),没有同步释放点(无 releaseAgentClaim)。 */
  unregisterAgent(guguAgentUserId: string, onReleased?: () => void): Promise<void> {
    return this.unregister(guguAgentUserId, onReleased)
  }

  async unregister(guguAgentUserId: string, replaceAfterRelease?: () => void): Promise<void> {
    const entry = this.byAgent.get(guguAgentUserId)
    if (!entry) {
      replaceAfterRelease?.()
      return
    }
    const threadId = entry.session.threadId
    try {
      await entry.session.dispose()
    } finally {
      if (this.byAgent.get(guguAgentUserId) === entry) {
        this.byAgent.delete(guguAgentUserId)
        replaceAfterRelease?.()
      }
      if (threadId) {
        this.rejectFirstDeliveryWaiter(
          threadId,
          new Error(`codex app-server 会话 ${threadId} closed before first injected turn`),
        )
      }
    }
  }

  /**
   * 该 agent 被本认领者接管的那条**产品 conversation**,或 null(不归我 → delivery-bridge 透传给下一 target)。
   *
   * @@@4629 报的是 conversation,❌ 不是 threadId —— 接口(`SessionpageDeliveryTarget`)写的就是这个意思,
   * claude / opencode / droid / local-session 四家也都照它实现。这一格曾经报 threadId,于是任何按
   * 「agentUserId → 产品 conversation」解析的消费者到了 codex 腿就拿到一个**根本不是 conversation 的 id**:
   * `session_spawn` 的启动委托是一条按 conversation 键控的本机 outbox 行,取不到它,pty child 就永远等不到
   * 首轮投递,在 `settle` 挂满 `waitForNextInjectedTurnLive` 的 90s 后被补偿删除。
   * conversation → provider session 的那把钥匙在 `sessionIdForConversation`,两个方向各归各的。
   */
  liveSessionIdByAgent(guguAgentUserId: string): string | null {
    // #6531 登记即认领(与 claude / opencode / droid 同口径),❌ 不以 threadId 为准:@@@6112 新会话登记时
    // TUI 还没建出 thread,而 promoteSessionpageDeliveryOwner 已在同一回合摘掉离线占位 —— 这里若答 null,
    // 本机就有约 1s「无属主」,注入口 THROW「has no local session-page runtime」、读者向聊天披露失败,
    // 随后同一条消息又被 session-live 重拉送达。可不可投是另一把钥匙:sessionIdForConversation 在 threadId
    // 到位前为 null ⇒ 注入答 not-live 留在收件箱,接入完成由 onThreadLive 叫醒读者。
    // ❌ 不退化成 agentKey:那不是 conversation id,报出去只会让调用方稳定查空。
    return this.byAgent.get(guguAgentUserId)?.session.productSessionId ?? null
  }

  deliveryKeyForSession(sessionId: string): string | null {
    return [...this.byAgent.values()]
      .find((entry) => entry.session.belongsToSession(sessionId))?.session.threadId ?? null
  }

  isSessionTurnInFlight(sessionId: string): boolean {
    return [...this.byAgent.values()]
      .find((entry) => entry.session.belongsToSession(sessionId))?.session.isTurnInFlight() ?? false
  }

  /** app-server(detachedInference)拓扑可被多家选用;注入时机按这条会话上那家的声明查。 */
  sessionProviderSurface(threadId: string): { providerId: string; surface: 'tui' } | null {
    const entry = [...this.byAgent.values()].find((candidate) => candidate.session.threadId === threadId)
    return entry ? { providerId: entry.providerId, surface: 'tui' } : null
  }

  /** Host recovery admission: the app-server thread must be registered and live after reload. */
  async waitUntilReady(sessionId: string): Promise<void> {
    const session = [...this.byAgent.values()]
      .map((entry) => entry.session)
      .find((candidate) => candidate.belongsToSession(sessionId))
    if (!session?.threadId || !session.isLive()) {
      throw new Error(`codex app-server session ${sessionId} is not live after reopen`)
    }
  }

  async tryInjectSessionMessage(
    threadId: string,
    message: { id: string; text: string; kind?: 'ordinary' | 'session-direct' },
  ): Promise<false | SessionpageTurnReceipt> {
    return this.tryInjectMessage(threadId, message.text)
  }

  /**
   * @@@4526B SessionpageDeliveryTarget.cancelTurn —— 取消本管理器为这个 agent 认领的会话里在飞的轮。
   * 按 agentUserId 键入,与同接口的 `liveSessionIdByAgent` / `unregisterAgent` 同一把钥匙。
   * 没认领 / 没有在飞的轮都返回 false(no-op);`turn/interrupt` 本身失败照常抛。
   */
  async cancelTurn(agentUserId: string): Promise<boolean> {
    const session = this.byAgent.get(agentUserId)?.session
    if (!session) return false
    return session.cancelActiveTurns()
  }

  recentActionsForAgent(guguAgentUserId: string): { actions: string[]; lastActionAt: string | null } | null {
    return this.byAgent.get(guguAgentUserId)?.session.recentActionsSnapshot() ?? null
  }

  waitForNextInjectedTurnLive(threadId: string, timeoutMs = 90_000): Promise<void> {
    const session = [...this.byAgent.values()]
      .map((entry) => entry.session)
      .find((candidate) => candidate.threadId === threadId)
    if (!session?.isLive()) {
      return Promise.reject(new Error(
        `codex app-server 会话 ${threadId} 不 live — 无法等待首条投递(fail-loud)`,
      ))
    }
    if (this.firstDeliveryWaiters.has(threadId)) {
      return Promise.reject(new Error(`codex app-server 会话 ${threadId} 已在等待首条投递`))
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.firstDeliveryWaiters.delete(threadId)) return
        reject(new Error(
          `codex app-server 会话 ${threadId} did not receive an injected first turn within ${timeoutMs}ms`,
        ))
      }, timeoutMs)
      this.firstDeliveryWaiters.set(threadId, { resolve, reject, timer })
    })
  }

  async tryInjectMessage(threadId: string, text: string): Promise<false | SessionpageTurnReceipt> {
    const session = [...this.byAgent.values()]
      .map((entry) => entry.session)
      .find((candidate) => candidate.threadId === threadId)
    if (!session?.isLive()) return false
    try {
      deliveryLog.info({ threadId }, 'codex tryInjectMessage entered provider delivery')
      const turn = await session.deliver(text)
      deliveryLog.info({ threadId, turnId: turn.turnId, queued: Boolean(turn.queued) }, 'codex tryInjectMessage reached provider delivery')
      if (turn.queued) {
        // 消息已在 codex 自己的队列里(TUI 可见)。completion 跟到它**真正起成的那一轮**结束为止:
        // 起轮以 item/started 认领(见 CodexTurnRef.dispatched),结束以 turn/completed 为准 ——
        // 那一轮失败(如中转 403)照样作为失败交给下游,❌ 不在准入那一刻就报成功。
        const dispatched = turn.dispatched
        if (!dispatched) throw new Error('codex queued delivery has no dispatch tracking (fail-loud)')
        return {
          turnId: turn.turnId,
          queued: true,
          completion: dispatched.then((turnId) => session.waitForTurnCompletion(turnId)),
        }
      }
      const firstDeliveryWaiter = this.firstDeliveryWaiters.get(threadId)
      if (firstDeliveryWaiter) {
        session.waitForTurnLive(turn.turnId).then(
          () => {
            if (this.firstDeliveryWaiters.get(threadId) !== firstDeliveryWaiter) return
            this.firstDeliveryWaiters.delete(threadId)
            clearTimeout(firstDeliveryWaiter.timer)
            deliveryLog.info({ threadId, turnId: turn.turnId }, 'codex first-delivery waiter resolved')
            firstDeliveryWaiter.resolve()
          },
          (error: unknown) => {
            if (this.firstDeliveryWaiters.get(threadId) !== firstDeliveryWaiter) return
            this.firstDeliveryWaiters.delete(threadId)
            clearTimeout(firstDeliveryWaiter.timer)
            firstDeliveryWaiter.reject(error instanceof Error ? error : new Error(String(error)))
          },
        )
      }
      return {
        turnId: turn.turnId,
        completion: session.waitForTurnCompletion(turn.turnId),
      }
    } catch (error) {
      this.rejectFirstDeliveryWaiter(
        threadId,
        error instanceof Error ? error : new Error(String(error)),
      )
      if (!session.isLive()) return false
      throw error
    }
  }

  private rejectFirstDeliveryWaiter(threadId: string, error: Error): void {
    const waiter = this.firstDeliveryWaiters.get(threadId)
    if (!waiter) return
    this.firstDeliveryWaiters.delete(threadId)
    clearTimeout(waiter.timer)
    waiter.reject(error)
  }
}

/** 模块级单例(镜像 emdashAgentRegistry)。空 registry = 零行为变化;仅当 provisioning 把某
 *  codex-TUI agent 注册进来后,投递才路由到 app-server。 */
export const codexAppServerRegistry = new CodexAppServerRegistry()
// spec session-injection「认领者是注册表」:app-server 认领者自注册,owner 编排与 router 从
// 注册表消费 —— 内核不再具名 import 这一家。
registerSessionpageDeliveryTarget(codexAppServerRegistry)
