import { useConversationSessionSummary } from '@/hooks/useConversationSessionSummary'

/**
 * The conversation a session's tab is in (`AppWhere.conversation`): the person's private chat with that session's agent, as
 * the session's own row says it (`SessionpageSessionSummary.chatId`, from the roster of the machine it is on) — the chat an
 * App there is in (`getContext().chat`), on the desktop and the phone alike. Null for a session whose agent has no identity
 * yet (its private chat is made when it is provisioned).
 */
export function useTaskConversation(sessionId: string | null | undefined, deviceId?: string | null): string | null {
  return useConversationSessionSummary(sessionId ?? undefined, deviceId)?.chatId ?? null
}
