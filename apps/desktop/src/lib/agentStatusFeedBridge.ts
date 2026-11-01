import { parseAgentStatusReading } from '@gugu/core/shared/agentStatus'
import { STAGES } from '@gugu/core/local/session-life/types'
import type { LifeStatus, LifeView } from '@/session/shared/core/sessions/session-life'
import { setLocalAgentStatus, type LocalAgentStatus } from './agentPresenceStore'
import { parseProviderBlocker, parseProviderReviewGate } from './sessionpageAgentProjection'
import { desktopIpc, type DesktopIpc } from '../platform/desktopIpc'

// 宿主按 agent 的流(spec agent-status-writer「宿主按 agent 的流」)在渲染层的落点。**渲染层的单属主** ——
// 一个 app 级单例,不挂在任何视图上。
//
// 这一层做三件事,一件不多:
//   ① 连接时拿一次快照对齐;
//   ② 之后只吃按 agent 的变化(payload 自带主体,❌ 消费方不拼身份);
//   ③ 每一条按 agentId 写进那张唯一的表(setLocalAgentStatus)。
// 先后只看宿主盖的版本(宿主进程里单调递增的一个数,出现、变化、消失都盖):快照与变化谁先到结果都一样,
// 比已知旧的那一句对已知的没有话可说。❌ 不轮询、❌ 不在读的时候顺手纠正、❌ 自己推导状态。
export const AGENT_STATUS_FEED_EVENT = 'agent-status-feed'
export const AGENT_STATUS_FEED_SNAPSHOT = 'agent-status-feed:snapshot'

/** 每个 agent 已经写进表的那一句的版本。它存在只为了认出乱序到达的旧话。 */
let applied = new Map<string, number>()
let installed = false

/** 宿主的版本。缺它 = 这一句没法与已知的比新旧 ⇒ 协议被破坏,响亮地停。 */
function readVersion(value: unknown, what: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new Error(`${what} carries no host version`)
}

function readAgentUserId(value: unknown, what: string): string {
  const agentUserId = (value as { agentUserId?: unknown } | null)?.agentUserId
  if (typeof agentUserId !== 'string' || !agentUserId) throw new Error(`${what} has no agentUserId`)
  return agentUserId
}

/** 缺席或 `null` = 正常;别的形状 = 协议被破坏,响亮地抛。 */
function readStatusSourceFault(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error('agent status feed entry carries a malformed statusSourceFault')
  return value
}

const LIFE_KINDS: readonly LifeView['kind'][] = ['dormant', 'starting', 'ready', 'stopping', 'failed', 'archived']

/** The bound session's lifecycle: `null` = session-life does not own it; anything else malformed throws. */
function readLife(value: unknown): LifeStatus | null {
  if (value === null) return null
  const life = value as { kind?: unknown; stage?: unknown } | undefined
  if (!life || typeof life !== 'object' || !LIFE_KINDS.includes(life.kind as LifeView['kind'])) {
    throw new Error('agent status feed entry carries a malformed life')
  }
  return { kind: life.kind as LifeView['kind'], stage: readStage(life.stage) }
}

function readStage(value: unknown): LifeView['stage'] {
  if (value === null) return null
  const stage = value as { at?: unknown; index?: unknown; total?: unknown; since?: unknown } | undefined
  if (!stage || typeof stage !== 'object' || !STAGES.includes(stage.at as (typeof STAGES)[number])
    || typeof stage.index !== 'number' || stage.total !== 7 || typeof stage.since !== 'number') {
    throw new Error('agent status feed entry carries a malformed life stage')
  }
  return { at: stage.at as (typeof STAGES)[number], index: stage.index, total: 7, since: stage.since }
}

/** 流里的一条。`null` = 这个 agent 不再绑在这台机器的任何会话上。形状不对响亮地抛。 */
function readLocal(value: unknown): LocalAgentStatus | null {
  if (value === null) return null
  if (!value || typeof value !== 'object') throw new Error('agent status feed entry is malformed')
  const row = value as Record<string, unknown>
  if (typeof row.sessionId !== 'string' || !row.sessionId) {
    throw new Error('agent status feed entry has no sessionId')
  }
  if (typeof row.unseen !== 'boolean') throw new Error('agent status feed entry has no unseen flag')
  return {
    sessionId: row.sessionId,
    reading: parseAgentStatusReading(row.reading),
    unseen: row.unseen,
    reviewGate: parseProviderReviewGate(row.reviewGate ?? null),
    providerBlocker: parseProviderBlocker(row.providerBlocker),
    statusSourceFault: readStatusSourceFault(row.statusSourceFault),
    life: readLife(row.life),
  }
}

function apply(agentUserId: string, local: LocalAgentStatus | null, version: number): void {
  if ((applied.get(agentUserId) ?? -Infinity) >= version) return
  applied.set(agentUserId, version)
  setLocalAgentStatus(agentUserId, local)
}

/** (重)连接时的那一次对齐。快照里没有的 agent 此刻不绑在这台机器上:比快照旧的那一句作废。 */
async function reconcile(api: DesktopIpc): Promise<void> {
  const raw = await api.invoke(AGENT_STATUS_FEED_SNAPSHOT)
  if (!raw || typeof raw !== 'object') throw new Error('agent status feed snapshot is malformed')
  const version = readVersion((raw as { version?: unknown }).version, 'agent status feed snapshot')
  const entries = (raw as { entries?: unknown }).entries
  if (!Array.isArray(entries)) throw new Error('agent status feed snapshot has no entries')
  const present = new Set<string>()
  for (const entry of entries) {
    const agentUserId = readAgentUserId(entry, 'agent status feed snapshot entry')
    present.add(agentUserId)
    apply(agentUserId, readLocal(entry), version)
  }
  for (const agentUserId of [...applied.keys()]) {
    if (!present.has(agentUserId)) apply(agentUserId, null, version)
  }
}

export function installAgentStatusFeedBridge(): void {
  if (installed) return
  const api = desktopIpc()
  // 没有 electron 桥 = 这台设备上没有本机宿主(web target)。那时本机压根没有这条腿,读数全部来自云端
  // 那一行 —— 不是降级兜底,是这条腿本来就不存在。
  if (!api) return
  installed = true
  api.eventOn(AGENT_STATUS_FEED_EVENT, (value) => {
    if (!value || typeof value !== 'object') throw new Error('agent status feed event is malformed')
    const event = value as { entry?: unknown; version?: unknown }
    apply(
      readAgentUserId(value, 'agent status feed event'),
      readLocal(event.entry ?? null),
      readVersion(event.version, 'agent status feed event'),
    )
  })
  void reconcile(api)
}

/** 测试用清场:把这个单例退回从未 install 过的状态。 */
export function resetAgentStatusFeedBridgeForTest(): void {
  applied = new Map()
  installed = false
}
