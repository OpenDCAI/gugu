// OpenCode serve/attach transport — readiness, prompt admission, turn-start receipt, teardown.
//
// serve 拓扑:gugu 持一个 `opencode serve`(推理在这里跑,吃 OPENCODE_CONFIG_CONTENT),用户看的 pty 里
// 跑 `opencode attach <url> --session <id>` 只渲染。本文件是那台 serve 的 HTTP/SSE 客户端与进程生命周期,
// 不碰 pty、不猜 keystroke。就绪判据、投递收据、杀树都在这里(spec opencode-serve-attach-readiness)。
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { NodeExecutionContext, spawnOwnedChild, type OwnedChild } from '@gugu/session-core/exec'
import { opencodeFamilyUpdatedTitle, pluginRegistry } from '@gugu/session-plugins/agents'
import { assertSessionRuntimeCompatible, versionProbeEnv } from '@main/core/agents/session-runtime-compatibility'
import type { SessionpageTurnReceipt } from './session-injection'
import type { TurnLifecycleEdge } from './turn-lifecycle-relay'
import { createLogger } from '../lib/logger'
import { launchTmuxBackend, type TmuxBackend, type TmuxBackendDeps } from './tmux-backend'

function serveLogger() {
  return createLogger('sessionpage/opencode-serve')
}

/** Reserve a loopback port by binding :0 then releasing it. Small TOCTOU window, same as codex/droid. */
export function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (!address || typeof address === 'string') {
        probe.close(() => reject(new Error('opencode serve: could not reserve a loopback port')))
        return
      }
      const port = address.port
      probe.close(() => resolve(port))
    })
  })
}

/**
 * Engine executability is a fact about the exact binary+env we will spawn serve with, not a guess.
 * Probe `--version` first so a missing/broken opencode fails loud here instead of as a dead serve
 * (spec: 引擎可执行性在起 serve 前用将要 spawn 的 env 探 `--version` 否则 fail loud).
 */
/**
 * #5331 `--version` 预检结果按(可执行文件, 它的 mtime+size)记住:同一份二进制不必每开一条会话就再 fork 一次
 * (实测 426–534 ms,纯挡在用户前面)。二进制被换掉(升级、切版本)⇒ 指纹变了 ⇒ 自动重检。
 * 拿不到指纹(命令在 PATH 上、stat 不到)就不记,退回每次都检 —— 宁可慢,不可认错版本。
 */
const opencodeVersionMemo = new Set<string>()

/** 命令不是绝对路径时按 PATH 自己找一遍 —— 找不到就不记忆(退回每次都检)。 */
async function resolveOnPath(command: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (isAbsolute(command)) return command
  if (command.includes('/')) return null
  for (const dir of (env.PATH ?? '').split(':')) {
    if (!dir) continue
    const candidate = join(dir, command)
    try {
      const st = await stat(candidate)
      if (st.isFile()) return candidate
    } catch { /* 下一个 */ }
  }
  return null
}

async function opencodeBinaryFingerprint(command: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const resolved = await resolveOnPath(command, env)
  if (!resolved) return null
  try {
    const st = await stat(resolved)
    return `${resolved}:${st.mtimeMs}:${st.size}`
  } catch {
    return null
  }
}

export async function assertOpencodeExecutable(
  providerId: string,
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<void> {
  // 记的是「这份二进制在**这一家**的声明下过了」:同一份二进制可以替两家跑,答案不通用(#6183)。
  const fingerprint = await opencodeBinaryFingerprint(command, env)
  const key = fingerprint ? `${providerId}:${fingerprint}` : null
  if (key && opencodeVersionMemo.has(key)) return
  await runOpencodeVersion(providerId, command, env, cwd)
  if (key) opencodeVersionMemo.add(key)
}

// 版本探针只有一个属主(#6183):它等 `--version` 退出这个事实,❌ 墙钟;失败时带出引擎自己的话、errno、PATH。
// 这里曾是一份 execFile + 10s 的私有探针,负载高时会把「慢」判成「opencode 起不来」。
async function runOpencodeVersion(
  providerId: string,
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<void> {
  const plugin = pluginRegistry.get(providerId)
  if (!plugin) throw new Error(`opencode serve: the ${providerId} plugin is not registered; refusing to start serve`)
  const probeEnv = versionProbeEnv(env)
  await assertSessionRuntimeCompatible({
    providerId,
    surface: 'tui',
    descriptor: plugin.capabilities.sessionBundle,
    executable: command,
    versionLine: plugin.capabilities.hostDependency.versionLine,
    executionContext: new NodeExecutionContext({ root: cwd, env: probeEnv }),
    env: probeEnv,
  })
}

export type OpencodeEvent = { type: string; properties?: Record<string, unknown> }

function eventProviderSessionId(ev: OpencodeEvent): string | null {
  const props = ev.properties
  if (props && typeof props === 'object' && typeof (props as { sessionID?: unknown }).sessionID === 'string') {
    return (props as { sessionID: string }).sessionID
  }
  return null
}

function eventStatusIsBusy(ev: OpencodeEvent): boolean {
  const status = ev.properties?.['status']
  return Boolean(status && typeof status === 'object' && (status as { type?: unknown }).type === 'busy')
}

/** opencode 对 `POST /session/{id}/abort`(TUI 里 Esc×2 走的就是它)报的 `session.error`。 */
function eventIsUserAbort(ev: OpencodeEvent): boolean {
  const err = ev.properties?.['error']
  return Boolean(err && typeof err === 'object' && (err as { name?: unknown }).name === 'MessageAbortedError')
}

function eventErrorMessage(ev: OpencodeEvent): string {
  const err = ev.properties?.['error']
  if (err && typeof err === 'object') {
    const data = (err as { data?: { message?: unknown } }).data
    if (data && typeof data.message === 'string') return data.message
    const name = (err as { name?: unknown }).name
    if (typeof name === 'string') return name
  }
  return 'opencode session error'
}

/** Single GET returning the HTTP status code, or rejecting on transport error / timeout. */
export function httpGetStatus(url: string, timeoutMs = 5_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', timeout: timeoutMs }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('timeout', () => { req.destroy(new Error('request timed out')) })
    req.on('error', reject)
    req.end()
  })
}

/**
 * @@@readiness — the load-bearing criterion, extracted so it is independently measurable.
 * serve is ready ONLY when its HTTP API truly answers `GET /global/health` → 200. Provably falsifiable:
 * a bound-but-unanswering port (connection refused, or any non-200) never satisfies this and rejects at
 * the deadline. Never accepts process-alive / port-bound / a "listening" log line as readiness.
 */
export async function awaitOpencodeServeReady(
  url: string,
  opts: {
    timeoutMs: number
    isDisposed?: () => boolean
    /** #6264 serve 不是本进程的子进程时(住在 tmux 里),每轮问一次它还在不在;不在当场失败,❌ 等满超时。 */
    isGone?: () => boolean
    pollIntervalMs?: number
    requestTimeoutMs?: number
  },
): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs
  const pollIntervalMs = opts.pollIntervalMs ?? 200
  let lastError = 'no response'
  while (Date.now() < deadline) {
    if (opts.isDisposed?.()) throw new Error('opencode serve: disposed during readiness wait')
    if (opts.isGone?.()) throw new Error('opencode serve: exited before its HTTP API answered')
    try {
      const status = await httpGetStatus(`${url}/global/health`, opts.requestTimeoutMs)
      if (status === 200) return
      lastError = `status ${status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await delay(pollIntervalMs)
  }
  throw new Error(`opencode serve: HTTP API did not answer within ${opts.timeoutMs}ms (${lastError})`)
}

/**
 * @@@task-home-config-isolation — assemble the serve process env. When the serve runs in gugu's OWN
 * app-owned task-home cwd (`isSessionHome`), set `OPENCODE_DISABLE_PROJECT_CONFIG` so OpenCode does not scan
 * that shared workspace's `.opencode`. That directory is shared across every no-repo agent and BOTH legs:
 * the acp leg legitimately writes its event module there and tolerates the install, and residue piles
 * up there too — but OpenCode turns any `.opencode/plugins/*.js` in the cwd into a plugin origin and gates
 * `session/new` (POST /session) on a cold `npm install @opencode-ai/plugin` into that workspace, which past
 * the readiness budget is the intermittent `request timed out: POST /session`. The serve is gugu's
 * inference process; in the task-home its config surface is exactly `OPENCODE_CONFIG_CONTENT` + the user's
 * GLOBAL config, never that shared cwd. A serve in a real user repo (`isSessionHome=false`) is left to read
 * its own repo `.opencode` — that config is promised to the user and never runs in task-home. Materialized
 * spawnEnv keys win over the inherited process env, same as every other leg.
 */
export function buildOpencodeServeEnv(input: {
  processEnv: NodeJS.ProcessEnv
  spawnEnv?: NodeJS.ProcessEnv
  isSessionHome: boolean
}): NodeJS.ProcessEnv {
  return {
    ...input.processEnv,
    ...(input.spawnEnv ?? {}),
    ...(input.isSessionHome ? { OPENCODE_DISABLE_PROJECT_CONFIG: 'true' } : {}),
  }
}

// @@@completion-upper-bound (mirror of codex CODEX_TURN_COMPLETION_TIMEOUT_MS) — a started turn that
// never emits a terminal SSE (session.idle / session.error) must not pin the in-flight fact forever.
// 15min is wide enough to never clip a legitimately long turn; past it we settle the turn as errored.
export const OPENCODE_TURN_COMPLETION_TIMEOUT_MS = 15 * 60_000

/**
 * The turn-boundary facts this transport publishes outward — the same edges every sidecar-backed
 * leg already speaks (`CodexTurnLifecycle`). Identical on purpose: the host relays both
 * through one adapter-agnostic `onTurnLifecycle` → `emitSessionpageAgentEvent`.
 */
export type OpencodeTurnLifecycle = TurnLifecycleEdge

/** The edges that end a live turn: `stop` (done, or `outcome:'cancelled'` for a user abort) and `error`. */
export type TurnTerminalEdge = Extract<TurnLifecycleEdge, { type: 'stop' | 'error' }>

function requiredStringProperty(ev: OpencodeEvent, key: string): string {
  const value = ev.properties?.[key]
  if (typeof value !== 'string' || !value) {
    throw new Error(`opencode serve ${ev.type} frame has no string properties.${key}: ${JSON.stringify(ev.properties ?? null)}`)
  }
  return value
}

/** `session.error` 结束这一轮:`MessageAbortedError`(用户中止)是被打断的 stop,其余是失败。 */
export function opencodeSessionErrorEdge(ev: OpencodeEvent): TurnTerminalEdge {
  return eventIsUserAbort(ev) ? { type: 'stop', outcome: 'cancelled' } : { type: 'error' }
}

/**
 * serve `/event` 上的等待 → 等待边:`permission.asked` / `permission.replied` 是批准,`question.asked` /
 * `question.replied` / `question.rejected` 是提问。开的那条叫 `id`,关的那条叫 `requestID`,缺了就抛;
 * 不是这两族返回 null。
 */
export function opencodeWaitEdge(ev: OpencodeEvent): TurnLifecycleEdge | null {
  switch (ev.type) {
    case 'permission.asked':
      return { type: 'wait', waitKind: 'approval', waitId: requiredStringProperty(ev, 'id') }
    case 'question.asked':
      return { type: 'wait', waitKind: 'question', waitId: requiredStringProperty(ev, 'id') }
    case 'permission.replied':
    case 'question.replied':
    case 'question.rejected':
      return { type: 'wait_resolved', waitId: requiredStringProperty(ev, 'requestID') }
    default:
      return null
  }
}

export interface OpencodeServeOptions {
  /**
   * 这台 serve 替哪一家跑(opencode / mimocode 共用这条适配器)。版本探针按**这一家**的 `tui`
   * 声明判 —— ❌ 写死 opencode:mimocode 0.1.13 会被拿去对 opencode 的 1.18.23 下限,整条腿起不来(#6183 实测)。
   */
  providerId: string
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  /** Provider-native session-create fields, kept separate from the serve process environment. */
  sessionCreatePatch?: Readonly<{ agent?: string }>
  /** How long to wait for the HTTP API to actually answer before failing loud. */
  readyTimeoutMs?: number
  /** How long a 204-admitted prompt has to actually start a turn before we call it a silent drop. */
  turnStartTimeoutMs?: number
  /**
   * Upper bound on a STARTED turn's completion. Symmetric to turnStartTimeoutMs: that one bounds
   * "204 admitted but no turn started"; this one bounds "turn started but no terminal SSE ever
   * arrives" (backend silently dies, gateway 4xx/5xx with no error frame, dropped stream). Past it
   * the in-flight fact is settled as errored so authority `running` cannot be pinned forever.
   */
  completionTimeoutMs?: number
  /**
   * Publish this session's turn boundaries outward, once per edge. The transport already derives the
   * in-flight fact from `/event`; this hands the SAME edges to the host so the session-page agent status
   * (the badge) has a producer. Without it the leg emits no AgentEvent at all — the badge is only ever
   * pushed INTO working (synthetic start on pty input) and nothing ever pulls it back out.
   */
  onTurnLifecycle?: (lifecycle: OpencodeTurnLifecycle) => void
  /**
   * #6264 attach 那个 TUI 住在 tmux 里时,serve 也住进 tmux(会话名见 tmux-backend.backendSessionNameFor),
   * 活过宿主进程重启,新宿主按名字接回同一个端口。缺席 = 照旧做宿主的子进程。只对 posix 生效。
   */
  tmuxBackendName?: string
  tmuxBackendDeps?: TmuxBackendDeps
  /** 这一家给这条会话起了名(`session.updated`,见 `opencodeFamilyUpdatedTitle`)。 */
  onSessionTitle?: (title: string) => void
}

/**
 * One `opencode serve` process plus its single session, owned by one gugu agent.
 *
 * Readiness = the HTTP API truly answers (`GET /global/health` → 200), never process-alive / port-bound /
 * a "listening" log line. Turn lifecycle rides the serve-global `/event` SSE, demuxed by sessionID:
 * `session.status{busy}` = a turn is live, `session.idle` = it finished, `session.error` = it failed.
 *
 * Those edges have three consumers, all fed from this one stream: the delivery receipt's completion
 * promise, the bounded in-flight fact, and — via `onTurnLifecycle` — the host's session-page agent status.
 * ❌ Never a second channel for the same fact: the workspace event module's `GUGU_HOOK_*` POST would
 * be exactly that, and it is structurally unavailable here anyway (those vars are pty-scoped, and the
 * pty runs `attach`, which owns no session bus).
 */
export class OpencodeServeSession {
  readonly url: string
  readonly port: number
  providerSessionId: string | null = null

  private readonly providerId: string
  private readonly command: string
  private readonly cwd: string
  private readonly env: NodeJS.ProcessEnv
  private readonly sessionCreatePatch: Readonly<{ agent?: string }> | undefined
  private readonly readyTimeoutMs: number
  private readonly turnStartTimeoutMs: number
  private readonly completionTimeoutMs: number
  private readonly onTurnLifecycle?: (lifecycle: OpencodeTurnLifecycle) => void
  private readonly onSessionTitle?: (title: string) => void
  /** `session.updated` 每改一格都发一次;同一个名只往外报一次。 */
  private lastSessionTitle: string | null = null

  private serve: OwnedChild | null = null
  /** #6264 serve 住在 tmux 里时的那台(与 serve 二选一)。 */
  private backend: TmuxBackend | null = null
  private readonly tmuxBackendName: string | null
  private readonly tmuxBackendDeps: TmuxBackendDeps | undefined
  private disposePromise: Promise<void> | null = null
  private sse: http.ClientRequest | null = null
  private disposed = false
  private busy = false
  /** When the current turn started — set ONCE on the idle→busy edge, not refreshed per busy. Bounds in-flight duration. */
  private busySince: number | null = null
  /** Completion watchdog: fires when a started turn emits no terminal SSE within the budget. */
  private busyWatchdog: ReturnType<typeof setTimeout> | null = null
  /** Waiters for the next terminal turn signal (idle → resolve, error → reject), created before each POST. */
  private turnWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = []
  /** Waiters for the next busy transition (turn-start confirmation). */
  private busyWaiters: Array<() => void> = []

  constructor(port: number, options: OpencodeServeOptions) {
    this.port = port
    this.url = `http://127.0.0.1:${port}`
    this.providerId = options.providerId
    this.command = options.command
    this.cwd = options.cwd
    this.env = options.env
    this.sessionCreatePatch = options.sessionCreatePatch
    this.readyTimeoutMs = options.readyTimeoutMs ?? 20_000
    this.turnStartTimeoutMs = options.turnStartTimeoutMs ?? 30_000
    this.completionTimeoutMs = options.completionTimeoutMs ?? OPENCODE_TURN_COMPLETION_TIMEOUT_MS
    this.onTurnLifecycle = options.onTurnLifecycle
    this.onSessionTitle = options.onSessionTitle
    this.tmuxBackendName = process.platform !== 'win32' ? options.tmuxBackendName ?? null : null
    this.tmuxBackendDeps = options.tmuxBackendDeps
  }

  /** serve 进程还在:子进程看退出码,tmux 里那台看 pid(一次 kill(pid, 0))。 */
  isAlive(): boolean {
    if (this.backend) return this.backend.isAlive()
    return Boolean(this.serve && this.serve.child.exitCode == null && this.serve.child.signalCode == null)
  }

  /** #6264 这台 serve 住在 tmux 里(宿主退出只断开,不杀)。 */
  isTmuxHosted(): boolean {
    return this.backend !== null
  }

  /**
   * #6264 接回上一个宿主留在 tmux 里的那台 serve:不起进程,证明 HTTP 真在应答、那条原生会话还在,再接上 /event。
   * 回合是否正在跑不先猜:opencode 在一轮里会反复发 `session.status{busy}`,下一帧就把事实补上。
   */
  async adopt(backend: TmuxBackend, providerSessionId: string): Promise<string> {
    this.backend = backend
    await awaitOpencodeServeReady(this.url, { timeoutMs: 5_000, isDisposed: () => this.disposed })
    const { status, body } = await this.requestJson('GET', `/session/${encodeURIComponent(providerSessionId)}`)
    if (status !== 200 || (body as { id?: unknown } | null)?.id !== providerSessionId) {
      throw new Error(`opencode serve: adopted serve has no session ${providerSessionId} (status ${status})`)
    }
    this.providerSessionId = providerSessionId
    this.connectEventStream()
    serveLogger().info({ port: this.port, pid: backend.pid, providerSessionId }, 'opencode serve adopted from tmux after a host restart')
    return providerSessionId
  }

  /**
   * #6264 宿主要走了,attach 还在 tmux 里用着这台 serve:只断开咕咕的 /event,❌ 杀进程。在等的调用方照 dispose 口径失败。
   */
  detach(): void {
    if (this.disposed) return
    this.disposed = true
    try { this.sse?.destroy() } catch { /* already closed */ }
    this.sse = null
    this.backend = null
    this.failAllWaiters(new Error('opencode serve detached (host exiting; serve stays in tmux)'))
  }

  /**
   * Boot serve and select its session. Forking is an HTTP operation, not an ACP operation: the
   * official OpenCode SDK/TUI call `client.session.fork({ sessionID, messageID? })`, backed by
   * `POST /session/{id}/fork` (Context7: https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/session.ts
   * and https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/routes/session/dialog-fork-from-timeline.tsx).
   */
  async start(resumeProviderSessionId: string | null, forkFromProviderSessionId?: string): Promise<string> {
    if (resumeProviderSessionId && forkFromProviderSessionId) {
      throw new Error('opencode serve: resume and fork session ids are mutually exclusive')
    }
    // #5331 分段账本:serve 起来这一段在 owner 机器上实测 6.6 s,而同一台机裸跑 `opencode serve` 只要 1.0 s。
    // 差额在哪必须说得出 —— 三格分别是「查可执行文件」「HTTP API 真的应答」「建会话」。
    const startedAt = Date.now()
    const serveSteps: Record<string, number> = {}
    let lastMark = 0
    const mark = (name: string): void => {
      const at = Date.now() - startedAt
      serveSteps[name] = at - lastMark
      lastMark = at
    }
    await assertOpencodeExecutable(this.providerId, this.command, this.env, this.cwd)
    mark('executable-checked')
    // Own the whole tree so teardown can reap it (serve spawns transient tool subprocesses
    // mid-turn — bash/task). detached:true makes the child a group leader (pgid === pid) on posix.
    const serveArgs = ['serve', '--port', String(this.port), '--hostname', '127.0.0.1']
    if (this.tmuxBackendName) {
      // #6264 住进 tmux(见 tmux-backend.ts):宿主退出只断开,新宿主按会话名接回同一个端口。
      // tmux 只在 Unix 上用,❌ 需要 Windows 的 `.cmd` 壳。
      this.backend = await launchTmuxBackend({
        name: this.tmuxBackendName,
        kind: 'opencode-serve',
        endpoint: this.url,
        command: this.command,
        args: serveArgs,
        env: this.env,
        cwd: this.cwd,
      }, this.tmuxBackendDeps)
    } else {
      const serve = spawnOwnedChild(this.command, serveArgs, {
        cwd: this.cwd,
        env: this.env,
        stdio: 'ignore',
        detached: process.platform !== 'win32',
        // @@@unhandled-error-event (#4942) — 为什么不能只挂 'exit':ChildProcess 的 'error'(spawn 失败、
        // kill 失败)是**另一条**通道,没有监听者时 Node 把它抛成未捕获异常 —— 在会话页宿主里等于宿主连同
        // 所有会话一起死,而不是这一条 serve 挂掉。这类失败是异步送达的,start() 外面那圈 try/catch 接不住它。
        // 挂的是**终身**出口(不随握手结束摘掉):serve 是长驻进程,teardown 期停不下来的树同样走这条路。
        // ❌ 不是吞错:照 exit 那条的语义把等待中的 waiter 一起判败,让失败在真正的调用点显形。
        onError: (error) => {
          serveLogger().error({ port: this.port, pid: serve.child.pid, err: error.message }, 'opencode serve child process error')
          if (!this.disposed) this.failAllWaiters(new Error(`opencode serve child process error: ${error.message}`))
        },
      })
      this.serve = serve
      const child = serve.child
      child.once('exit', (code, sig) => {
        if (this.disposed) return
        serveLogger().warn({ port: this.port, code, sig }, 'opencode serve exited before dispose')
        const dead = new Error(`opencode serve exited unexpectedly (code=${code ?? 'null'} sig=${sig ?? 'null'})`)
        this.failAllWaiters(dead)
      })
    }
    try {
      mark('spawned')
      await this.waitForReady()
      mark('http-answered')
      // Know which session is ours BEFORE the stream opens whenever we already can. Fork is a
      // request/response operation and does not need the event stream; doing it before connecting
      // also avoids attributing a neighbouring session's `session.forked` frame to this run.
      if (resumeProviderSessionId) {
        this.providerSessionId = resumeProviderSessionId
      } else if (forkFromProviderSessionId) {
        this.providerSessionId = await this.forkSession(forkFromProviderSessionId)
      }
      this.connectEventStream()
      const providerSessionId = this.providerSessionId ?? (await this.createSession())
      mark('session-created')
      this.providerSessionId = providerSessionId
      serveLogger().info(
        { port: this.port, cwd: this.cwd, totalMs: Date.now() - startedAt, steps: serveSteps },
        'opencode serve start steps',
      )
      return providerSessionId
    } catch (error) {
      try {
        await this.dispose()
      } catch (disposeError) {
        throw new AggregateError(
          [error, disposeError],
          `opencode serve startup and cleanup both failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      throw error
    }
  }

  /**
   * Deliver one user message and hand back a turn receipt. 204 means "admitted to the store", NOT
   * "a turn started" — so we still confirm turn-start over SSE and fail loud on the silent-drop shape
   * (204 then no busy, no idle: e.g. a mis-routed model that never runs). completion resolves on the
   * next `session.idle`, rejects on `session.error`.
   */
  async injectPrompt(text: string): Promise<SessionpageTurnReceipt> {
    const providerSessionId = this.providerSessionId
    if (!providerSessionId) throw new Error('opencode serve: no session to inject into')
    const turnId = randomUUID()
    // Consult the BOUNDED in-flight fact, not raw `this.busy`: a prior turn that is over budget (its
    // terminal SSE was lost) must not let a genuinely new prompt skip its own turn-start confirmation.
    // This read comes FIRST, before this turn registers anything: over budget it SETTLES the prior turn,
    // and settling clears and rejects EVERY registered waiter. Read after registration, it would reject
    // this turn's completion with the previous turn's error and leave the genuinely live turn with no
    // waiter at all — the very defect this bound exists to close, taking another route.
    const wasBusy = this.isTurnInFlight()
    // Register the terminal-signal waiter BEFORE the POST so a fast idle/error cannot be missed.
    const completion = new Promise<void>((resolve, reject) => {
      this.turnWaiters.push({ resolve, reject })
    })
    // Suppress unhandled-rejection noise if the caller does not await completion synchronously.
    completion.catch(() => {})
    const turnStarted = wasBusy ? Promise.resolve() : this.awaitBusy(this.turnStartTimeoutMs)

    // OpenCode 1.18.x applies the default `build` agent when prompt_async omits `agent`, even
    // after POST /session created the session with `{ agent: 'plan' }`. Read the engine's current
    // native agent before every prompt: a live Plan ↔ Edit change must win over the startup value,
    // regardless of which mode the session had when it was created. This adds one GET per message
    // by design; if the read fails, throw and do not send this prompt rather than overwrite a live
    // setting with a stale snapshot.
    const currentAgent = await this.readCurrentSessionAgent(providerSessionId)
    const status = await this.postJson(`/session/${providerSessionId}/prompt_async`, {
      ...(currentAgent ? { agent: currentAgent } : {}),
      parts: [{ type: 'text', text }],
    })
    if (status !== 204) {
      throw new Error(`opencode serve: prompt_async returned ${status}, expected 204`)
    }
    await turnStarted
    return { turnId, completion }
  }

  /** Cancel the in-flight turn (POST /session/{id}/abort). Returns false when there was no live turn. */
  async abort(): Promise<boolean> {    const providerSessionId = this.providerSessionId
    if (!providerSessionId) return false
    const wasBusy = this.isTurnInFlight()
    const status = await this.postJson(`/session/${providerSessionId}/abort`, {})
    if (status !== 200) throw new Error(`opencode serve: abort returned ${status}, expected 200`)
    return wasBusy
  }

  /**
   * Authoritative turn-in-flight fact, held for the WHOLE turn: true from the SSE `session.status{busy}`
   * that starts a turn until the `session.idle`/`session.error` that ends it — not a start-of-turn flash.
   *
   * Bounded read: a turn whose terminal SSE was lost (backend silent death, dropped stream) must not
   * report in-flight forever, or the runtime host projects `running` authority that never falls back.
   * Over budget, this SETTLES the turn as errored on read (not merely reporting false) — otherwise `busy`
   * would stay true and the next idle→busy edge would fail to record a fresh turn start. That mirrors
   * codex's isActive(), which likewise settles on read rather than returning a value the state contradicts.
   * The busyWatchdog is the active settle for a turn no one reads; this lazy path is the belt-and-suspenders
   * that self-heals presence even if that timer is delayed under load.
   */
  isTurnInFlight(): boolean {
    if (!this.busy) return false
    if (this.busySince != null && Date.now() - this.busySince >= this.completionTimeoutMs) {
      this.settleOverBudgetTurn()
      return false
    }
    return true
  }

  disposeSync(): void {
    // #6264 崩溃 / 信号路径:tmux 里那台本就该活过宿主 —— 只断开(孤儿由 tmux 钩子与下次启动的对账收)。
    if (this.backend) {
      this.detach()
      return
    }
    if (!this.release() || !this.serve) return
    const serve = this.serve
    // Terminate the whole tree (serve + any mid-turn tool subprocesses) we own. Never a machine-wide pattern kill.
    serve.kill('SIGTERM')
    setTimeout(() => {
      if (serve.child.exitCode == null && serve.child.signalCode == null) serve.kill('SIGKILL')
    }, 2_000).unref?.()
  }

  /** Stable zero: resolves only once the owned tree is gone; a tree that will not stop rejects this dispose. */
  async dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    const backend = this.backend
    if (backend) {
      // 会话真结束:整组收掉、关 tmux 会话。
      this.backend = null
      this.release()
      this.disposePromise = backend.terminate()
      return this.disposePromise
    }
    this.release()
    if (!this.serve) return
    this.disposePromise = this.serve.stop()
    return this.disposePromise
  }

  /** Mark disposed and fail the stream and the waiters; false when already disposed. */
  private release(): boolean {
    if (this.disposed) return false
    this.disposed = true
    try { this.sse?.destroy() } catch { /* already closed */ }
    this.sse = null
    this.failAllWaiters(new Error('opencode serve disposed'))
    return true
  }

  // @@@readiness = HTTP API 真实应答 —— 唯一判据在 awaitOpencodeServeReady(轮询 /global/health 到真的
  // 200,不认进程存活/端口占位)。实例路径直接委派它,保证真跑的就是那条被单测证伪过的判据,不另立第二份。
  private async waitForReady(): Promise<void> {
    await awaitOpencodeServeReady(this.url, {
      timeoutMs: this.readyTimeoutMs,
      isDisposed: () => this.disposed,
      isGone: () => this.backend !== null && !this.backend.isAlive(),
    })
  }

  /** Host recovery admission: re-check the real HTTP health and the resumed native session. */
  async waitUntilReady(expectedProviderSessionId: string): Promise<void> {
    await this.waitForReady()
    if (!expectedProviderSessionId || this.providerSessionId !== expectedProviderSessionId) {
      throw new Error('opencode serve native session does not match the registered owner')
    }
    const { status, body } = await this.requestJson('GET', `/session/${encodeURIComponent(expectedProviderSessionId)}`)
    if (status !== 200) throw new Error(`opencode serve: native session lookup returned ${status}, expected 200`)
    if ((body as { id?: unknown } | null)?.id !== expectedProviderSessionId) {
      throw new Error('opencode serve native session lookup returned a different session')
    }
    if (this.disposed || this.providerSessionId !== expectedProviderSessionId) {
      throw new Error('opencode serve native session was released or replaced during admission')
    }
  }

  private async createSession(): Promise<string> {
    const { status, body } = await this.requestJson('POST', '/session', this.sessionCreatePatch ?? {})
    if (status !== 200) throw new Error(`opencode serve: POST /session returned ${status}`)
    const id = (body as { id?: unknown }).id
    if (typeof id !== 'string' || !id.startsWith('ses_')) {
      throw new Error(`opencode serve: POST /session returned no session id (${JSON.stringify(body).slice(0, 200)})`)
    }
    return id
  }

  private async readCurrentSessionAgent(providerSessionId: string): Promise<string> {
    const { status, body } = await this.requestJson('GET', `/session/${encodeURIComponent(providerSessionId)}`)
    if (status !== 200) {
      throw new Error(`opencode serve: GET /session/${providerSessionId} returned ${status}`)
    }
    const agent = (body as { agent?: unknown } | null)?.agent
    // OpenCode omits `agent` for the native default `build`; that is a successful read of the
    // engine's current state, not a transport failure. Custom non-empty agent names remain facts
    // from the engine and are passed through unchanged below.
    if (agent === undefined) return 'build'
    if (typeof agent !== 'string' || !agent) {
      throw new Error(`opencode serve: GET /session/${providerSessionId} returned no agent`)
    }
    return agent
  }

  private async forkSession(sourceProviderSessionId: string): Promise<string> {
    const source = sourceProviderSessionId.trim()
    if (!source) throw new Error('opencode serve: fork source session id is empty')
    const path = `/session/${encodeURIComponent(source)}/fork`
    const { status, body } = await this.requestJson('POST', path)
    if (status !== 200) {
      throw new Error(
        `opencode serve: POST ${path} returned ${status}; response=${formatResponseBody(body)}`,
      )
    }
    const id = (body as { id?: unknown } | null)?.id
    if (typeof id !== 'string' || !id.startsWith('ses_')) {
      throw new Error(
        `opencode serve: POST ${path} returned no session id; response=${formatResponseBody(body)}`,
      )
    }
    return id
  }

  private connectEventStream(): void {
    const req = http.request(`${this.url}/event`, { method: 'GET' }, (res) => {
      res.setEncoding('utf8')
      let buffer = ''
      res.on('data', (chunk: string) => {
        buffer += chunk
        let sep: number
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          this.consumeFrame(frame)
        }
      })
      res.on('end', () => {
        if (!this.disposed) serveLogger().warn({ port: this.port }, 'opencode serve /event stream ended')
        this.noticeBackendGone()
      })
    })
    req.on('error', (error) => {
      if (!this.disposed) serveLogger().error({ port: this.port, err: error.message }, 'opencode serve /event error')
      this.noticeBackendGone()
    })
    req.end()
    this.sse = req
  }

  /** #6264 tmux 里那台没有 exit 事件:/event 断了就问一次它还在不在,不在就照子进程退出的口径判败。 */
  private noticeBackendGone(): void {
    if (this.disposed || !this.backend || this.backend.isAlive()) return
    serveLogger().warn({ port: this.port, pid: this.backend.pid }, 'opencode serve (tmux) exited before dispose')
    this.failAllWaiters(new Error('opencode serve exited unexpectedly (tmux-hosted)'))
  }

  private consumeFrame(frame: string): void {
    // SSE frame: one or more `data: <json>` lines. First event on connect is `server.connected`.
    const dataLine = frame.split('\n').find((line) => line.startsWith('data:'))
    if (!dataLine) return
    const payload = dataLine.slice('data:'.length).trim()
    if (!payload) return
    let ev: OpencodeEvent
    try { ev = JSON.parse(payload) as OpencodeEvent } catch { return }
    // Only this serve's own session matters; server-level events (server.connected) carry no sessionID.
    // A session-scoped frame arriving while our own id is still unknown is dropped rather than accepted:
    // the only such window is the `POST /session` round trip on a fresh session, during which no turn of
    // ours can exist yet. Accepting it would let a neighbouring session's `busy` light our in-flight fact
    // and publish a `start` for an agent that has not even been announced.
    const sid = eventProviderSessionId(ev)
    if (sid && sid !== this.providerSessionId) return
    switch (ev.type) {
      case 'session.status':
        if (eventStatusIsBusy(ev)) this.markBusy()
        break
      case 'session.idle':
        this.markIdle()
        break
      case 'session.updated': {
        const info = ev.properties?.['info'] as { id?: unknown } | undefined
        if (!this.providerSessionId || info?.id !== this.providerSessionId) break
        const title = opencodeFamilyUpdatedTitle(info)
        if (!title || title === this.lastSessionTitle) break
        this.lastSessionTitle = title
        this.onSessionTitle?.(title)
        break
      }
      case 'session.error':
        this.markError(new Error(eventErrorMessage(ev)), opencodeSessionErrorEdge(ev))
        break
      case 'permission.asked':
      case 'permission.replied':
      case 'question.asked':
      case 'question.replied':
      case 'question.rejected':
        this.relayWaitEdge(ev)
        break
      default:
        break
    }
  }

  /** 等待不是回合边界:收据、在飞事实、看门狗都不动,只多一条对外的边。 */
  private relayWaitEdge(ev: OpencodeEvent): void {
    let edge: TurnLifecycleEdge | null
    try {
      edge = opencodeWaitEdge(ev)
    } catch (error) {
      serveLogger().error(
        { port: this.port, type: ev.type, err: error instanceof Error ? error.message : String(error) },
        'opencode serve wait frame does not match the protocol; frame dropped',
      )
      return
    }
    if (edge) this.publishLifecycle(edge)
  }

  private markBusy(): void {
    // Record the turn-start instant ONCE, on the idle→busy edge, and arm the completion watchdog once.
    // The bound is a turn-DURATION upper bound (mirrors codex recording start once) — NOT an inter-heartbeat
    // gap. Refreshing busySince per busy event would tie the bound to opencode's busy cadence (unverified),
    // and an alive-but-stuck backend that keeps re-emitting busy would never expire — the exact failure the
    // bound exists to prevent.
    if (!this.busy) {
      this.busy = true
      this.busySince = Date.now()
      this.armCompletionWatchdog()
      // Same edge, one more consumer. opencode re-emits `busy` several times inside one turn (3 on a
      // healthy turn, 6 across a retrying one — measured), so publishing per frame would give the badge
      // a burst of `start`s instead of one turn.
      this.publishLifecycle({ type: 'start' })
    }
    const waiters = this.busyWaiters
    this.busyWaiters = []
    for (const resolve of waiters) resolve()
  }

  private markIdle(): void {
    this.settleBusy({ type: 'stop' })
    const waiters = this.turnWaiters
    this.turnWaiters = []
    for (const waiter of waiters) waiter.resolve()
  }

  private markError(error: Error, outcome: TurnTerminalEdge = { type: 'error' }): void {
    this.settleBusy(outcome)
    const waiters = this.turnWaiters
    this.turnWaiters = []
    for (const waiter of waiters) waiter.reject(error)
    // A busy waiter pending turn-start also ends here: the turn failed to start cleanly.
    const busyWaiters = this.busyWaiters
    this.busyWaiters = []
    for (const resolve of busyWaiters) resolve()
  }

  private failAllWaiters(error: Error): void {
    // A serve that exited/disposed is not in flight — clear the fact too, not just the waiters, or a
    // crash mid-turn strands isTurnInFlight() true forever (same disease this whole guard exists to cure).
    // A serve that died under a live turn ended that turn badly — that is an `error` terminal, not a stop.
    // A serve we ourselves tore down is not: `disposed` is set before this runs on the teardown path.
    this.settleBusy(this.disposed ? null : { type: 'error' })
    const turnWaiters = this.turnWaiters
    this.turnWaiters = []
    for (const waiter of turnWaiters) waiter.reject(error)
    const busyWaiters = this.busyWaiters
    this.busyWaiters = []
    for (const resolve of busyWaiters) resolve()
  }

  /**
   * The single place a live turn stops being live — and therefore the single place its terminal fact is
   * published. `outcome` says how it ended (done / interrupted / failed); publishing is gated on a turn actually having been
   * in flight, so the duplicate terminal frames opencode really sends (a failed turn emits `session.error`
   * AND two `session.idle` — measured) collapse to exactly one event.
   *
   * `outcome: null` clears the fact WITHOUT publishing — for a deliberate teardown, which is not a verdict
   * on the turn. Publishing `error` on app quit would persist an `error` status that nothing clears on the
   * next launch (stale-status cleanup only rewrites `working`), i.e. it would trade a stuck spinner for a
   * stuck failure. Only an *unexpected* serve death is a real error terminal.
   */
  private settleBusy(outcome: TurnTerminalEdge | null): void {
    const wasBusy = this.busy
    this.busy = false
    this.busySince = null
    if (this.busyWatchdog) {
      clearTimeout(this.busyWatchdog)
      this.busyWatchdog = null
    }
    if (wasBusy && outcome) this.publishLifecycle(outcome)
  }

  /** A host relay that throws is the host's problem, not this serve's: never let it break the stream. */
  private publishLifecycle(lifecycle: OpencodeTurnLifecycle): void {
    try {
      this.onTurnLifecycle?.(lifecycle)
    } catch (error) {
      serveLogger().warn(
        { port: this.port, lifecycle, err: error instanceof Error ? error.message : String(error) },
        'opencode serve turn-lifecycle subscriber threw',
      )
    }
  }

  // @@@completion-upper-bound — the completion-side mirror of awaitBusy's turn-start timeout. A started
  // turn whose terminal SSE is lost (silent backend death, dropped stream) settles as errored here, so
  // the in-flight fact — and the `running` authority projected from it — cannot be pinned forever.
  private armCompletionWatchdog(): void {
    if (this.busyWatchdog) clearTimeout(this.busyWatchdog)
    this.busyWatchdog = setTimeout(() => {
      this.busyWatchdog = null
      if (this.busy) this.settleOverBudgetTurn()
    }, this.completionTimeoutMs)
    this.busyWatchdog.unref?.()
  }

  // Single place the over-budget verdict is issued — from the watchdog timer, or lazily from
  // isTurnInFlight() when that timer ran late — so the two paths cannot settle the turn two different ways.
  private settleOverBudgetTurn(): void {
    serveLogger().warn(
      { port: this.port, budgetMs: this.completionTimeoutMs },
      'opencode serve turn emitted no terminal event within the completion budget — settling as errored',
    )
    this.markError(new Error(
      `opencode serve: turn did not settle within ${this.completionTimeoutMs}ms ` +
      '(no session.idle/session.error — backend likely died without a terminal event)',
    ))
  }

  private awaitBusy(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.busyWaiters = this.busyWaiters.filter((w) => w !== onBusy)
        reject(new Error(`opencode serve: prompt admitted (204) but no turn started within ${timeoutMs}ms`))
      }, timeoutMs)
      const onBusy = () => { clearTimeout(timer); resolve() }
      this.busyWaiters.push(onBusy)
    })
  }

  private postJson(path: string, body: unknown): Promise<number> {
    return this.requestJson('POST', path, body).then((r) => r.status)
  }

  private requestJson(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      // OpenCode's full-session fork contract permits a genuinely empty body. Keep that distinct
      // from `{}` so the request matches `client.session.fork({ sessionID })` exactly; a message-bound
      // fork is the only case that needs a JSON payload.
      const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body ?? {}), 'utf8')
      const headers = body === undefined
        ? undefined
        : { 'content-type': 'application/json', 'content-length': String(payload.length) }
      const req = http.request(
        `${this.url}${path}`,
        {
          method,
          timeout: 15_000,
          ...(headers ? { headers } : {}),
        },
        (res) => {
          res.setEncoding('utf8')
          let raw = ''
          res.on('data', (chunk: string) => { raw += chunk })
          res.on('end', () => {
            let parsed: unknown = null
            if (raw.trim()) { try { parsed = JSON.parse(raw) } catch { parsed = raw } }
            resolve({ status: res.statusCode ?? 0, body: parsed })
          })
        },
      )
      req.on('timeout', () => { req.destroy(new Error(`request timed out: ${method} ${path}`)) })
      req.on('error', reject)
      if (payload.length > 0) req.write(payload)
      req.end()
    })
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms).unref?.() })
}

function formatResponseBody(body: unknown): string {
  if (typeof body === 'string') return body
  try { return JSON.stringify(body) } catch { return String(body) }
}
