// ACP agent 流式输出的累积状态（#966 gate A，纯函数 reducer，便于单测）。
//
// agent 回合的 message_chunk 文本边到边拼进对应会话的"流式气泡"；thought_chunk 不进可见文本，
// 只翻 thinking 标记（v1）。回合 done/error 即清流式态——真实消息随后经 message_created 入库正常渲染。

import type { AgentStreamEvent } from '@gugu/core/shared/types/agentStream'

// @@@1687 一次累计的工具名上限：防一个疯狂调工具的回合把数组撑爆（计数仍照常加，只是名字列表截断尾部）。
const MAX_TOOL_NAMES = 60

// @@@1687 slice3a 真流静默阈值：超过这么久没收到任何流事件(tool_call/message/thought) → 判「似乎卡住了」。
export const STALL_MS = 25_000

export interface AgentStreamState {
  agentUserId: string
  /** 已累积的可见文本（message_chunk 顺序拼接）。 */
  text: string
  /** 最近一个 chunk 是否为思考（thought）——仅用于占位提示。 */
  thinking: boolean
  /** @@@1687 本回合至今的工具调用次数（done/error 清态即按回合归零）。 */
  toolCount: number
  /** @@@1687 本回合工具名（chronological，末尾为最新；上限 MAX_TOOL_NAMES）。供折叠态显最新 + 展开态拆解。 */
  toolNames: string[]
  /** @@@1696 本回合最后一次 tool_call 的 ACP semantic kind（驱动统一运行态流光动词）；null=无/已终态/该 tool_call 无 kind。 */
  latestKind: string | null
}

// @@@1196-q5 thread-scoped key：流式态按 (conversation, thread) 隔离。thread=null 退化为裸
// conversationId（向后兼容主会话键），thread 用 `<conv>:thread:<rootId>`（对齐 acpSessionKey 的 thread 维度）。
// 这样某 thread 跑 turn 的流落进 thread 槽,主视图/别的 thread 查各自的键 → 不再误亮（修 #957 的会话级外溢）。
export function agentStreamKey(conversationId: string, threadRootId: string | null | undefined): string {
  return threadRootId ? `${conversationId}:thread:${threadRootId}` : conversationId
}

/** key = agentStreamKey(conversationId, threadRootId)。一个 (会话,thread) 同一时刻只展示一个 agent 的流式气泡。 */
export type AgentStreamMap = Record<string, AgentStreamState>

export function reduceAgentStream(
  map: AgentStreamMap,
  conversationId: string,
  threadRootId: string | null,
  agentUserId: string,
  event: AgentStreamEvent,
): AgentStreamMap {
  const key = agentStreamKey(conversationId, threadRootId)
  const prev = map[key]
  // 同 (会话,thread) 换了 agent → 丢弃上一个 agent 的残留文本/计数。
  const sameAgent = !!prev && prev.agentUserId === agentUserId
  const carriedText = sameAgent ? prev!.text : ''
  const carriedToolCount = sameAgent ? prev!.toolCount : 0
  const carriedToolNames = sameAgent ? prev!.toolNames : []
  const carriedLatestKind = sameAgent ? prev!.latestKind : null

  switch (event.type) {
    case 'message_chunk':
      return { ...map, [key]: { agentUserId, text: carriedText + event.text, thinking: false, toolCount: carriedToolCount, toolNames: carriedToolNames, latestKind: carriedLatestKind } }
    case 'thought_chunk':
      return { ...map, [key]: { agentUserId, text: carriedText, thinking: true, toolCount: carriedToolCount, toolNames: carriedToolNames, latestKind: carriedLatestKind } }
    // @@@1687 工具调用 → 本回合计数 +1、记工具名（截尾 MAX_TOOL_NAMES）。不进可见文本。
    // @@@1696 同时记 ACP kind → latestKind（驱动流光动词；该 tool_call 无 kind 时置 null → 降级「运行中」）。
    case 'tool_call':
      return {
        ...map,
        [key]: {
          agentUserId,
          text: carriedText,
          thinking: false,
          toolCount: carriedToolCount + 1,
          toolNames: [...carriedToolNames, event.name].slice(-MAX_TOOL_NAMES),
          latestKind: event.kind ?? null,
        },
      }
    case 'done':
    case 'error': {
      if (!prev) return map
      const next = { ...map }
      delete next[key]
      return next
    }
    default:
      return map
  }
}
