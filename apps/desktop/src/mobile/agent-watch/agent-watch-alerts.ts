import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { presentAgentStatus, type AgentStatusLabel } from '@gugu/core/shared/agentStatusPresentation'
import { sessionReading } from './watch-status'

/**
 * 「哪条会话该叫人」——纯函数，与界面、与传输都无关。
 *
 * 为什么单独一份纯函数：提醒的失败模式是「该响的没响 / 不该响的响了 / 同一件事响两次」，
 * 这三样只有在**能被反复喂同一份输入**的地方才验得动。写在组件里的话，判据只能是
 * 「我盯着屏幕看了一会儿没重复」。
 *
 * 事实源是宿主状态写入者的那份读数(`sessionReading`:新宿主的 `status`,老宿主的旧词 `agentStatus`),
 * 与桌面角标、手机列表同一份 —— ❌ 不自造第二份推导(#3961:同形拷贝各改各的,于是有一份永远是旧的)。
 *
 * 三件事叫人:需要你(等批准 / 等回答 / 等看计划 …)、出错了、做完了(回到空闲且未读 —— 未读位只由回合结束
 * 那条边写出(spec hook-status-derivation),出生 / 退出的空闲都是已读)。在跑、后台在跑不叫人。
 */

export type AgentWatchAlert = {
  sessionId: string
  title: string
  kind: 'waiting' | 'done' | 'error'
  /** 横幅上那一句:与列表、页头同一张表(等你批准 / 等你回答 / 出错了 / 做完了 …)。 */
  label: AgentStatusLabel
}

/** conversationId → 上次见到的观测(状态 + 未读)。null 表示这条会话还没有状态。 */
export type AgentWatchStatusMap = Readonly<Record<string, string | null>>

/**
 * 做完未读是 idle 上的属性:只比状态会把 idle(已读)→ idle(未读)看成「没变」。附属态也进观测:
 * 从「等你批准」换成「等你回答」是新的一件事。
 */
function observationOf(session: SessionpageSessionSummary): string | null {
  const reading = sessionReading(session)
  return reading === null ? null : `${reading.status}|${reading.detail ?? ''}|${session.unseen === true ? 'unseen' : 'seen'}`
}

export function statusMapOf(sessions: readonly SessionpageSessionSummary[]): AgentWatchStatusMap {
  const map: Record<string, string | null> = {}
  for (const session of sessions) map[session.conversationId] = observationOf(session)
  return map
}

/**
 * 上一份状态 → 这一份，算出该叫人的那些。
 *
 * 只报**变化**：
 *  · 第一次见到这条会话不报 —— 那是在报旧闻（进一次页面就把历史上所有等待都弹一遍）。
 *  · 状态没变不报 —— 宿主一次状态跳动会重推整份列表，不去重的话同一件事会响很多次。
 */
export function diffAlerts(
  previous: AgentWatchStatusMap,
  sessions: readonly SessionpageSessionSummary[],
): AgentWatchAlert[] {
  const alerts: AgentWatchAlert[] = []
  for (const session of sessions) {
    const before = previous[session.conversationId]
    // `undefined` = 这一轮才第一次见到它（刚订上、或机器上新建的会话）。
    if (before === undefined) continue
    if (observationOf(session) === before) continue
    const reading = sessionReading(session)
    const kind = reading?.status === 'needs_user' ? 'waiting'
      : reading?.status === 'error' ? 'error'
      : reading?.status === 'idle' && session.unseen === true ? 'done'
      : null
    if (kind === null) continue
    const { label } = presentAgentStatus({ reading, unseen: session.unseen === true })
    alerts.push({ sessionId: session.conversationId, title: session.title, kind, label })
  }
  return alerts
}
