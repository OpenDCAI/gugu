import { emitAgentConversationStarted } from './agentConversationEvents'
import { STARTING_AGENT_RUNTIME_STATUS } from '@gugu/core/shared/ui/agentConversationStatusModels'
import { createOptimisticAgentChat } from '@gugu/core/shared/ui/chatModels'
import type { AgentConversationActivity, ChatItem, CreateAgentOnDeviceResult } from '@gugu/core/shared/types/chat'

// 建好一个 agent 后，先把它的私聊乐观地放进会话列表，再广播「开始启动」(系统通知与成员列表刷新订它)。
export function openCreatedAgentConversation(
  session: CreateAgentOnDeviceResult,
  deps: { upsertChat: (chat: ChatItem) => void },
): void {
  deps.upsertChat(createOptimisticAgentChat(session.chatId, session.agent.id))
  const activity: AgentConversationActivity = {
    agentId: session.agent.id,
    chatId: session.chatId,
    threadRootId: null, // @@@1196-q5 agent 创建的 greeting 永远落主会话(thread=null)
    displayName: session.agent.display_name,
    avatar: session.agent.avatar ?? null,
    startedAt: new Date().toISOString(),
    status: STARTING_AGENT_RUNTIME_STATUS,
  }
  emitAgentConversationStarted(activity)
}
