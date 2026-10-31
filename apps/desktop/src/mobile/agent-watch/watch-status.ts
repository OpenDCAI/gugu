/**
 * 会话那一小格的**取值**(纯函数,不含组件)。
 *
 * 与 `StatusGlyph.tsx` 分开是有原因的:一个文件同时导出组件和普通函数会让 HMR 整页刷新
 * (react-refresh/only-export-components),而这几个函数在会话列表里是按行调用的热点。
 *
 * 画成什么(那一句、颜色、动不动)❌ 不在这里另定:与会话页、聊天同一个 `presentAgentStatus`
 * (packages/core/src/shared/agentStatusPresentation.ts,owner 2026-09-25 定表)。具名 Agent 的读数和可达均来自同一张 presence 表；无身份任务保留宿主任务读数。
 */
import {
  parseAgentStatus,
  parseAgentStatusView,
  type AgentStatusView,
} from '@gugu/core/shared/agentStatus'
import type { AgentStatusPresentation } from '@gugu/core/shared/agentStatusPresentation'
import { taskStatusPresentation } from '@/lib/taskAgentStatus'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { rendererLogger } from '@/lib/log'

const watchLog = rendererLogger('mobile/agent-watch')

type SessionStatusFields = Pick<SessionpageSessionSummary, 'conversationId' | 'status' | 'agentStatus'>

/**
 * 这条会话的读数:新宿主报 `status`(基础态 + 附属态),老宿主只报旧词 `agentStatus`(`needs_approval` 等,
 * 词表显式换算)。认不出的词是协议被破坏:记一条错误、这一格画成「状态不可用」—— ❌ 不猜成空闲,
 * 也 ❌ 不让一条坏行把整张列表拖垮。
 */
export function sessionReading(session: SessionStatusFields): AgentStatusView | null {
  try {
    if (session.status !== undefined) return parseAgentStatusView(session.status)
    const status = parseAgentStatus(session.agentStatus)
    return status === null ? null : { status, detail: null }
  } catch (error) {
    watchLog.error({ sessionId: session.conversationId, error: String(error) }, 'session status is not in the vocabulary')
    return null
  }
}

/** Identified agents use the same host reading/reachability as groups and avatars.
 * Only identity-free tasks use their directory's task-state domain. */
export function sessionPresentation(
  session: SessionStatusFields & Pick<SessionpageSessionSummary, 'unseen'> & Partial<Pick<SessionpageSessionSummary, 'agent'>>,
  online: boolean,
  agentUserId = session.agent?.userId,
): AgentStatusPresentation | null {
  return taskStatusPresentation(agentUserId
    ? { kind: 'agent', agentUserId }
    : { kind: 'task', reading: sessionReading(session), unseen: session.unseen === true, online })
}
