import type { AgentActivityStatus } from '../shared/types/chat'
import { isAgentActive, type AgentStatusReading } from '../shared/agentStatus'

// 本机 agent 状态边沿发布的纯逻辑(可单测,无 closure/IO 依赖)。gone 的写(DB 里已删/非本 owner,
// `can_write_agent_runtime_state` 的「not writable」)由 `createAgentRuntimeStateReporter` 这一个 choke point
// drop + swallow,这里只看到真错误。
//
// 发布的内容只有一个来源:这个 agent 在本机的读数(spec agent-status-vocabulary,会话页状态写入者 → 宿主按 agent
// 的流)。云端行上同时写读数本身(新客户端读)与它的 running/idle 投影(老客户端读)。❌ 在此另立一套判断
// (最近有没有动作、有没有回过消息、投递命令在不在执行之类):那正是「两个事实源给出两个答案」的来源。

/** 一次发布写到云端 presence 行上的内容:running/idle 投影 + 读数本身。 */
export interface PublishedAgentStatus {
  activityStatus: AgentActivityStatus
  reading: Pick<AgentStatusReading, 'status' | 'detail'> | null
}

export function publishedStatusOf(reading: AgentStatusReading | null): PublishedAgentStatus {
  return {
    activityStatus: isAgentActive(reading) ? 'running' : 'idle',
    reading: reading ? { status: reading.status, detail: reading.detail } : null,
  }
}

export function samePublishedStatus(a: PublishedAgentStatus | undefined, b: PublishedAgentStatus): boolean {
  return a !== undefined
    && a.activityStatus === b.activityStatus
    && (a.reading?.status ?? null) === (b.reading?.status ?? null)
    && (a.reading?.detail ?? null) === (b.reading?.detail ?? null)
}

const errMsg = (error: unknown): string => String((error as Error)?.message ?? error)

// @@@activity-edge (#3961) — 边沿触发的状态发布。
//
// 为什么周期对账不够:对账间隔是 120s,而 UI 侧 #1947 的自愈死线是 90s(宽限期)。回合开始后若没有
// 一次对账正好落在这 90 秒之内,权威行仍停在 idle,自愈边照样开火 —— 约四分之一的长回合会漏。
// 所以读数**一变就发**(宿主按 agent 的流宣告变化,2 秒一轮的节律兜底);周期对账修补丢失的写。
//
// 只在与「上次已发布的值」不同时才写:tick 是 2 秒一轮,无条件写会把它变成一个每秒半次的写风暴,
// 写失败**不记入已发布**,于是下一轮自动重试 —— 不吞错、自愈。
export interface AgentStatusTransitionDeps {
  /** 候选本机 agent 的 gugu_user_id。 */
  agentUserIds: string[]
  /** 本 host 生命周期内「已发布过什么」的记忆。函数会就地更新它。 */
  published: Map<string, PublishedAgentStatus>
  /** 这个 agent 在本机的读数;null = 本机没有它的状态。 */
  statusOf?: (agentUserId: string) => AgentStatusReading | null
  report: (agentUserId: string, published: PublishedAgentStatus) => Promise<void>
  /** Optional second fact stream that may require a report while the status is unchanged. */
  shouldPublish?: (agentUserId: string) => boolean
  shouldBail: () => boolean
  warn?: (message: string) => void
}

export async function publishAgentStatusTransitions(deps: AgentStatusTransitionDeps): Promise<void> {
  const { agentUserIds, published, statusOf, report, shouldBail, warn } = deps
  // 已不在候选里的 agent(删号/登出)不该继续占着记忆,否则它再出现时首次变化会被误判成「没变」。
  const alive = new Set(agentUserIds)
  for (const known of [...published.keys()]) {
    if (!alive.has(known)) published.delete(known)
  }
  for (const agentUserId of agentUserIds) {
    if (shouldBail()) return
    const next = publishedStatusOf(statusOf?.(agentUserId) ?? null)
    if (samePublishedStatus(published.get(agentUserId), next) && !deps.shouldPublish?.(agentUserId)) continue
    try {
      await report(agentUserId, next)
      published.set(agentUserId, next)
    } catch (error) {
      // 不记入已发布 ⇒ 下一轮 tick 自动重试。gone 的写已在 reporter 层 drop+swallow,到不了这里。
      warn?.(`[device-runtime] activity publish failed for ${agentUserId}: ${errMsg(error)}`)
    }
  }
}
