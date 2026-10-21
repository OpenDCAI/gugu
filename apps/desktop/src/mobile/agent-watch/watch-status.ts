/**
 * 会话那一小格的**取值**(纯函数,不含组件)。
 *
 * 与 `StatusGlyph.tsx` 分开是有原因的:一个文件同时导出组件和普通函数会让 HMR 整页刷新
 * (react-refresh/only-export-components),而这几个函数在会话列表里是按行调用的热点。
 *
 * 画成什么(那一句、颜色、动不动)❌ 不在这里另定:与会话页、聊天同一个 `presentAgentStatus`
 * (packages/core/src/shared/agentStatusPresentation.ts,owner 2026-09-25 定表)。手机只多一条自己的规矩:
 * 机器离线时不替它说「在跑」(`sessionPresentation` 的 `openable`)。
 */
import {
  parseAgentStatus,
  parseAgentStatusView,
  type AgentStatusView,
} from '@gugu/core/shared/agentStatus'
import { presentAgentStatus, type AgentStatusPresentation } from '@gugu/core/shared/agentStatusPresentation'
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

/**
 * 一行会话 / 时间线页头画成什么;画不得就返回 null(那一格退成灰点、状态词整个不出现)。
 *
 * 机器离线时(`openable === false`)这些是**上一次心跳带上来的快照**,分两类:
 *   · 「做完了」「等你…」「出错了」「空闲」熬得过关机 —— 机器开回来它还是那样,照写;
 *   · 「运行中」「后台运行中」**熬不过** —— 它们描述的是此刻,而此刻那台机器关着,没有任何东西在跑。
 *
 * 这时返回 null,让那一行只剩 harness 和时间。⚠️ ❌ 不许退成「空闲」:那是在替一台
 * 联系不上的机器打包票,和直接说「在跑」一样是编的,只是编得没那么显眼。
 */
export function sessionPresentation(
  session: SessionStatusFields & Pick<SessionpageSessionSummary, 'unseen'>,
  openable: boolean,
): AgentStatusPresentation | null {
  const presentation = presentAgentStatus({ reading: sessionReading(session), unseen: session.unseen === true })
  if (!openable && (presentation.tone === 'running' || presentation.tone === 'parked')) return null
  return presentation
}
