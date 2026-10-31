import type { ChatItem } from '@gugu/core/shared/types/chat'
import { useChatStore } from '@/store/chatContext'
import { useConversationSessionSummary } from '@/hooks/useConversationSessionSummary'

/** The person's private chat with one of their agents, from the chat list: null when the list has none yet. */
export function agentDmOf(chats: readonly Pick<ChatItem, 'id' | 'kind' | 'peer_user_id'>[], agentId: string): string | null {
  return chats.find((chat) => chat.peer_user_id === agentId && (chat.kind === 'dm' || chat.kind === 'ai'))?.id ?? null
}

/**
 * The conversation a session's tab is in (`AppWhere.conversation`): the person's private chat with that session's agent —
 * the chat an App there is in (`getContext().chat`), on the desktop and the phone alike. Null for a session with no agent
 * yet, or whose chat the list has not brought.
 */
export function useTaskConversation(sessionId: string | null | undefined, deviceId?: string | null): string | null {
  const session = useConversationSessionSummary(sessionId ?? undefined, deviceId)
  const { chats } = useChatStore('chats')
  const agentId = session?.agent?.userId
  return agentId ? agentDmOf(chats, agentId) : null
}
