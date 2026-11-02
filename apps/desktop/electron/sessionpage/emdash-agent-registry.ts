// @@@sessionpage TASKPAGE-FUSION — the addressing map + control-channel delivery target that lets one
// session-page codex session message another inside the 任务 (task) tab. This module owns only the ACP delivery
// claimant: a gugu agent identity is provisioned and persisted in the roster (see emdash-agent-provisioning.ts),
// while this map records which conversation currently owns the ACP control channel. Identity resolution never
// consults this map.
//
// A mapped claimant's inbox units go into the host's session lifecycle owner (session-life): its durable queue starts
// the session when needed and marks the rows read once the agent accepts them. Nothing here injects or wakes.
//
// The session backend stays a cohesive module (owner #43): we reach it only through the bridge's exported entries
// (`sessionLife` / `emdashSessionSummaries`), injected here via setBridge — never a deep-import of
// the session backend's ACP runtime internals from gugu main.

import { isImplicitSessionHomeProjectId } from '@gugu/core/shared/sessionProject'
import type { AgentStatusView } from '@gugu/core/shared/agentStatus'
import type { AgentInboxSource } from '@gugu/core/local/agent/agentInboxReader'

export interface SessionpageDeliveryReceipt {
  turnId: string
  completion: Promise<void>
  queued?: boolean
}


/** The session-backend module-boundary surface this registry needs (injected by main.ts from the loaded .cjs). */
export interface EmdashDeliveryBridge {
  /** The host's session lifecycle owner: its one queue entry. */
  sessionLife(): { enqueue(input: { sessionId: string; messageId: string; text: string; kind: 'inbox-batch'; sources: readonly (AgentInboxSource & { agentUserId: string })[] }): unknown }
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
  session_archived_at?: string | null
}

/** What the user's task sidebar shows for the same conversation (this machine's task DB). */
export interface LocalSessionFacts {
  sessionId: string
  projectId?: string
  title: string
  projectName: string
  status: AgentStatusView | null
  isPinned: boolean
  lastInteractedAt: string | null
}

export interface LocalSessionPeer {
  /** gugu_number is display-only and lazily minted (only once the agent is made public) — null until then. */
  identity: { users: { id: string; gugu_number: number | null; display_name: string; session_archived_at?: string | null } }
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
      identity: { users: { id: row.id, gugu_number: row.gugu_number, display_name: row.display_name,
        ...(row.session_archived_at != null ? { session_archived_at: row.session_archived_at } : {}) } },
      sessionId: binding.sessionId,
      title: session.title,
      project: isImplicitSessionHomeProjectId(session.projectId) ? '' : session.projectName,
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
  /** Inject the session-backend module-boundary bridge (main.ts, after loadEmdashBridge). */
  setBridge(bridge: EmdashDeliveryBridge | null): void {
    this.bridge = bridge
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

  /** Messages to an ACP session are enqueued (sendMessage, the reader's unit): the router never injects into one. */
  async tryInjectSessionMessage(sessionId: string): Promise<false | SessionpageDeliveryReceipt> {
    throw new Error(`ACP session ${sessionId} takes messages only through session-life; nothing injects into it directly`)
  }

  enqueueInbox(sessionId: string, unit: { messageId: string; text: string; agentUserId: string; sources: readonly AgentInboxSource[] }): void {
    if (!this.bridge) throw new Error(`session-page delivery bridge unavailable — cannot enqueue into ${sessionId}`)
    this.bridge.sessionLife().enqueue({ sessionId, messageId: unit.messageId, text: unit.text, kind: 'inbox-batch',
      sources: unit.sources.map((source) => ({ ...source, agentUserId: unit.agentUserId })) })
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
