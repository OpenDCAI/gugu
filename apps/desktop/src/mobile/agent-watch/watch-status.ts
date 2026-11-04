/**
 * 会话那一小格的**取值**(纯函数,不含组件)。
 *
 * 与 `StatusGlyph.tsx` 分开是有原因的:一个文件同时导出组件和普通函数会让 HMR 整页刷新
 * (react-refresh/only-export-components),而这几个函数在会话列表里是按行调用的热点。
 *
 * 画成什么(那一句、颜色、动不动)❌ 不在这里另定:与会话页、聊天同一个 `presentAgentStatus`
 * (packages/core/src/shared/agentStatusPresentation.ts,owner 2026-09-25 定表)。具名 Agent 的读数和可达均来自同一张 presence 表；无身份任务保留宿主任务读数。
 */
import { parseAgentStatusView, type AgentStatusView } from '@gugu/core/shared/agentStatus'
import type { AgentStatusPresentation } from '@gugu/core/shared/agentStatusPresentation'
import { taskPresentation } from '@/lib/taskAgentStatus'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { rendererLogger } from '@/lib/log'

const watchLog = rendererLogger('mobile/agent-watch')

type SessionStatusFields = Pick<SessionpageSessionSummary, 'conversationId' | 'status'>

/**
 * 目录里这条会话的读数(宿主报的 `status`:基础态 + 附属态)。0.2.51 以前的宿主不报它,这一格画成「状态不可用」。
 * 认不出的词是协议被破坏:记一条错误、这一格画成「状态不可用」—— ❌ 不猜成空闲,也 ❌ 不让一条坏行把整张列表拖垮。
 */
export function sessionReading(session: SessionStatusFields): AgentStatusView | null {
  if (session.status === undefined) return null
  try {
    return parseAgentStatusView(session.status)
  } catch (error) {
    watchLog.error({ sessionId: session.conversationId, error: String(error) }, 'session status is not in the vocabulary')
    return null
  }
}

/** 目录里的一条会话画成什么:同一个 `taskPresentation`;`online` 是那台宿主此刻连得上。 */
export function sessionPresentation(
  session: SessionStatusFields & Pick<SessionpageSessionSummary, 'unseen'> & Partial<Pick<SessionpageSessionSummary, 'agent'>>,
  online: boolean,
  agentUserId = session.agent?.userId,
): AgentStatusPresentation | null {
  return taskPresentation({ agentUserId, reading: sessionReading(session), unseen: session.unseen === true, hostOnline: online })
}
