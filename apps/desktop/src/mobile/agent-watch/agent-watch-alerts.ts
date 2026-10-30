import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import type { AgentStatusView } from '@gugu/core/shared/agentStatus'
import { presentAgentStatus, type AgentStatusLabel } from '@gugu/core/shared/agentStatusPresentation'
import { shouldNotify } from '@gugu/core/shared/ui/notificationModels'
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
 * 叫不叫人由 shouldNotify 定,与桌面、与聊天同一份判据:只有停下来等你(等批准 / 等回答 / 等看计划 …)叫人;
 * 做完、出错、在跑这类纯状态变化不叫(owner 10-30)。
 */

export type AgentWatchAlert = {
  sessionId: string
  title: string
  /** 横幅上那一句:与列表、页头同一张表(等你批准 / 等你回答 …)。 */
  label: AgentStatusLabel
}

/** conversationId → 上次见到的读数。null 表示这条会话还没有状态。 */
export type AgentWatchStatusMap = Readonly<Record<string, AgentStatusView | null>>

export function statusMapOf(sessions: readonly SessionpageSessionSummary[]): AgentWatchStatusMap {
  const map: Record<string, AgentStatusView | null> = {}
  for (const session of sessions) map[session.conversationId] = sessionReading(session)
  return map
}

/**
 * 上一份状态 → 这一份，算出该叫人的那些。`onScreen`:人此刻正盯着的那条会话,页头已经在说这件事。
 *
 * 第一次见到这条会话不报 —— 那是在报旧闻（进一次页面就把历史上所有等待都弹一遍）。
 * 同一件等待被重推不报(shouldNotify 比前后两份读数)。
 */
export function diffAlerts(
  previous: AgentWatchStatusMap,
  sessions: readonly SessionpageSessionSummary[],
  onScreen: (sessionId: string) => boolean,
): AgentWatchAlert[] {
  const alerts: AgentWatchAlert[] = []
  for (const session of sessions) {
    const before = previous[session.conversationId]
    // `undefined` = 这一轮才第一次见到它（刚订上、或机器上新建的会话）。
    if (before === undefined) continue
    const reading = sessionReading(session)
    if (!shouldNotify({ kind: 'agent', previous: before, next: reading }, { enabled: true, onScreen: onScreen(session.conversationId) })) continue
    const { label } = presentAgentStatus({ reading, unseen: session.unseen === true })
    alerts.push({ sessionId: session.conversationId, title: session.title, label })
  }
  return alerts
}
