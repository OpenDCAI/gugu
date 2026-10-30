import { createOptimisticAgentChat } from '@gugu/core/shared/ui/chatModels'
import type { ChatItem, CreateAgentOnDeviceResult } from '@gugu/core/shared/types/chat'

// 建好一个 agent 后，先把它的私聊乐观地放进会话列表。
export function openCreatedAgentConversation(
  session: CreateAgentOnDeviceResult,
  deps: { upsertChat: (chat: ChatItem) => void },
): void {
  deps.upsertChat(createOptimisticAgentChat(session.chatId, session.agent.id))
}
