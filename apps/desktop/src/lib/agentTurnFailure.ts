// #2115 普通 ACP 回合失败的失败条状态（纯函数 reducer + 人话文案映射，便于单测）。
//
// 载体 = spec(agent-reply) 规定的 {type:'error'} AgentStreamEvent：deliver 终态失败时主进程附 commandId
// 发出（spawn 失败/进程退出等进程级 error 不带 commandId → 不进失败条，维持既有行为）。
// 生命周期：error(带 commandId) 落条目 → 同 (chat,thread) 作用域一有新流事件（新 turn 跑起来/终态 done）
// 即清；「重试/关闭」由 UI 显式清。与 activity/presence 调和状态机完全解耦——
// 失败不是「运行态」的一种，是独立的会话内通知。

import type { AgentStreamPayload } from '@gugu/core/shared/types/agentStream'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { agentStreamKey } from './agentStreamState'
import { i18n } from '@/i18n'
import { displayAgentReferences } from './mentionMdast'
import { markdownPlainText } from './markdownPlainText'
import { turnFailurePresentation, turnFailureReasonFromError } from '@gugu/core/shared/turnFailurePresentation'

export interface AgentTurnFailure {
  agentUserId: string
  /** 失败的 agent.deliver 命令 id——「重试」按它 CAS error→pending 重排原命令。 */
  commandId: string
  /** 原始错误全文，仅用于归类与诊断；不放正文、悬浮提示或读屏标签。 */
  rawMessage: string
  /** 失败时刻（墙钟 ms），显示相对时间用。 */
  at: number
}

/** key = agentStreamKey(conversationId, threadRootId)，与流式态/运行态同一作用域刻度。 */
export type AgentTurnFailureMap = Record<string, AgentTurnFailure>

export { agentQuotaReason, type AgentQuotaReason } from '@gugu/core/shared/agentQuotaReason'
import { agentFailureNeedsModelChoice, agentFailureReason, type AgentFailureReason } from '@gugu/core/shared/agentQuotaReason'

/** A failure row's line in the viewer's language (the chat row, the quick chat, the chat-list preview, the notification). */
export function agentFailureText(reason: AgentFailureReason): string {
  return i18n.t(turnFailurePresentation(reason).bodyKey, { ns: 'messaging' })
}

/** The chat list's last-message line: a failure row says its reason, anything else its stored preview. */
export function chatPreviewText(chat: Pick<ChatItem, 'last_message_preview' | 'last_message_failure'>): string {
  return chat.last_message_failure ? agentFailureText(chat.last_message_failure)
    : markdownPlainText(displayAgentReferences(chat.last_message_preview ?? '', (_id, label) => `@${label}`))
}

export function agentTurnFailureNeedsModelChoice(raw: string | null | undefined): boolean {
  return agentFailureNeedsModelChoice(agentFailureReason(raw))
}

// 人话映射：内部错误（英文/术语/堆栈）一律不透传。文案是「回合」语义——回复没完成，不是「Agent 未能启动」。
export function agentTurnFailureUserMessage(raw: string | null | undefined): string {
  return i18n.t(turnFailurePresentation(turnFailureReasonFromError(raw)).bodyKey, { ns: 'messaging' })
}

// 纯 reducer：一条流事件如何改写失败条集合。
//  · error + commandId（deliver 终态失败）→ 落该作用域的失败条（同 key 覆盖：新失败换旧失败）。
//  · 同 key 的任何其他事件（message_chunk/thought_chunk/tool_call/done/不带 commandId 的 error）→ 清:
//    新 turn 已经跑起来或已终态，旧失败条过时（重试成功后也走这条边自然消失）。
export function reduceAgentTurnFailures(
  map: AgentTurnFailureMap,
  payload: AgentStreamPayload,
  now: number,
): AgentTurnFailureMap {
  const key = agentStreamKey(payload.conversationId, payload.threadRootId ?? null)
  const event = payload.event
  if (event.type === 'error' && typeof event.commandId === 'string' && event.commandId) {
    return {
      ...map,
      [key]: {
        agentUserId: payload.agentUserId,
        commandId: event.commandId,
        rawMessage: event.message,
        at: now,
      },
    }
  }
  if (!(key in map)) return map
  const next = { ...map }
  delete next[key]
  return next
}
