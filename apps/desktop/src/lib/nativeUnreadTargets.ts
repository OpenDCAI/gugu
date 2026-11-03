import type { ChatItem } from '@gugu/core/shared/types/chat'
import type { SessionDirectoryRow } from '@/session/shared/remote-sessions/session-directory'

export type NativeUnreadTarget = {
  deviceId: string
  conversationId: string
  itemIds: readonly string[]
  /** A native task and its personal DM count as one failed conversation. */
  chatId?: string
}

/** Capture the existing account directory, without fetching a second list or advancing beyond these identities. */
export function nativeUnreadTargets(rows: readonly SessionDirectoryRow[], chats: readonly ChatItem[], all: boolean): NativeUnreadTarget[] {
  const personalChats = new Map(chats.filter(chat => chat.kind === 'dm' || chat.kind === 'ai').map(chat => [chat.peer_user_id, chat.id]))
  return rows.flatMap(({ deviceId, session }) => {
    const chatId = session.agent?.userId ? personalChats.get(session.agent.userId) : undefined
    if ((!all && !chatId) || !session.nativeUnreadKeys?.length) return []
    return [{ deviceId, conversationId: session.conversationId, itemIds: [...session.nativeUnreadKeys], ...(chatId ? { chatId } : {}) }]
  })
}
