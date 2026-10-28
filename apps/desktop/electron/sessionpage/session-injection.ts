// Session-page delivery uses each harness control channel; it never writes to a PTY.
//
// S2b(pull/收件箱):本模块只剩「字节怎么进一个活着的 harness 会话」——conversation 键控的唯一
// 注入权威、per-harness 两档注入时机、窄注入契约。耐久队列/结算/清扫那半(mapped-but-not-live 记债、
// settlements、sweep、revoke/tombstone、重复投递仪表)已随 push 模型整体退役:聊天消息的耐久层在云端
// (消息本体+游标);普通 session-direct 由 host 直接注入，spawn 启动委托/遗留 pending 行才走本地
// outbox projection，再由同一个 reader/merge/inject 链消费。
import { randomUUID } from 'node:crypto'
import { declaredInjectionTiming } from '@gugu/session-core/agents/plugins'
import {
  resolveSessionpageSessionIntegration,
  type SessionpageSessionSurface,
} from '@gugu/session-plugins/agents'
import type {
  AgentRuntimeBridge,
  AgentDeliveryToolNames,
} from '@gugu/core/local/agent/deviceCommandRuntime'
import type {
  AgentInboxInjectionInput,
  AgentInboxInjectionResult,
  AgentInboxInjectionVerdict,
  AgentInboxDeliveryTiming,
} from '@gugu/core/local/agent/agentInboxReader'
import { createLogger } from '../lib/logger'
import type { SessionMessageDelivery } from '@shared/core/sessions/sessions'
import { SessionArchivedError, type SessionArchivalState } from '@gugu/core/shared/sessionArchival'
import { agentStatusFeed, type AgentStatusFeed } from './agent-status-feed'

function deliveryLogger() {
  return createLogger('sessionpage/deliver')
}

/** 叫不醒:原因写在 detail 里,调用方原样报出去(`SESSION_DIRECT_NOT_LIVE` 的原因、收件箱那一行 error),❌ 静默返回。 */
export class SessionWakeError extends Error {
  constructor(readonly sessionId: string | null, detail: string) {
    super(detail)
    this.name = 'SessionWakeError'
  }
}

export interface SessionpageDeliveryTarget {
  /** Await the native owner's admission boundary after a host-driven reopen, when one exists. */
  waitUntilReady?(sessionId: string): Promise<void>
  /**
   * The provider control channel a mapped session runs on, for the per-harness injection
   * capability lookup (declared in each provider's descriptor — spec session-injection).
   * null = this target holds no registration for that session.
   */
  sessionProviderSurface(
    deliveryKey: string,
  ):
    | { providerId: string; surface: SessionpageSessionSurface }
    | null
    | Promise<{ providerId: string; surface: SessionpageSessionSurface } | null>
  /** 日志里认人用:一条投递到底被谁认领了(不写就打 unknown)。 */
  readonly deliveryTargetName?: string
  /**
   * Owner 交接编排的**同步释放点**:只摘这个认领者的 live 映射,不做 transport 处置。
   * 有它 = 释放是同步的;没有它而有 `unregisterAgent` = 释放含异步处置(app-server 类)。
   */
  releaseAgentClaim?(agentUserId: string): void
  /**
   * Full release including any transport disposal this claimant owns. `onReleased` fires exactly
   * once, at the synchronous point the live entry is removed — immediately when the claimant does
   * not hold the agent. Owner 替换装在这个释放点上,避免 owner=0 / 跨 await 双主的可观测窗口
   * (spec session-injection「认领者是注册表」)。
   */
  unregisterAgent?(agentUserId: string, onReleased?: () => void): void | Promise<void>
  /** Exact provider-visible tool names for envelopes injected through this transport. */
  readonly deliveryToolNames?: AgentDeliveryToolNames
  /**
   * @@@4526B 取消这个 agent 在飞的那一轮(不拆会话、不动进程)。owner 删除 agent 时由删除序调用——
   * 删除是"停下它"的意思。返回 false = 此刻没有可取消的轮(no-op);通道自己的失败照常抛。
   * 未声明 = 这条腿还没接通取消,调用方据此 fail loud,❌ 不当成"已经停了"。
   */
  cancelTurn?(agentUserId: string): Promise<boolean>
  /** Mapped session-page conversation id for this gugu agent, or null → not a session-page agent. */
  liveSessionIdByAgent(agentUserId: string): string | null
  /** Resolve a stable product conversation id without requiring social identity provisioning. */
  deliveryKeyForSession?(sessionId: string): string | null | Promise<string | null>
  /** Authoritative provider turn state for host recovery deferral. */
  isSessionTurnInFlight?(sessionId: string): boolean | Promise<boolean>
  /** Recent provider tool actions owned by this session-page session. */
  recentActionsForAgent?(agentUserId: string): {
    actions: string[]
    lastActionAt: string | null
  } | null | Promise<{
    actions: string[]
    lastActionAt: string | null
  } | null>
  /**
   * The ONLY injection entry an adapter has. false = the mapped adapter is not live right now and accepted no bytes;
   * infrastructure and live-adapter errors throw.
   *
   * ❌ 没有、也不会有 `messages[]` 批量入口:一个快照要并成一条,那件事归读者(合并做一次,单一属主
   * 在 deliveryEnvelope 的 mergeDeliveryEnvelopes),不归每个 adapter 各做一遍 —— 重复的 merge 已经
   * 漂过一次。
   */
  tryInjectSessionMessage(
    sessionId: string,
    message: { id: string; text: string; kind?: 'ordinary' | 'session-direct'; delivery?: SessionMessageDelivery; deferredDispatch?: true },
  ): Promise<boolean | SessionpageTurnReceipt>
}

export type SessionpageSessionMessage = {
  id: string
  text: string
  kind?: 'ordinary' | 'session-direct'
}

export interface SessionpageTurnReceipt {
  turnId: string
  completion: Promise<void>
  /** True when the machine admitted bytes into its visible queue instead of starting a live turn. */
  queued?: boolean
}

export type SessionpageInjectionTiming = 'next-tool-call' | 'idle-only'

export interface SessionpageInjectionCapability {
  readonly providerId: string
  readonly surface: SessionpageSessionSurface
  readonly timing: SessionpageInjectionTiming
}

/**
 * Per-harness injection timing, resolved from the provider's own descriptor declaration
 * (`SessionpageSessionIntegration.injection`, in `impl/<name>/session-bundle.ts`).
 *
 * 内核这里没有每家一行的表:声明的 SSOT 在各家 descriptor,加一家/升一档零内核 diff
 * (spec session-injection 的加家判据)。未知 provider/surface 由 registry exact lookup
 * fail loud;**声明缺席 = 未判定 → 最保守的 `idle-only`**,❌ 不从"有 ACP 入口"推断升档。
 */
export function sessionInjectionCapabilityFor(
  providerId: string,
  surface: SessionpageSessionSurface,
): SessionpageInjectionCapability {
  return { providerId, surface, timing: declaredInjectionTiming(resolveSessionpageSessionIntegration(providerId, surface)) }
}

/**
 * 这条会话在**注入权威**处的登记:属主报出了 provider×surface ⇒ 时机档查得到(正常路);报不出(null)⇒ 登记不在
 * (还没建立,或已被注销),这时**一个字节都不能投**:spec session-injection 的「唯一注入权威,conversation 键控」要求
 * 注入必须走这条会话自己声明的控制通道,而这里连「是哪条通道」都不知道 —— 猜一个属主投出去正是它禁的那种回落(#5416)。
 */
export async function sessionInjectionCapabilityForSession(
  target: SessionpageDeliveryTarget,
  deliveryKey: string,
): Promise<SessionpageInjectionCapability | null> {
  const channel = await target.sessionProviderSurface(deliveryKey)
  return channel ? sessionInjectionCapabilityFor(channel.providerId, channel.surface) : null
}

export class SessionpageLocalDeliveryRouter {
  private readonly wakeFlights = new Map<string, Promise<'reopened' | 'already-running'>>()

  constructor(
    private readonly targets: readonly SessionpageDeliveryTarget[],
    private readonly options: {
      waitUntilReady?: () => Promise<void>;
      archivalState?: (sessionId: string) => SessionArchivalState | null;
      messageRefused?: (sessionId: string, messageId: string, createdAt: string) => boolean;
      /** 宿主按原 conversation 重开(`ensureEmdashSession`)。 */
      wakeSession?: (sessionId: string) => Promise<unknown>;
      /** 这条会话由本机起的引擎进程此刻在不在(`session-process.ts` 的唯一事实);在 = 唤醒什么也起不了。 */
      processRunning?: (sessionId: string) => boolean;
      onWakeComplete?: (agentUserId: string, sessionId: string) => void;
    } = {},
  ) {}

  async waitUntilReady(): Promise<void> {
    await this.options.waitUntilReady?.()
  }

  sessionArchivalForAgent(agentUserId: string): SessionArchivalState | null {
    const sessionId = this.sessionIdForAgent(agentUserId)
    return sessionId ? this.options.archivalState?.(sessionId) ?? null : null
  }

  sessionMessageRefusedForAgent(agentUserId: string, messageId: string, createdAt: string): boolean {
    const sessionId = this.sessionIdForAgent(agentUserId)
    return sessionId ? this.options.messageRefused?.(sessionId, messageId, createdAt) ?? false : false
  }

  private assertNotArchived(sessionId: string): void {
    if (this.options.archivalState?.(sessionId)?.archivedAt) throw new SessionArchivedError()
  }

  /**
   * 唤醒的唯一入口(收件箱、`session:`/`user:` 直投、云端 agent.deliver 都经这里)。读者从不起会话:
   * - 引擎进程还在跑 ⇒ 不重开(唤醒什么也起不了;启动中的会自己就绪,接回的等 MCP 重连);
   * - 不在跑 ⇒ 请宿主按原 conversation 重开。
   * 返回有没有真的重开(收件箱只在重开过时再拉一次,❌ 对一个本来就在跑的进程反复踢)。重开失败抛。
   */
  wakeSession(sessionId: string): Promise<'reopened' | 'already-running'> {
    // 同一条会话的并发唤醒(收件箱几路触发、几个发送方)合并成一次。
    const existing = this.wakeFlights.get(sessionId)
    if (existing) return existing
    const flight = this.wakeSessionOnce(sessionId).finally(() => {
      if (this.wakeFlights.get(sessionId) === flight) this.wakeFlights.delete(sessionId)
    })
    this.wakeFlights.set(sessionId, flight)
    return flight
  }

  private async wakeSessionOnce(sessionId: string): Promise<'reopened' | 'already-running'> {
    await this.waitUntilReady()
    this.assertNotArchived(sessionId)
    let outcome: 'reopened' | 'already-running' = 'already-running'
    if (!this.options.processRunning?.(sessionId)) {
      if (!this.options.wakeSession) {
        throw new SessionWakeError(sessionId, 'session-page host wake is unavailable')
      }
      try {
        await this.options.wakeSession(sessionId)
      } catch (error) {
        throw new SessionWakeError(sessionId, `reopening the session failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      outcome = 'reopened'
    }
    return outcome
  }

  /** 按 agent 唤醒(收件箱与云端 agent.deliver):映射解析出 conversation,再走 {@link wakeSession}。 */
  async wakeAgentSession(agentUserId: string): Promise<void> {
    await this.waitUntilReady()
    const sessionId = this.sessionIdForAgent(agentUserId)
    if (!sessionId) throw new SessionWakeError(null, `agent ${agentUserId} has no session on this machine`)
    // 并进了别人正在进行的那次唤醒 ⇒ 「醒了」由发起那一方报,只报一次。
    const joined = this.wakeFlights.has(sessionId)
    const outcome = await this.wakeSession(sessionId)
    // 等待期间这个身份被换到了别的会话(或被删):❌ 替旧的那条会话报「醒了」。
    if (!joined && outcome === 'reopened' && this.sessionIdForAgent(agentUserId) === sessionId) {
      this.options.onWakeComplete?.(agentUserId, sessionId)
    }
  }

  /**
   * 「注入 → 不收就唤醒 → 等当前属主准入 → 再注入一次」—— 同步直投的唯一写法(`session:` 与 `user:` 两条腿都用它)。
   * 再注入还不收就带着原因抛,并留一行 warn:这条路原来一行日志都不写。
   */
  async injectWithWake<T>(
    sessionId: string,
    attempt: () => Promise<T | 'not-live'>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted()
    const first = await attempt()
    if (first !== 'not-live') return first
    const fail = (error: SessionWakeError): never => {
      deliveryLogger().warn({ sessionId, error: error.message }, 'session-direct target not live after wake')
      throw error
    }
    let outcome: 'reopened' | 'already-running'
    try {
      outcome = await this.wakeSession(sessionId)
    } catch (error) {
      if (error instanceof SessionWakeError) return fail(error)
      throw error
    }
    signal?.throwIfAborted()
    const state = outcome === 'already-running' ? 'the engine is running (not reopened)' : 'the session was reopened'
    try {
      const owner = await this.deliveryTargetForSession(sessionId)
      await owner?.target.waitUntilReady?.(sessionId)
    } catch (error) {
      // 准入没等到(就绪预算到点、等的时候属主换了)。
      return fail(new SessionWakeError(sessionId, `${state} but was not admitted: ${error instanceof Error ? error.message : String(error)}`))
    }
    signal?.throwIfAborted()
    const second = await attempt()
    if (second !== 'not-live') return second
    return fail(new SessionWakeError(sessionId, `${state} but its delivery channel did not accept the message`))
  }

  deliveryTargetFor(agentUserId: string): SessionpageDeliveryTarget | null {
    const owners = this.targets.filter((target) => target.liveSessionIdByAgent(agentUserId) !== null)
    if (owners.length > 1) {
      throw new Error(
        `Session-page delivery owner cardinality violation for ${agentUserId}: expected at most one live owner, got ${owners.length}`,
      )
    }
    return owners[0] ?? null
  }

  /**
   * #6927 这一批的时机档,按**注入时用的同一把钥匙**查:conversation → 它的属主报出的会话 id
   * (`deliveryKeyForSession`,codex 是 threadId)→ `sessionProviderSurface`。`liveSessionIdByAgent`
   * 报的是产品 conversation,codex 的 `sessionProviderSurface` 按 threadId 键,拿前者直接去查在 codex 上恒为
   * null ⇒ 一批几条各投一次。
   */
  async deliveryTimingForAgent(agentUserId: string): Promise<AgentInboxDeliveryTiming | null> {
    const sessionId = this.sessionIdForAgent(agentUserId)
    if (!sessionId) return null
    const owner = await this.deliveryTargetForSession(sessionId)
    if (!owner) return null
    return (await sessionInjectionCapabilityForSession(owner.target, owner.deliveryKey))?.timing ?? null
  }

  /**
   * 这个 agent 此刻被哪条产品 conversation 认领(没有认领者 → null)。
   *
   * @@@4629 唯一一条按 agentUserId 解析 conversation 的路,走**认领者注册表**
   * (spec session-injection「认领者是注册表,不是具名 import」)。❌ 不要在别处手拼
   * 「查 `emdashAgentRegistry`,查不到再查 local-session」—— 那两个是内核角色,而 `promoteSessionpageDeliveryOwner`
   * 的契约恰恰是让 native 认领者(codex app-server / opencode serve-attach)成为唯一 owner 并把它们摘掉,
   * 于是那种手拼在 native 腿上恒为 null:`session_spawn` 的启动委托按 conversation 键控躺在本机 outbox 里,
   * 解析不出 conversation 就永远取不到它。基数超一照旧在 `deliveryTargetFor` 里 fail loud。
   */
  sessionIdForAgent(agentUserId: string): string | null {
    return this.deliveryTargetFor(agentUserId)?.liveSessionIdByAgent(agentUserId) ?? null
  }

  async deliveryTargetForSession(
    sessionId: string,
  ): Promise<{ target: SessionpageDeliveryTarget; deliveryKey: string } | null> {
    const resolved = await Promise.all(this.targets.map(async (target) => ({
      target,
      deliveryKey: await target.deliveryKeyForSession?.(sessionId) ?? null,
    })))
    const owners = resolved.filter((owner): owner is { target: SessionpageDeliveryTarget; deliveryKey: string } => Boolean(owner.deliveryKey))
    if (owners.length > 1) {
      throw new Error(
        `Session-page session delivery owner cardinality violation for ${sessionId}: expected at most one owner, got ${owners.length}`,
      )
    }
    return owners[0] ?? null
  }

  /** Session-keyed injection (`session:` direct messages and the session-message drain). */
  async tryInjectSessionMessage(
    sessionId: string,
    message: { id: string; text: string; kind?: 'ordinary' | 'session-direct'; delivery?: SessionMessageDelivery; deferredDispatch?: true },
  ): Promise<boolean | SessionpageTurnReceipt> {
    return this.injectIntoSession(sessionId, message, { route: 'router.tryInjectSessionMessage' })
  }

  /**
   * 普通消息(session-message 的 outbox)的注入:不收就经唯一的去重唤醒口({@link wakeSession})叫醒它、不等 ——
   * 消息留在 outbox,会话 live 那一刻抽干。哪一家、ACP 还是终端都一样(从前只有 ACP 那一家在注入里自己踢一脚)。
   */
  async tryInjectOrWake(
    sessionId: string,
    message: { id: string; text: string; kind?: 'ordinary' | 'session-direct' },
  ): Promise<boolean | SessionpageTurnReceipt> {
    const accepted = await this.tryInjectSessionMessage(sessionId, message)
    if (accepted === false) {
      void this.wakeSession(sessionId).catch((error: unknown) => {
        deliveryLogger().warn({ sessionId, messageId: message.id, error: error instanceof Error ? error.message : String(error) }, 'session-message wake failed')
      })
    }
    return accepted
  }

  /**
   * The one injection both entries share. conversation 键控是**唯一**的注入权威(spec session-injection):
   * 只有这条会话的属主、走它自己声明的控制通道才收字节。解析不出属主、或属主报不出这条会话的登记(还没建立,或已被注销,
   * #5416)⇒ false,消息留在来源侧,等登记出现的边界再投。返回 queued 却没有受理凭据 ⇒ THROW,防止把本机队列误报成送达。
   */
  private async injectIntoSession(
    sessionId: string,
    message: { id: string; text: string; kind?: 'ordinary' | 'session-direct'; delivery?: SessionMessageDelivery; deferredDispatch?: true },
    log: { route: string; agentUserId?: string },
  ): Promise<boolean | SessionpageTurnReceipt> {
    this.assertNotArchived(sessionId)
    const owner = await this.deliveryTargetForSession(sessionId)
    const capability = owner ? await sessionInjectionCapabilityForSession(owner.target, owner.deliveryKey) : null
    if (!owner || !capability) {
      deliveryLogger().warn(
        { ...log, sessionId, deliveryKey: owner?.deliveryKey ?? null, messageId: message.id },
        'session 在注入权威处无登记,拒绝注入(消息留在来源侧,等登记出现的边界再投)',
      )
      return false
    }
    deliveryLogger().info(
      {
        ...log,
        messageId: message.id,
        sessionId,
        deliveryKey: owner.deliveryKey,
        providerId: capability.providerId,
        surface: capability.surface,
        timing: capability.timing,
      },
      'session-page inbox injection route selected',
    )
    this.assertNotArchived(sessionId)
    const accepted = await owner.target.tryInjectSessionMessage(owner.deliveryKey, message)
    if (typeof accepted === 'object' && accepted.queued && !accepted.turnId) {
      throw new Error(
        `session injection for ${capability.providerId}×${capability.surface} returned queued without an admission identity`,
      )
    }
    return accepted
  }

  /**
   * 读者的注入口(agentUserId 只用于本机映射;解析出的 conversationId 才选择 provider 控制通道)。
   *
   * 路由判决归通道:'accepted' / 'not-live'(映射在、会话不 live)。返回 queued 却没有受理凭据时直接 THROW，
   * 防止把本机队列误报成送达。真基础设施错误照旧 THROW，next-tool-call 通道不需要投递点路由。
   */
  async injectForAgent(
    agentUserId: string,
    message: { id: string; text: string; kind?: 'ordinary' | 'session-direct' },
  ): Promise<AgentInboxInjectionVerdict> {
    const result = await this.injectForAgentResult(agentUserId, message)
    return typeof result === 'string' ? result : result.verdict
  }

  /** Reader-facing admission result; native turn completion stays outside the reader/tick. */
  async injectForAgentWithCompletion(
    agentUserId: string,
    message: { id: string; text: string; kind?: 'ordinary' | 'session-direct' },
  ): Promise<AgentInboxInjectionResult> {
    return this.injectForAgentResult(agentUserId, message)
  }

  private async injectForAgentResult(
    agentUserId: string,
    message: { id: string; text: string; kind?: 'ordinary' | 'session-direct' },
  ): Promise<AgentInboxInjectionResult> {
    const mappedOwner = this.deliveryTargetFor(agentUserId)
    if (!mappedOwner) {
      throw new Error(`Agent ${agentUserId} has no local session-page runtime`)
    }
    // agentUserId 只用来找到 conversation;字节只经 conversation 键控的属主(❌ 拿按 agent 找到的那个顶替)。没有 ⇒
    // 'not-live',消息留在收件箱等下一次触发(reader 对 'not-live' 不动游标并 wake)。
    const sessionId = mappedOwner.liveSessionIdByAgent(agentUserId)
    if (!sessionId) return 'not-live'
    const accepted = await this.injectIntoSession(sessionId, message, { route: 'agentInbox.injectForAgent', agentUserId })
    if (accepted === false) return 'not-live'
    if (accepted === true) return 'accepted'
    // Detached completion is deliberately outside the sender's admission contract. Consume
    // provider failures here so a rejected target turn cannot become an unhandled rejection.
    void accepted.completion.catch((error: unknown) => {
      deliveryLogger().error({
        agentUserId,
        messageId: message.id,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      }, 'session-page inbox provider completion failed after admission')
    })
    return { verdict: 'accepted', completion: accepted.completion }
  }

}

export function createSessionpageDeliveryBridge(
  localDelivery: SessionpageLocalDeliveryRouter,
  options: {
    stopAgent?: (agentUserId: string) => Promise<void>
    // #7199 设备命令 agent.retire 的宿主实现(个人助理搬去了别的设备:拆运行时,❌ 删文件)。
    retireAgent?: NonNullable<AgentRuntimeBridge['retireAgent']>
    // #5276 —— 设备命令 agent.set_model 的宿主实现（校验 → 落本地 → 应用到活会话）。
    applyAgentModelSelection?: NonNullable<AgentRuntimeBridge['applyAgentModelSelection']>
    startAgentSession?: NonNullable<AgentRuntimeBridge['startAgentSession']>
    ensureAgentInstalled?: NonNullable<AgentRuntimeBridge['ensureAgentInstalled']>
    ensureSessionReady?: (
      sessionId: string,
      trigger: string,
    ) => Promise<{ status: 'ready' } | { status: 'failed'; error: string }>
    // spec agent-status-writer —— 这个 agent 的状态 = 宿主按 agent 的流里的读数(默认单例;注入只为单测)。
    agentStatus?: Pick<AgentStatusFeed, 'get' | 'subscribe'>
    /** #3641 会话此刻的 provider 原生 session id(换新上下文时它变);群规据此判断要不要重达。 */
    providerSessionIdForSession?: (sessionId: string) => Promise<string | null>
  } = {},
): AgentRuntimeBridge {
  const statusFeed = options.agentStatus ?? agentStatusFeed
  const ownerOf = (agentUserId: string): SessionpageDeliveryTarget | null =>
    localDelivery.deliveryTargetFor(agentUserId)
  const noRuntime = (agentUserId: string): Error =>
    new Error(`Agent ${agentUserId} has no local session-page runtime`)
  return {
    ...(options.startAgentSession ? { startAgentSession: options.startAgentSession } : {}),
    ...(options.ensureAgentInstalled ? { ensureAgentInstalled: options.ensureAgentInstalled } : {}),
    create: async (input) => {
      throw noRuntime(input.agentUserId)
    },
    deliveryToolNames: (agentUserId) =>
      ownerOf(agentUserId)?.deliveryToolNames
      ?? null,
    deliveryTiming: (agentUserId) => localDelivery.deliveryTimingForAgent(agentUserId),
    sessionArchival: (agentUserId) => localDelivery.sessionArchivalForAgent(agentUserId),
    sessionMessageRefused: (agentUserId, messageId, createdAt) => localDelivery.sessionMessageRefusedForAgent(agentUserId, messageId, createdAt),
    // #3641 上下文标识 = 会话 id + provider 原生 session id。provider 换了一条新 session(上下文清空)
    // ⇒ 标识变 ⇒ 群规重达;同一条 session 的 resume 保留上下文,标识不变。
    ...(options.providerSessionIdForSession
      ? {
          deliveryContextKey: async (agentUserId: string): Promise<string | null> => {
            const sessionId = localDelivery.sessionIdForAgent(agentUserId)
            if (!sessionId) return null
            const providerSessionId = await options.providerSessionIdForSession!(sessionId)
            return `${sessionId}:${providerSessionId ?? ''}`
          },
        }
      : {}),
    // 读者的注入口:等 persisted owner 恢复完成再解析映射,启动窗口不会把「还没重注册」误判成 not-live
    // 后又立即唤醒一个其实活着的会话。
    injectAgentInbox: async (input: AgentInboxInjectionInput): Promise<AgentInboxInjectionResult> => {
      await localDelivery.waitUntilReady()
      const sessionId = localDelivery.sessionIdForAgent(input.agentUserId)
      if (sessionId && options.ensureSessionReady) {
        const ready = await options.ensureSessionReady(sessionId, 'chat-inbox')
        if (ready.status === 'failed') {
          deliveryLogger().error(
            { agentUserId: input.agentUserId, sessionId, error: ready.error },
            'platform credential recovery failed; inbox message remains unread',
          )
          return { verdict: 'not-now' }
        }
      }
      return localDelivery.injectForAgentWithCompletion(input.agentUserId, {
        id: input.messageId ?? randomUUID(),
        text: input.text,
      })
    },
    // #4320 —— 唤醒是**踢一脚**,不是站在门口等对方开机:收信方开机的代价记在收信方身上。
    // 唤醒失败 loud log;未读仍躺在云端游标后,下一个触发(nudge/回合末/开机扫)重拉重踢。
    // Resolve the same conversation owner and share one host wake across all inbox triggers.
    wakeAgentSession: (agentUserId: string): void => {
      void localDelivery.wakeAgentSession(agentUserId).catch((error: unknown) => {
        deliveryLogger().error(
          {
            agentUserId,
            err: error instanceof Error ? error.message : String(error),
          },
          '会话唤醒失败:未读保持在云端游标后,下一个触发重踢(❌ 不回落其它引擎)',
        )
      })
    },
    // 这个 agent 此刻的读数只有一个来源:状态写入者 → 宿主按 agent 的流。❌ 再取传输自己的回合追踪做「或」。
    agentStatus: (agentUserId: string) => statusFeed.get(agentUserId)?.reading ?? null,
    recentActionsForAgent: (agentUserId: string) => {
      const owner = ownerOf(agentUserId)
      return owner?.recentActionsForAgent?.(agentUserId) ?? null
    },
    // 读数变了就宣告一次,宿主据此立刻发布 presence。
    onAgentStatusChanged: (listener: (agentUserId: string) => void) => statusFeed.subscribe((agentUserId) => listener(agentUserId)),
    stop: async (input) => {
      // Device-runtime cleanup is idempotent: an unmapped id is already stopped locally.
      // A mapped conversation must stop through the session-page owner; never report success
      // while leaving its ACP/PTY process alive.
      if (!ownerOf(input.agentUserId)) return
      if (!options.stopAgent) {
        throw new Error(`Session-page stop handler is unavailable for Agent ${input.agentUserId}`)
      }
      await options.stopAgent(input.agentUserId)
    },
    ...(options.retireAgent ? { retireAgent: options.retireAgent } : {}),
    // #5276 不像 stop 那样「没映射就当成功」：模型选择要落成事实，宿主没接这一格就是没人能落，响亮。
    ...(options.applyAgentModelSelection
      ? { applyAgentModelSelection: options.applyAgentModelSelection }
      : {}),
  }
}
