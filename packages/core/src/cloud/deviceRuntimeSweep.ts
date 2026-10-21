import type { AgentActivityStatus } from '../shared/types/chat'
import { isAgentActive, type AgentStatusReading } from '../shared/agentStatus'

// #2151 device-runtime startup online sweep 的纯逻辑（可单测，无 closure/IO 依赖）。
//
// 根因修复（守卫收口版）：gone-agent（本地 agents.json 里有、但 DB 里已删/非本 owner）的 runtime-state
// 写会命中 migration 036 `can_write_agent_runtime_state` 的 RAISE「not writable」→ churn。守卫已**收敛到
// `createAgentRuntimeStateReporter` 单一 choke point**（gone→本地 drop + swallow，不 throw、不 stderr），
// 覆盖全部写点（sweep / 周期 tick-report / command-wake 触发的 tick）。
//
// 故本 sweep 无需再自查 DB 存量 / 自己 drop：它只负责「给本机每个候选 agent 发布 online + 它此刻的
// activity」并把**真错误**（非 gone：网络/其它）汇报出来。gone 的写会被 reportOnline 底层的 reporter
// 静默处理（drop + 不抛），sweep 视之为成功——干净、DRY、单一职责（drop 只在 choke point 一处）。
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

export interface SweepLocalAgentsDeps {
  /** 候选本机 agent 的 gugu_user_id（调用方已滤掉 cloud / 无 gugu_user_id 的）。 */
  agentUserIds: string[]
  /**
   * 给一个 agent 写 online runtime-state 与它此刻的读数
   * （底层 reporter 已收口 gone→drop+swallow，只有真错误会 throw）。
   */
  reportOnline: (agentUserId: string, published: PublishedAgentStatus) => Promise<void>
  /** 这个 agent 在本机的读数;null = 本机没有它的状态。 */
  statusOf?: (agentUserId: string) => AgentStatusReading | null
  /** stop()/re-login race 中途 bail：返回 true 立刻中止本次 sweep（不算干净成功）。 */
  shouldBail: () => boolean
  warn?: (message: string) => void
}

const errMsg = (error: unknown): string => String((error as Error)?.message ?? error)

/**
 * 返回「本次是否干净全成功」——所有候选 agent 都成功写 online（gone 的经 choke point 静默处理亦算干净）、
 * 无 bail、无**真错误**写失败。真错误（网络等非 gone）→ allOk=false（下个 authed tick 重扫，reportOnline
 * 幂等，重扫已上线者无害），❌ 不在此 drop 任何 agent（never mass-remove on a blip；gone 的 drop 归 choke point）。
 */
export async function sweepLocalAgentsOnline(deps: SweepLocalAgentsDeps): Promise<boolean> {
  const { agentUserIds, reportOnline, statusOf, shouldBail, warn } = deps
  if (agentUserIds.length === 0) return true
  if (shouldBail()) return false

  let allOk = true
  for (const agentUserId of agentUserIds) {
    if (shouldBail()) return false
    // @@@publish-in-flight (#3961) — 在跑是**一个值**,不是一个豁免:在跑就不写,权威行会停在上一次写下的 idle 上。
    try {
      await reportOnline(agentUserId, publishedStatusOf(statusOf?.(agentUserId) ?? null))
    } catch (error) {
      // gone 已由底层 reporter 静默处理（drop+swallow，不到这里）；到这里的只有真错误（网络/其它）。
      warn?.(`[device-runtime] startup online sweep failed for ${agentUserId}: ${errMsg(error)}`)
      allOk = false
    }
  }
  return allOk
}

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
