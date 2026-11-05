import type { ChatItem } from '@gugu/core/shared/types/chat'
import type { SessionDirectoryRow } from '@/session/shared/remote-sessions/session-directory'

export type NativeUnreadTarget = {
  deviceId: string | null
  conversationId: string
  itemIds: readonly string[]
  /** The native task and its personal DM count as one failed conversation. */
  chatId?: string
}

/** Read the existing account directory, keeping the exact identities present at the click. */
export function nativeUnreadTargets(rows: readonly SessionDirectoryRow[], chats: readonly ChatItem[], all: boolean, localDeviceId?: string): NativeUnreadTarget[] {
  const personal = new Map(chats.filter(chat => chat.kind === 'dm' || chat.kind === 'ai').map(chat => [chat.peer_user_id, chat.id]))
  return rows.flatMap(({ deviceId, session }) => {
    const chatId = session.agent?.userId ? personal.get(session.agent.userId) : undefined
    if ((!all && !chatId) || !session.nativeUnreadKeys?.length) return []
    return [{ deviceId: deviceId === localDeviceId ? null : deviceId, conversationId: session.conversationId,
      itemIds: [...session.nativeUnreadKeys], ...(chatId ? { chatId } : {}) }]
  })
}
