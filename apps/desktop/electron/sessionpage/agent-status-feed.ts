// spec agent-status-writer「宿主按 agent 的流」—— 咕咕一侧读会话页 agent 状态的唯一入口。
//
// 按 agent 的状态 = 花名册把这个 agent 绑在哪条会话上,就是那条会话的读数,原样。花名册一个 agent 只绑一条
// 会话(`SESSION_CACHE_KEY`),所以这里 ❌ 在多条会话之间按优先级折叠:那会把已经不绑的旧会话的状态
// 一直顶在 agent 身上。读数只有一个来源:状态写入者的输出(`onAgentStatus` / `agentStatusSnapshot`)。

import type { AgentStatusReading } from '@gugu/core/shared/agentStatus'
import type { LifeStatus, LifeView } from '@shared/core/sessions/session-life'
import {
  sessionInScope,
  type AgentStatusChange,
  type SessionScope,
} from '@shared/core/sessions/sessionEvents'
import { createLogger } from '../lib/logger'
import { onSessionpageAgentProvisioned } from './emdash-agent-provisioning'
import { guguAgentUserIdForSession } from './sessionpage-session-agent'

const log = createLogger('sessionpage/agent-status-feed')

export type AgentStatusFeedEntry = Omit<AgentStatusChange, 'reading' | 'projectId'> & {
  agentUserId: string
  reading: AgentStatusReading | null
  /** The bound session's lifecycle; null = session-life does not own it (terminal legs). */
  life: LifeStatus | null
}

export interface AgentStatusFeedSource {
  onAgentStatus(cb: (change: AgentStatusChange) => void): () => void
  agentStatusSnapshot(): Promise<AgentStatusChange[]>
  onSessionsGone(cb: (scope: SessionScope) => void): () => void
  onSessionLifeView(cb: (view: LifeView) => void): () => void
  sessionLifeStatusOf(sessionId: string): LifeStatus | null
}

/**
 * 一个 agent 的条目变了(出现、变化、消失 = `null`)。`version` 是这张表的版本:每一次变化(含消失)都加一,
 * 快照也带着它 —— 接收方按它排先后,快照与变化谁先到都一样(❌ 按到达顺序猜)。
 */
type Listener = (
  agentUserId: string,
  entry: AgentStatusFeedEntry | null,
  previous: AgentStatusFeedEntry | null,
  version: number,
) => void

export class AgentStatusFeed {
  private readonly changes = new Map<string, AgentStatusChange>()
  private readonly agentOf = new Map<string, string>()
  private readonly sessionOf = new Map<string, string>()
  private readonly entries = new Map<string, AgentStatusFeedEntry>()
  private readonly listeners = new Set<Listener>()
  private readonly disposers: Array<() => void> = []
  private lifeOf: (sessionId: string) => LifeStatus | null = () => {
    throw new Error('agent status feed is not attached')
  }
  private version = 0

  get(agentUserId: string): AgentStatusFeedEntry | null {
    return this.entries.get(agentUserId) ?? null
  }

  /** 此刻的全部条目,和它们对应的那个版本。 */
  snapshot(): { entries: AgentStatusFeedEntry[]; version: number } {
    return { entries: [...this.entries.values()], version: this.version }
  }

  /** 订阅条目的变化。返回退订函数。 */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * 接上会话页:变化订阅 + 启动快照 + 绑定事件 + 会话消失。重复 attach 先摘掉上一套(热重载 / 重开会话页)。
   * 快照读失败只告警:它只让宿主不必等下一次写入,丢了由之后的写入补上。
   */
  attach(source: AgentStatusFeedSource, deps: { env: NodeJS.ProcessEnv; warn?: (message: string) => void }): void {
    this.dispose()
    this.lifeOf = (sessionId) => source.sessionLifeStatusOf(sessionId)
    this.disposers.push(
      source.onAgentStatus((change) => void this.observe(change, deps)),
      source.onSessionLifeView((view) => {
        const agentUserId = this.agentOf.get(view.sessionId)
        if (agentUserId) this.publish(agentUserId)
      }),
      source.onSessionsGone((scope) => this.forget(scope)),
      onSessionpageAgentProvisioned((event) => this.bind(event.agentUserId, event.sessionId)),
    )
    void source
      .agentStatusSnapshot()
      .then(async (changes) => {
        for (const change of changes) await this.observe(change, deps)
      })
      .catch((error: unknown) => {
        deps.warn?.(`[agent-status-feed] status snapshot failed: ${String((error as Error)?.message ?? error)}`)
      })
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose()
    this.changes.clear()
    this.agentOf.clear()
    this.sessionOf.clear()
    this.entries.clear()
  }

  private async observe(change: AgentStatusChange, deps: { env: NodeJS.ProcessEnv; warn?: (message: string) => void }) {
    this.changes.set(change.sessionId, change)
    const bound = this.agentOf.get(change.sessionId)
    if (bound) {
      this.publish(bound)
      return
    }
    try {
      const agentUserId = await guguAgentUserIdForSession(change.sessionId, deps.env)
      // 会话还没有身份(身份在 provisioning 之后才有,那时 provisioned 事件会补上绑定)。
      if (agentUserId) this.bind(agentUserId, change.sessionId)
    } catch (error) {
      deps.warn?.(
        `[agent-status-feed] agent lookup failed for ${change.sessionId}: ${String((error as Error)?.message ?? error)}`,
      )
    }
  }

  /** 花名册把 agent 绑到这条会话上:它之前绑的那条就不再代表它。 */
  private bind(agentUserId: string, sessionId: string): void {
    const previous = this.sessionOf.get(agentUserId)
    if (previous === sessionId && this.agentOf.get(sessionId) === agentUserId) return
    if (previous) this.agentOf.delete(previous)
    const formerAgent = this.agentOf.get(sessionId)
    if (formerAgent && formerAgent !== agentUserId) {
      this.sessionOf.delete(formerAgent)
      this.publish(formerAgent)
    }
    this.sessionOf.set(agentUserId, sessionId)
    this.agentOf.set(sessionId, agentUserId)
    this.publish(agentUserId)
  }

  private forget(scope: SessionScope): void {
    for (const [sessionId, change] of [...this.changes]) {
      if (!sessionInScope(change, scope)) continue
      this.changes.delete(sessionId)
      const agentUserId = this.agentOf.get(sessionId)
      if (!agentUserId) continue
      this.agentOf.delete(sessionId)
      this.sessionOf.delete(agentUserId)
      this.publish(agentUserId)
    }
  }

  private publish(agentUserId: string): void {
    const sessionId = this.sessionOf.get(agentUserId)
    const change = sessionId ? this.changes.get(sessionId) : undefined
    const previous = this.entries.get(agentUserId) ?? null
    const life = sessionId ? this.lifeOf(sessionId) : null
    // The lifecycle stands on its own: a session that is starting (or failed) before its first status reading shows so.
    const next: AgentStatusFeedEntry | null = sessionId && (change || life)
      ? { sessionId, agentUserId, reading: change?.reading ?? null, unseen: change?.unseen ?? false, reviewGate: change?.reviewGate ?? null,
        providerBlocker: change?.providerBlocker ?? null, statusSourceFault: change?.statusSourceFault ?? null,
        life: life ? { kind: life.kind, stage: life.stage } : null }
      : null
    if (previous === null && next === null) return
    if (previous && next && sameEntry(previous, next)) return
    if (next) this.entries.set(agentUserId, next)
    else this.entries.delete(agentUserId)
    const version = ++this.version
    for (const listener of this.listeners) {
      try {
        listener(agentUserId, next, previous, version)
      } catch (error) {
        // 一个订阅者的问题不影响下一个订阅者,也不影响这张表 —— 但必须留声,❌ 吞掉。
        log.error({ agentUserId, err: error }, 'agent status feed listener threw')
      }
    }
  }
}

function sameEntry(a: AgentStatusFeedEntry, b: AgentStatusFeedEntry): boolean {
  return (
    a.sessionId === b.sessionId
    && a.unseen === b.unseen
    && a.reviewGate === b.reviewGate
    && a.providerBlocker?.message === b.providerBlocker?.message
    && a.statusSourceFault === b.statusSourceFault
    && JSON.stringify(a.reading) === JSON.stringify(b.reading)
    && JSON.stringify(a.life) === JSON.stringify(b.life)
  )
}

export const agentStatusFeed = new AgentStatusFeed()
