// @@@sessionpage TASKPAGE-FUSION — the addressing map + control-channel delivery target that lets one
// session-page codex session message another inside the 任务 (task) tab. This module owns only the ACP delivery
// claimant: a gugu agent identity is provisioned and persisted in the roster (see emdash-agent-provisioning.ts),
// while this map records which conversation currently owns the ACP control channel. Identity resolution never
// consults this map.
//
// A claimant whose session-page session is not live remains mapped here: delivery records durable local debt
// and drains it when the session returns. This never falls through to pty or gugu-native ACP. A busy-but-live
// session returning {queued:true} is an inbox delivery only when the runtime supplies its request identity;
// callers surface identity-less queued results as a loud failure.
//
// The session backend stays a cohesive module (owner #43): we reach it only through the bridge's exported entries
// (`injectEmdashPromptDetached` / `emdashSessionSummaries`), injected here via setBridge — never a deep-import of
// the session backend's ACP runtime internals from gugu main.

import { createHash } from 'node:crypto'
import { sessionInjectionCapabilityFor } from './session-injection'
import { createLogger } from '../lib/logger'
import type { AgentStatusView } from '@gugu/core/shared/agentStatus'
import type { SessionMessageDelivery } from '@shared/core/sessions/sessions'

export interface SessionpageDeliveryReceipt {
  turnId: string
  completion: Promise<void>
  queued?: boolean
}

const log = createLogger('sessionpage/agent-registry')

/**
 * 编号 5: how long a lost session's reconnect, kicked by a delivery, has to come up before that batch fails in its chat. The
 * runtime's start keeps no clock (#6183); this is the delivery's own bound, the same as the claude TUI leg's readiness budget.
 * A reconnect that comes up later still goes live and pulls the batch again.
 */
export const RECONNECT_BUDGET_MS = 60_000

/** The session-backend module-boundary surface this registry needs (injected by main.ts from the loaded .cjs). */
export interface EmdashDeliveryBridge {
  injectEmdashPromptDetached(
    sessionId: string,
    text: string,
    opts?: { steerIfBusy?: boolean; coalesceKey?: string; deferredDispatch?: true },
  ): Promise<{ outcome: 'started' | 'queued' | 'declined' | 'missing'; completion: Promise<void>; turnId?: string }>
  ensureEmdashSession?(sessionId: string): Promise<void>
  /** @@@4526B 宿主 ACP 通道的取消口。 */
  cancelEmdashTurn?(sessionId: string): Promise<boolean>
  emdashSessionSummaries(): Promise<Array<{
    sessionId: string
    /** 这条 ACP 会话跑的 harness —— per-harness 注入时机声明按它查(spec session-injection)。 */
    providerId: string
    lifecycle: string
    closing?: boolean
    isGenerating: boolean
    recentActions?: string[]
    lastActionAt?: number | null
  }>>
}

export interface EmdashAgentRegistration {
  /** Delivery claimant handle. Identity/chat facts stay in the roster cache. */
  guguAgentUserId: string
  /** The conversation whose control channel this claimant owns. */
  sessionId: string
}

const SESSION_IDENTITY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface LocalSessionPeerIdentity {
  id: string
  gugu_number: number | null
  display_name: string | null
}

/** What the user's task sidebar shows for the same conversation (this machine's task DB). */
export interface LocalSessionFacts {
  sessionId: string
  title: string
  projectName: string
  status: AgentStatusView | null
  isPinned: boolean
  lastInteractedAt: string | null
}

export interface LocalSessionPeer {
  /** gugu_number is display-only and lazily minted (only once the agent is made public) — null until then. */
  identity: { users: { id: string; gugu_number: number | null; display_name: string } }
  sessionId: string
  /** The exact session-page sidebar title for this session, separate from the contact display name. */
  title: string
  /** The session-page project the session sits in. */
  project: string
  /** This machine's own status reading (core agent-status vocabulary); null = no status source yet. */
  status: AgentStatusView['status'] | null
  detail: AgentStatusView['detail']
  /** Pinned in the task sidebar. */
  pinned: boolean
  /** Last interaction, the sidebar's sort key; rows come most recent first. */
  last_active_at: string | null
  /** The harness engine recorded in the local agent roster. */
  engine?: string
}

/**
 * Join durable roster conversation bindings to canonical identity rows and the sidebar's session facts,
 * most recently active first (the sidebar's own order).
 * ❌ 没有 live/offline(#6546):进程在不在不是 peer 的事实,发给任何一行都会按原会话唤醒它。
 * 状态是本机任务库里的读数(状态写入者写的那一列),❌ 不从运行时摘要再推一遍。
 */
export function resolveLocalSessionPeers(
  bindings: readonly EmdashAgentRegistration[],
  identities: readonly LocalSessionPeerIdentity[],
  sessions: readonly LocalSessionFacts[],
): LocalSessionPeer[] {
  const byId = new Map<string, LocalSessionPeerIdentity>()
  for (const row of identities) {
    if (!SESSION_IDENTITY_UUID_RE.test(row.id)) {
      throw new Error(`local peers identity lookup: invalid identity.users.id ${JSON.stringify(row.id)}`)
    }
    if (byId.has(row.id)) throw new Error(`local peers identity lookup: ambiguous identity.users.id ${row.id}`)
    byId.set(row.id, row)
  }
  const missing = bindings.map((binding) => binding.guguAgentUserId).filter((id) => !byId.has(id))
  if (missing.length) throw new Error(`local peers identity lookup: no identity for mapped session(s): ${missing.join(', ')}`)
  const identityBySession = new Map<string, string>()
  const sessionByIdentity = new Map<string, string>()
  for (const binding of bindings) {
    const prior = identityBySession.get(binding.sessionId)
    if (prior && prior !== binding.guguAgentUserId) {
      throw new Error(`local peers identity lookup: ambiguous sessionId ${binding.sessionId} maps to ${prior} and ${binding.guguAgentUserId}`)
    }
    identityBySession.set(binding.sessionId, binding.guguAgentUserId)
    const priorSession = sessionByIdentity.get(binding.guguAgentUserId)
    if (priorSession && priorSession !== binding.sessionId) {
      throw new Error(
        `local peers identity lookup: identity ${binding.guguAgentUserId} maps to ${priorSession} and ${binding.sessionId}`,
      )
    }
    sessionByIdentity.set(binding.guguAgentUserId, binding.sessionId)
  }
  const sessionBySession = new Map<string, LocalSessionFacts>()
  for (const entry of sessions) {
    if (!entry.title.trim()) {
      throw new Error(`local peers session title lookup: empty title for ${entry.sessionId}`)
    }
    if (sessionBySession.has(entry.sessionId)) {
      throw new Error(`local peers session title lookup: ambiguous sessionId ${entry.sessionId}`)
    }
    sessionBySession.set(entry.sessionId, entry)
  }
  const peers = bindings.map((binding) => {
    if (!SESSION_IDENTITY_UUID_RE.test(binding.guguAgentUserId)) {
      throw new Error(`local peers identity lookup: non-UUID canonical identity in host mapping (${binding.guguAgentUserId})`)
    }
    const row = byId.get(binding.guguAgentUserId)!
    const session = sessionBySession.get(binding.sessionId)
    if (!session) {
      throw new Error(`local peers session title lookup: no sidebar title for ${binding.sessionId}`)
    }
    // The contact display name is the canonical identity label; the sidebar title is carried separately
    // above. The gugu number is lazily minted (public agents only) and may legitimately be null — it is
    // display-only here.
    if (!row.display_name?.trim() || (row.gugu_number !== null && !Number.isInteger(row.gugu_number))) {
      throw new Error(`local peers identity lookup: incomplete identity for ${row.id}`)
    }
    return {
      identity: { users: { id: row.id, gugu_number: row.gugu_number, display_name: row.display_name } },
      sessionId: binding.sessionId,
      title: session.title,
      project: session.projectName,
      status: session.status?.status ?? null,
      detail: session.status?.detail ?? null,
      pinned: session.isPinned,
      last_active_at: session.lastInteractedAt,
    }
  })
  return peers.sort((a, b) => activeMs(b.last_active_at) - activeMs(a.last_active_at))
}

/** 侧栏按解析后的时间排;从没交互过的排最后。 */
function activeMs(at: string | null): number {
  const ms = at ? Date.parse(at) : Number.NaN
  return Number.isNaN(ms) ? 0 : ms
}

/**
 * The delivery target the wrapped AgentRuntimeBridge consults. `provisionSessionpageAgentForSession`
 * registers a claimant at session start; boot restores roster rows behind the shared offline blocker and
 * only a live transport promotion registers this ACP target. Identity facts remain in the roster cache and
 * are deliberately not represented here.
 */
class EmdashAgentRegistry {
  readonly deliveryTargetName = 'gugu-acp'
  private bridge: EmdashDeliveryBridge | null = null
  private readonly byAgent = new Map<string, { sessionId: string }>()
  /**
   * 编号 5: per lost session, the reconnect a delivery kicked — the batch it was for (a digest of its text) and, once it ended,
   * how. A wake is a kick, not a wait (#4320): the delivery leaves its batch on the cursor and returns, so one agent's reconnect
   * never holds the device's other deliveries. When it ends — up, failed, or not up within RECONNECT_BUDGET_MS —
   * `onReconnectSettled` pulls the inbox again: up, the batch goes in; not up, it fails as before (its row in the chat). The
   * claude TUI leg's readiness budget is the same shape (claude-session-delivery.ts `markOverdue`). The same batch finding the
   * session lost again after it came up fails too, instead of restarting the adapter round and round; a new message makes a
   * new batch, and one more try. Over the budget with the start still going (`overdue`), every batch fails at once, without
   * another wake, until that start ends either way — then the record goes and things are as before (148 r3: the retry a person
   * sends after that row must not sink without a word).
   */
  private readonly reconnects = new Map<string, { batch: string; outcome?: 'up' | Error; overdue?: true }>()
  private onReconnectSettled: ((guguAgentUserId: string) => void) | null = null

  /** Inject the session-backend module-boundary bridge (main.ts, after loadEmdashBridge). */
  setBridge(bridge: EmdashDeliveryBridge | null): void {
    this.bridge = bridge
  }

  /** How the host pulls an agent's inbox again (main.ts); see `reconnects`. */
  setReconnectSettledHook(hook: ((guguAgentUserId: string) => void) | null): void {
    this.onReconnectSettled = hook
  }

  registerEmdashAgent(reg: EmdashAgentRegistration): void {
    this.byAgent.set(reg.guguAgentUserId, {
      sessionId: reg.sessionId,
    })
  }

  unregister(guguAgentUserId: string): void {
    this.byAgent.delete(guguAgentUserId)
  }

  /** Owner 交接编排的同步释放点(只摘映射;ACP 会话生命周期不归这里)。 */
  releaseAgentClaim(guguAgentUserId: string): void {
    this.unregister(guguAgentUserId)
  }

  unregisterAgent(guguAgentUserId: string, onReleased?: () => void): void {
    this.unregister(guguAgentUserId)
    onReleased?.()
  }


  /** Test-only owner snapshot. Production readers must use the roster identity index. */
  listBindingsForTest(): EmdashAgentRegistration[] {
    if (process.env.GUGU_SESSION_TEST_HOOKS !== '1' && process.env.VITEST !== 'true') {
      throw new Error('session-page owner snapshot is test-only')
    }
    return Array.from(this.byAgent, ([guguAgentUserId, binding]) => ({
      guguAgentUserId,
      sessionId: binding.sessionId,
    }))
  }

  /**
   * The session-page conversation this gugu agent is bound to, or null when the agent is NOT a session-page
   * agent (→ the wrapper passes the delivery through to gugu-native ACP, untouched). Returning non-null
   * commits the delivery to the control channel: if that session is dead, tryInjectSessionMessage fails loud — we
   * never silently fall back to pty for a mapped session-page agent.
   */
  liveSessionIdByAgent(guguAgentUserId: string): string | null {
    return this.byAgent.get(guguAgentUserId)?.sessionId ?? null
  }

  /**
   * @@@4526B `SessionpageDeliveryTarget.cancelTurn` —— 本注册表**自己**就是 `gugu-acp` 这个认领者
   * (deliveryTargetName 就在上面),所以它必须能取消自己认领的 agent 那一轮:按 agent 找到它绑定的
   * 会话,再走本类已有的 conversation 键控取消。
   *
   * ⚠️ 实测教训:少了这一格,删除序里那道「认领了却停不下来」的 fail-loud 会**当场抛**,
   * 于是本机足迹压根来不及释放 —— 一个「取消没接通」的缺陷把「孤儿」那个缺陷整个带了回来。
   */
  async cancelTurn(guguAgentUserId: string): Promise<boolean> {
    const sessionId = this.byAgent.get(guguAgentUserId)?.sessionId
    if (!sessionId) return false
    return this.cancelSessionTurn(sessionId)
  }

  async recentActionsForAgent(
    guguAgentUserId: string,
  ): Promise<{ actions: string[]; lastActionAt: string | null } | null> {
    const binding = this.byAgent.get(guguAgentUserId)
    if (!binding) return null
    const summary = (await this.bridge?.emdashSessionSummaries())
      ?.find((candidate) => candidate.sessionId === binding.sessionId)
    if (!summary) return null
    return {
      actions: summary.recentActions ?? [],
      lastActionAt:
        typeof summary.lastActionAt === 'number' ? new Date(summary.lastActionAt).toISOString() : null,
    }
  }

  async deliveryKeyForSession(sessionId: string): Promise<string | null> {
    if ([...this.byAgent.values()].some((binding) => binding.sessionId === sessionId)) {
      return sessionId
    }
    const summaries = await this.bridge?.emdashSessionSummaries()
    return summaries?.some((summary) => summary.sessionId === sessionId) ? sessionId : null
  }

  async isSessionTurnInFlight(sessionId: string): Promise<boolean> {
    const summary = (await this.bridge?.emdashSessionSummaries())
      ?.find((candidate) => candidate.sessionId === sessionId)
    return summary?.isGenerating === true
  }

  async waitUntilReady(sessionId: string): Promise<void> {
    const summary = (await this.bridge?.emdashSessionSummaries())
      ?.find((candidate) => candidate.sessionId === sessionId)
    if (!summary || summary.closing || !['ready', 'working', 'cancelling'].includes(summary.lifecycle)) {
      throw new Error(`ACP session ${sessionId} has not admitted after reopen (${summary?.lifecycle ?? 'absent'})`)
    }
  }

  /**
   * 这条 ACP 会话跑的 harness × surface —— 注入时机声明按它查(spec session-injection)。
   * ACP 结构化聊天是多家共用的一根管子,时机不是这个 target 的属性,是会话上那家 harness 的声明。
   */
  async sessionProviderSurface(
    sessionId: string,
  ): Promise<{ providerId: string; surface: 'acp' } | null> {
    const summary = (await this.bridge?.emdashSessionSummaries())
      ?.find((candidate) => candidate.sessionId === sessionId)
    return summary && !summary.closing ? { providerId: summary.providerId, surface: 'acp' } : null
  }

  /** Reopen one mapped conversation (`ensureEmdashSession` is idempotent: ACP counts `starting` as live, PTY hydrate merges in its supervisor). */
  async ensureSessionForAgent(guguAgentUserId: string): Promise<void> {
    const binding = this.byAgent.get(guguAgentUserId)
    if (!binding) return
    if (!this.bridge?.ensureEmdashSession) {
      throw new Error(`session-page session wake is unavailable — cannot wake ${binding.sessionId}`)
    }
    await this.bridge.ensureEmdashSession(binding.sessionId)
  }

  private agentOfSession(sessionId: string): string | undefined {
    return [...this.byAgent.entries()].find(([, binding]) => binding.sessionId === sessionId)?.[0]
  }

  /** 编号 5: kick a lost session's reconnect for this batch, bounded by RECONNECT_BUDGET_MS; see `reconnects`. */
  private kickReconnect(sessionId: string, batch: string, ensure: (sessionId: string) => Promise<void>): void {
    const entry: { batch: string; outcome?: 'up' | Error; overdue?: true } = { batch }
    this.reconnects.set(sessionId, entry)
    const start = ensure(sessionId)
    let startEnded = false
    let overBudget = false
    let budget: ReturnType<typeof setTimeout> | undefined
    const overdue = new Promise<never>((_, reject) => {
      budget = setTimeout(() => {
        overBudget = true
        reject(new Error(`Session '${sessionId}' lost its ACP adapter and was not reconnected within ${RECONNECT_BUDGET_MS}ms`))
      }, RECONNECT_BUDGET_MS)
      budget.unref?.()
    })
    // A start that ends after the budget, either way: the record goes (up: the start's own session-live pull brings the batch).
    const ended = () => {
      startEnded = true
      if (entry.overdue && this.reconnects.get(sessionId) === entry) this.reconnects.delete(sessionId)
    }
    void start.then(ended, ended)
    void Promise.race([start, overdue]).then(
      () => 'up' as const,
      (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    ).then((outcome) => {
      clearTimeout(budget)
      if (this.reconnects.get(sessionId) !== entry) return
      entry.outcome = outcome
      if (overBudget && !startEnded) entry.overdue = true
      if (outcome !== 'up') log.warn({ sessionId, error: outcome.message }, 'lost session reconnect gave up; its batch fails in its chat')
      const agent = this.agentOfSession(sessionId)
      if (agent) this.onReconnectSettled?.(agent)
    })
  }

  async tryInjectSessionMessage(
    sessionId: string,
    message: { id: string; text: string; kind?: 'ordinary' | 'session-direct'; delivery?: SessionMessageDelivery; deferredDispatch?: true },
  ): Promise<false | SessionpageDeliveryReceipt> {
    // @@@4708 session-direct 与读者路同一条 detached 受理路 —— 旗按这家声明的时机档置
    // (next-tool-call ⇒ steer 进当前 turn;未声明 ⇒ 会话机队列,回合末一次抽干),受理即返回、
    // completion 出带。此前这一支走非 detached「旧语义」:不看声明、忙时一律 PromptQueued,
    // codex 明明声明了 next-tool-call,军训教官照样堆出 Queued prompts (21)。
    return this.tryInjectInternal(sessionId, message.text, {
      // session-direct 的唤醒由发送方 await(#6546 injectWithWake),这里不另踢一脚。
      ...(message.kind === 'session-direct' ? { suppressWake: true } : {}),
      ...(message.delivery ? { delivery: message.delivery } : {}),
      ...(message.deferredDispatch ? { deferredDispatch: true } : {}),
    })
  }

  /**
   * @@@4526B 取消这条会话当前在飞的回合 —— 与 `tryInjectInternal` **同一条通道**:宿主 ACP 通道。
   * ❌ 宿主不按 provider 名分支,❌ 不回落 pty。
   *
   * 返回 false = **此刻没有可取消的回合**(会话不 live、或不在生成中)——那是 no-op,不是失败;
   * 通道自己的失败照常抛(owner 按了删除却没停下来,必须说出来)。
   */
  async cancelSessionTurn(sessionId: string): Promise<boolean> {
    const bridge = this.bridge
    if (!bridge) return false
    // ⚠️ ❌ 拿 emdashSessionSummaries 当闸:那份清单只列得出 ACP 会话,原生 TUI 腿在里面查不到 —— 那**不是**
    // 「没有在飞的轮」。直接交给 bridge,由会话页那侧按会话自己的类型选腿。(实测教训:早先用 summary.isGenerating
    // 当闸,原生 TUI 腿一律静默返回 false,产品明明显示 Working,删除却报告"没什么可取消的"。)
    if (!bridge.cancelEmdashTurn) {
      throw new Error(
        `session-page bridge cannot cancel the in-flight turn of ${sessionId} — refusing to report the agent as stopped`,
      )
    }
    return bridge.cancelEmdashTurn(sessionId)
  }

  private async tryInjectInternal(
    sessionId: string,
    text: string,
    opts?: { suppressWake?: boolean; delivery?: SessionMessageDelivery; deferredDispatch?: true },
  ): Promise<false | SessionpageDeliveryReceipt> {
    const bridge = this.bridge
    if (!bridge) {
      throw new Error(
        `session-page delivery bridge unavailable — cannot inject into ${sessionId} (fail-loud, no pty fallback)`,
      )
    }
    // Optional liveness pre-check for a clearer loud error; injectEmdashPromptDetached is the fail-loud backstop
    // regardless (a summaries read failure must not mask a dead session, so it does NOT swallow the throw).
    const summaries = await bridge.emdashSessionSummaries()
    const summary = summaries.find((candidate) => candidate.sessionId === sessionId)
    const reconnect = opts?.suppressWake ? undefined : this.reconnects.get(sessionId)
    // 编号 5: the reconnect a delivery kicked gave up — the pull it triggered fails the batch in hand (the one that kicked it is
    // in it: the cursor did not move), said in its chat as before (「…咕咕这边出错了」): never silence. A failed start says it
    // once, and a later message is a new try; one over the budget and still going fails every batch at once, without another
    // wake, until it ends (148 r3). A session already up by this pull (the runtime has it, the host is still recording the
    // start) takes the batch instead: a row saying it failed would be untrue (148 r4).
    if (reconnect?.outcome instanceof Error) {
      if (summary && ['ready', 'working', 'cancelling'].includes(summary.lifecycle)) {
        this.reconnects.delete(sessionId)
      } else {
        if (!reconnect.overdue) this.reconnects.delete(sessionId)
        throw reconnect.outcome
      }
    }
    // `replaying` = the session is being loaded (a reconnect's session/load): not up yet, so the batch waits on the cursor
    // like `starting` — the start's own session-live pull brings it — instead of failing as「while session is 'replaying'」.
    // 不在跑的会话由调用方经路由器的唯一唤醒口唤醒(SessionpageLocalDeliveryRouter.wakeSession),这里只答「没收」。
    if (!summary || summary.closing || summary.lifecycle === 'starting' || summary.lifecycle === 'replaying' || summary.lifecycle === 'closed') {
      return false
    }
    // 编号 5 (10-12 片场试演): an adapter that exited on its own (a crash, a stop) leaves the session `lost`. This message kicks
    // its reconnect — the runtime resumes the lost session, as the task page's Reconnect does — and waits on the cursor.
    if (summary.lifecycle === 'lost') {
      if (opts?.suppressWake) return false
      if (!bridge.ensureEmdashSession) throw new Error(`session-page session wake is unavailable — cannot reconnect ${sessionId}`)
      if (reconnect && !reconnect.outcome) return false
      const batch = createHash('sha256').update(text).digest('hex')
      if (reconnect?.batch === batch) {
        throw new Error(`Session '${sessionId}' lost its ACP adapter again after it was reconnected for these messages; not reconnecting it again for them`)
      }
      this.kickReconnect(sessionId, batch, bridge.ensureEmdashSession.bind(bridge))
      return false
    }
    // per-harness 时机档(spec session-injection):next-tool-call 家带 steerIfBusy;idle-only 家直接尝试注入。
    // runtime 带 request identity 的 queue admission 视为一次已受理投递;无 identity 的 queued 结果才转成 loud failure。
    // 发信方要「排队」(delivery.queue)时不插:忙就排进会话机的队列,这一轮结束作为下一轮送出;同键的排队消息原地替换。
    const steerIfBusy = !opts?.delivery?.queue
      && sessionInjectionCapabilityFor(summary.providerId, 'acp').timing === 'next-tool-call'
    const injectOpts = {
      ...(steerIfBusy ? { steerIfBusy: true } : {}),
      ...(opts?.delivery?.coalesceKey ? { coalesceKey: opts.delivery.coalesceKey } : {}),
      ...(opts?.deferredDispatch ? { deferredDispatch: true as const } : {}),
    }
    let nativeMissing = false
    try {
      const result = await bridge.injectEmdashPromptDetached(
        sessionId,
        text,
        Object.keys(injectOpts).length > 0 ? injectOpts : undefined,
      )
      // 会话此刻不收(原位回退进行中):没收下,消息留在来源侧。
      if (result.outcome === 'declined') return false
      if (result.outcome === 'missing') {
        nativeMissing = true
        if (opts?.suppressWake) return false // The session-direct sender owns its one reopen attempt.
        const batch = createHash('sha256').update(text).digest('hex')
        if (reconnect?.batch === batch) throw new Error(`Session '${sessionId}' refused these messages before a turn again after recovery`)
        if (!bridge.ensureEmdashSession) throw new Error(`session-page session wake is unavailable — cannot reconnect ${sessionId}`)
        this.kickReconnect(sessionId, batch, bridge.ensureEmdashSession.bind(bridge))
        return false
      }
      if (result.outcome === 'queued' && !result.turnId) {
        throw new Error(
          `session-page session ${sessionId} returned queued without an admission identity; `
            + 'live inbox delivery cannot determine whether the machine accepted it',
        )
      }
      // Taken: a later loss of this session is a new one (148 评审: the same text may come again).
      this.reconnects.delete(sessionId)
      return {
        // 宿主 ACP 桥给的是 runtime 的受理 request id;不给 id 的桥才退到 conversationId(仅标识、非回执)。
        turnId: result.turnId ?? sessionId,
        completion: result.completion,
        queued: result.outcome === 'queued',
      }
    } catch (error) {
      if (nativeMissing) throw error
      const afterFailure = await bridge.emdashSessionSummaries()
      const current = afterFailure.find((candidate) => candidate.sessionId === sessionId)
      if (!current || current.lifecycle === 'closed') return false
      throw error
    }
  }
}

export const emdashAgentRegistry = new EmdashAgentRegistry()

/** Register an ACP delivery claimant. Called automatically at session-page session start by
 *  provisionSessionpageAgentForSession; boot installs the shared offline blocker instead. */
export function registerEmdashAgent(reg: EmdashAgentRegistration): void {
  emdashAgentRegistry.registerEmdashAgent(reg)
}

/** Drop a binding (session closed / agent gone). Used by the delivery fail-loud unit test. */
export function unregisterEmdashAgent(guguAgentUserId: string): void {
  emdashAgentRegistry.unregister(guguAgentUserId)
}
