import { useChatSummaries } from '@/lib/chatSummariesBridge'
import { isOwnedAgentPeer, useOwnedAgentEntries } from '@/lib/ownedAgentConversation'
import { useConversationSessionSummary } from './useConversationSessionSummary'

/** Sidebar selection follows the visible task workspace, including its browser and App tabs. */
export function useNativeConversationChat(sessionId: string | undefined): string | null {
  const session = useConversationSessionSummary(sessionId)
  const chats = useChatSummaries()
  useOwnedAgentEntries()
  const agentId = session?.agent?.userId
  if (!isOwnedAgentPeer(agentId)) return null
  return [...chats].find(([, chat]) => (chat.kind === 'dm' || chat.kind === 'ai') && chat.peerUserId === agentId)?.[0] ?? null
}
