import type { AgentConversationActivity } from '@gugu/core/shared/types/chat'
import { normalizeAgentConversationStatus } from '@gugu/core/shared/ui/agentConversationStatusModels'

// **agent 创建生命周期**的广播 —— 唯一发射点是 agentCreationLifecycle(创建命令落终态)。
// 消费方两个:系统通知(「上线了 / 开始干活了」)与成员列表刷新。
// ❌ 它不参与状态显示:状态只从那张按 agentId 的表读(spec agent-status)。从前这条事件同时被
// 「发送即点亮」「流式反推点亮」「重试点亮」当作乐观运行态的写入口,那三个发射点已删。
export const AGENT_SESSION_STARTED_EVENT = '__agent_conversation_started'

export function emitAgentConversationStarted(detail: AgentConversationActivity): void {
  window.dispatchEvent(new CustomEvent(AGENT_SESSION_STARTED_EVENT, { detail }))
}

export function readAgentConversationStartedEvent(event: Event): AgentConversationActivity | null {
  const detail = (event as CustomEvent<Partial<AgentConversationActivity>>).detail
  if (!detail?.agentId || !detail.chatId) return null
  return {
    agentId: detail.agentId,
    chatId: detail.chatId,
    threadRootId: detail.threadRootId ?? null, // @@@1196-q5 thread-scoped running
    displayName: detail.displayName || 'Agent',
    avatar: detail.avatar ?? null,
    startedAt: detail.startedAt || new Date().toISOString(),
    status: normalizeAgentConversationStatus(detail.status),
  }
}
