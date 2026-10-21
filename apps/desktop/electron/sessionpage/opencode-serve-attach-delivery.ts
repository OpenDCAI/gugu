// Session-page delivery for OpenCode's serve/attach leg. Never writes to a PTY.
//
// 与 droid 同形(每条映射会话拥有一个 sidecar),差在一处**说得出来的重量**:droid 的 daemon queue 把投递
// 收据吃掉了(add_user_message 落进耐久队列,返回 boolean 就够);opencode 的 `prompt_async` 204 只证「已入店」、
// 不证「起了轮」,所以每次注入必须自己扛一张 turn-start receipt + 经 SSE 结算的 completion(见
// opencode-serve-attach-transport.ts)。这一张收据就是它比 droid 多出来的全部量级,不是抄来的重量。
import type { SessionpageSessionMessage, SessionpageDeliveryTarget, SessionpageTurnReceipt } from './session-injection'
import { demoteSessionpageDeliveryOwner, registerSessionpageDeliveryTarget } from './sessionpage-delivery-owner-registry'
import { registerSessionpageSessionRuntime } from './sessionpage-session-runtime-registry'
import { createLogger } from '../lib/logger'
import {
  OpencodeServeSession,
  reserveLoopbackPort,
  type OpencodeServeOptions,
  type OpencodeTurnLifecycle,
} from './opencode-serve-attach-transport'
import { backendSessionNameFor, findTmuxBackend, type TmuxBackendDeps } from './tmux-backend'

/** 测试缝:tmux 调用与进程探测。生产用默认那一份。 */
let tmuxBackendDepsForTest: TmuxBackendDeps | undefined

const serveLogger = () => createLogger('sessionpage/opencode-serve')

type Binding = {
  agentUserId: string
  sessionId: string
  /** The harness this serve runs for (opencode / mimocode share the adapter); names the declared `tui` cell. */
  providerId: string
  cwd: string
  /** The opencode executable + env used to (re)boot the serve process (carries OPENCODE_CONFIG_CONTENT). */
  command: string
  env: NodeJS.ProcessEnv
  /** Provider-native fields for the first HTTP session-create request. */
  sessionCreatePatch?: Readonly<{ agent?: string }>
  /** Native `ses_…` id, learned once the serve creates the session; used to resume the same session on re-boot. */
  nativeSessionId?: string
  /**
   * Relay this conversation's turn boundaries to the host (→ `emitSessionpageAgentEvent`). Carried on the
   * binding rather than resolved here because the host owns the project/task ids an AgentEvent needs —
   * this layer only knows the conversation. Absent = nobody is listening; the serve still runs.
   */
  onTurnLifecycle?: (lifecycle: OpencodeTurnLifecycle) => void
  /** #6264 attach 那个 TUI 所在的 tmux 会话名;有它 ⇒ serve 也住进 tmux、活过宿主进程重启(见 tmux-backend.ts)。 */
  tmuxSessionName?: string
  /** 这一家给会话起的名 → 会话标题(优先级由会话页后端那侧判)。与 `onTurnLifecycle` 同理挂在 binding 上。 */
  onSessionTitle?: OpencodeServeOptions['onSessionTitle']
}

/** What the serve leg hands main.ts so it can build the user-facing `attach <url> --session <id>` argv. */
export interface OpencodeServeHandle {
  url: string
  providerSessionId: string
}

/** Provider-native opencode serve/attach channel. One `opencode serve` is owned by each mapped conversation. */
export class OpencodeServeAttachSessionDelivery implements SessionpageDeliveryTarget {
  readonly deliveryTargetName = 'opencode-serve-attach-v1'
  readonly hostAdapter = 'opencode-serve-attach-v1' as const
  private readonly bindings = new Map<string, Binding>()
  private readonly serves = new Map<string, OpencodeServeSession>()
  /**
   * agentUserId → conversationId for a serve that is still booting. This is **not** a claim — it never
   * answers `liveSessionIdByAgent`, so the router still sees exactly one owner (the offline blocker).
   * It exists only so teardown can reach the child: every release path is agent-keyed
   * (`releaseAgentClaim`), and between `startSession` and `promoteSessionpageDeliveryOwner` there is a real
   * await (the host persists the native session id). A cancel landing in that gap would otherwise find
   * nothing and leave an `opencode serve` running with no owner until app exit — spec session-injection
   * 「不能在用户机器留下常驻进程」.
   */
  private readonly booting = new Map<string, string>()

  /**
   * Publish this conversation's claim. Called from inside `promoteSessionpageDeliveryOwner` — the one
   * synchronous turn that also removes the offline blocker — and never earlier.
   *
   * @@@claim-at-promotion (#5049) - `startSession` used to register the binding BEFORE the serve had
   * booted. During those ~4s the local-session offline blocker (installed by `prepareSessionpageDeliveryOwner`)
   * and this half-started claim were both live, so any delivery arriving in the window — the chat page's
   * attachment row lands there because the upload runs first — hit the router's owner-cardinality check,
   * the reader disclosed "这批 1 条消息未处理成功", and the nudge died terminally while the very same row was
   * later injected by the session-live pull. A claim is publishable only once the channel can take bytes
   * (spec session-injection: no observable owner≥2 window; delivery-routing: before readiness the claimant
   * answers not-live — here that answer is the blocker's).
   */
  register(binding: Binding): void {
    this.bindings.set(binding.sessionId, binding)
    this.booting.delete(binding.agentUserId)
  }

  /** Boot the serve, create/resume/fork its session, and hand back where attach should connect. */
  async startSession(
    binding: Binding,
    resumeProviderSessionId: string | null,
    forkFromProviderSessionId?: string,
  ): Promise<OpencodeServeHandle> {
    this.booting.set(binding.agentUserId, binding.sessionId)
    try {
      const serve = await this.ensureServe(binding, resumeProviderSessionId, forkFromProviderSessionId)
      return { url: serve.url, providerSessionId: serve.providerSessionId! }
    } catch (error) {
      this.booting.delete(binding.agentUserId)
      throw error
    }
  }

  /** 该 conversation 是否已有 live serve(可见 attach 重拉会复用它 —— 平台令牌亦须随之复用,不得轮换)。 */
  hasLiveServe(sessionId: string): boolean {
    const serve = this.serves.get(sessionId)
    return Boolean(serve?.providerSessionId && serve.isAlive())
  }

  liveSessionIdByAgent(agentUserId: string): string | null {
    return [...this.bindings.values()].find((b) => b.agentUserId === agentUserId)?.sessionId ?? null
  }

  deliveryKeyForSession(sessionId: string): string | null {
    return this.bindings.has(sessionId) ? sessionId : null
  }

  /** The declared cell this conversation runs on, so the router's route log and timing lookup read the truth (#5049 Q2). */
  sessionProviderSurface(sessionId: string): { providerId: string; surface: 'tui' } | null {
    const binding = this.bindings.get(sessionId)
    return binding ? { providerId: binding.providerId, surface: 'tui' } : null
  }

  /** Host recovery admission delegates to the serve's real HTTP/session readiness check. */
  async waitUntilReady(sessionId: string): Promise<void> {
    const binding = this.bindings.get(sessionId)
    const serve = this.serves.get(sessionId)
    if (!binding || !serve) throw new Error(`opencode serve session ${sessionId} is not live after reopen`)
    if (!binding.nativeSessionId) throw new Error(`opencode serve session ${sessionId} has no registered native session`)
    await serve.waitUntilReady(binding.nativeSessionId)
    if (this.bindings.get(sessionId) !== binding || this.serves.get(sessionId) !== serve) {
      throw new Error(`opencode serve session ${sessionId} was released or replaced during admission`)
    }
  }

  /**
   * `prompt_async` + the SSE turn-start receipt IS admission — the receipt returns once the serve has taken the
   * bytes, and `completion` settles the turn out of band.
   */
  async tryInjectSessionMessage(
    sessionId: string,
    message: SessionpageSessionMessage,
  ): Promise<boolean | SessionpageTurnReceipt> {
    const binding = this.bindings.get(sessionId)
    if (!binding) return false
    const serve = await this.ensureServe(binding, binding.nativeSessionId ?? null)
    return serve.injectPrompt(message.text)
  }

  async injectMessage(sessionId: string, text: string): Promise<SessionpageTurnReceipt> {
    const result = await this.tryInjectSessionMessage(sessionId, { id: '', text })
    if (result === false) {
      throw new Error(`opencode serve session ${sessionId} did not accept the message`)
    }
    if (result === true) {
      throw new Error(`opencode serve session ${sessionId} returned no turn receipt`)
    }
    return result
  }

  /** Cancel the in-flight turn for this agent (POST /session/{id}/abort). false = nothing was running. */
  async cancelTurn(agentUserId: string): Promise<boolean> {
    const sessionId = this.liveSessionIdByAgent(agentUserId)
    if (!sessionId) return false
    const serve = this.serves.get(sessionId)
    if (!serve) return false
    return serve.abort()
  }

  isSessionTurnInFlight(sessionId: string): boolean {
    return this.serves.get(sessionId)?.isTurnInFlight() ?? false
  }

  releaseAgentClaim(agentUserId: string): void {
    // A booting serve is released too: it is not a claim, but it IS a child process this adapter owns.
    const sessionId = [...this.bindings.values()].find((b) => b.agentUserId === agentUserId)?.sessionId
      ?? this.booting.get(agentUserId)
    if (sessionId) {
      void this.unregisterSession(sessionId).catch((error: unknown) => {
        serveLogger().error(
          { sessionId, err: error },
          'opencode serve owner release failed before stable-zero',
        )
      })
    }
  }

  /** `onReleased` 在认领真正摘掉的那一刻同步调用(没有认领可摘就不调)—— 交还离线占位就挂在这里。 */
  async unregisterSession(sessionId: string, onReleased?: () => void): Promise<void> {
    const serve = this.serves.get(sessionId)
    if (!serve) {
      const held = this.bindings.delete(sessionId)
      for (const [agentUserId, booting] of this.booting) {
        if (booting === sessionId) this.booting.delete(agentUserId)
      }
      if (held) onReleased?.()
      return
    }
    // @@@5163 ⚠️ 先 dispose、**后**摘表 —— 反过来会把一台还活着的 serve 从图里抹掉:
    // 调用方(`releaseAgentClaim`)是 `void` 掉这个 promise 的,退出路径不等它;
    // 一旦条目先没了,`disposeSync()` 那道同步回收就再也找不到这台 serve,
    // 它的子进程于是留在用户机器上(实测:停掉 app 后 serve pid 仍在,日积月累 45 个)。
    // spec opencode-serve-attach-readiness 原话:「在证明整组 / 整树 terminal 后才删除
    // endpoint、session ownership 与 registry entry」「不能吞错后把仍活的后代从图里抹掉」。
    await serve.dispose()
    if (this.serves.get(sessionId) === serve) {
      this.serves.delete(sessionId)
      const held = this.bindings.delete(sessionId)
      for (const [agentUserId, booting] of this.booting) {
        if (booting === sessionId) this.booting.delete(agentUserId)
      }
      if (held) onReleased?.()
    }
  }

  /**
   * 会话真结束(stopSession / 闲置回收):停 serve,并在认领摘掉的同一刻把这个 agent 交还给离线占位 ——
   * 与 codex / claude 同一个写口。少了这一步,停后这个 agent 一个投递属主都没有:下一条消息直接失败、
   * 也没有人能按原会话把它叫醒(#6546 之后 session_message 与收件箱都靠这个占位唤醒)。
   */
  async teardownSession(sessionId: string): Promise<void> {
    const binding = this.bindings.get(sessionId)
    if (!binding) return this.unregisterSession(sessionId)
    await demoteSessionpageDeliveryOwner(
      { guguAgentUserId: binding.agentUserId, sessionId },
      binding.providerId,
      (replaceAfterRelease) => this.unregisterSession(sessionId, replaceAfterRelease),
    )
  }

  /**
   * 宿主关停。#6264 住在 tmux 里的 serve 只断开(attach 还在 tmux 里用着它,新宿主按名字接回);其余照旧收掉。
   */
  async dispose(): Promise<void> {
    for (const [sessionId, serve] of [...this.serves]) {
      if (!serve.isTmuxHosted()) continue
      serve.detach()
      this.serves.delete(sessionId)
      this.bindings.delete(sessionId)
    }
    await Promise.all([...this.serves.keys()].map((id) => this.unregisterSession(id)))
  }

  disposeSync(): void {
    // @@@5163 无条件记一行「这一刻手里有几台」。只在出错时才打的日志分不出
    // 「跑了且没错」与「压根没跑」—— 而那正是这一票查了两轮没定案的原因。
    serveLogger().info({ serves: this.serves.size }, 'opencode serve/attach: disposeSync reaping')
    for (const serve of this.serves.values()) serve.disposeSync()
    this.serves.clear()
    this.bindings.clear()
    this.booting.clear()
  }

  private async ensureServe(
    binding: Binding,
    resumeProviderSessionId: string | null,
    forkFromProviderSessionId?: string,
  ): Promise<OpencodeServeSession> {
    let existing = this.serves.get(binding.sessionId)
    // 手上那台已经死了:❌ 把它当活的复用(投进去的每一条都会石沉大海)—— 摘掉,按同一原生会话重起。
    if (existing && existing.providerSessionId && !existing.isAlive()) {
      resumeProviderSessionId ??= existing.providerSessionId
      await existing.dispose().catch(() => undefined)
      if (this.serves.get(binding.sessionId) === existing) this.serves.delete(binding.sessionId)
      existing = undefined
    }
    if (existing) {
      if (forkFromProviderSessionId || !existing.providerSessionId || (resumeProviderSessionId && existing.providerSessionId !== resumeProviderSessionId)) {
        throw new Error(`opencode serve session ${binding.sessionId} cannot reuse a different or unready native session`)
      }
      return existing
    }
    const tmuxBackendName = backendSessionNameFor(binding.tmuxSessionName) ?? undefined
    const options: OpencodeServeOptions = {
      providerId: binding.providerId,
      command: binding.command,
      cwd: binding.cwd,
      env: binding.env,
      sessionCreatePatch: binding.sessionCreatePatch,
      onTurnLifecycle: binding.onTurnLifecycle,
      ...(tmuxBackendName ? { tmuxBackendName } : {}),
      ...(tmuxBackendDepsForTest ? { tmuxBackendDeps: tmuxBackendDepsForTest } : {}),
      onSessionTitle: binding.onSessionTitle,
    }
    const adopted = tmuxBackendName && !forkFromProviderSessionId
      ? await this.adoptSurvivor(binding, tmuxBackendName, resumeProviderSessionId, options)
      : null
    if (adopted) return adopted
    const port = await reserveLoopbackPort()
    const serve = new OpencodeServeSession(port, options)
    this.serves.set(binding.sessionId, serve)
    try {
      await serve.start(resumeProviderSessionId, forkFromProviderSessionId)
    } catch (error) {
      this.serves.delete(binding.sessionId)
      throw error
    }
    return serve
  }

  /**
   * #6264 上一个宿主留在 tmux 里的那台 serve(attach 一直连着它)→ 接回同一个端口、同一条原生会话。
   * 不在 → null;在却接不上(不应答、会话不在、不知道是哪条会话)→ 收掉它,返回 null 让调用方新起。
   */
  private async adoptSurvivor(
    binding: Binding,
    name: string,
    resumeProviderSessionId: string | null,
    options: OpencodeServeOptions,
  ): Promise<OpencodeServeSession | null> {
    const survivor = await findTmuxBackend(name, 'opencode-serve', tmuxBackendDepsForTest)
    if (!survivor) return null
    const port = loopbackPort(survivor.endpoint)
    if (port === null || !resumeProviderSessionId) {
      await survivor.terminate().catch(() => undefined)
      return null
    }
    const serve = new OpencodeServeSession(port, options)
    this.serves.set(binding.sessionId, serve)
    try {
      await serve.adopt(survivor, resumeProviderSessionId)
      return serve
    } catch (error) {
      serveLogger().warn({ sessionId: binding.sessionId, err: String(error) }, '接回 tmux 里的 opencode serve 失败 —— 收掉它,新起一台')
      if (this.serves.get(binding.sessionId) === serve) this.serves.delete(binding.sessionId)
      serve.detach()
      await survivor.terminate().catch(() => undefined)
      return null
    }
  }
}

/** http://127.0.0.1:<port> → port;认不出 → null。 */
function loopbackPort(url: string): number | null {
  const match = url.match(/^http:\/\/127\.0\.0\.1:(\d+)$/)
  return match ? Number(match[1]) : null
}
export const opencodeServeAttachSessionDelivery = new OpencodeServeAttachSessionDelivery()
registerSessionpageDeliveryTarget(opencodeServeAttachSessionDelivery)
registerSessionpageSessionRuntime({
  name: 'opencode-serve-attach',
  teardown: (sessionId) => opencodeServeAttachSessionDelivery.teardownSession(sessionId),
})
process.once('exit', () => opencodeServeAttachSessionDelivery.disposeSync())
