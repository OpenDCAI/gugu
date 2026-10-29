import type { ChatItem } from '@gugu/core/shared/types/chat'
import { isOwnedAgentPeer, useOwnedAgentEntries } from '@/lib/ownedAgentConversation'
import { directoryRows, useDirectoryDevices, useLiveDeviceSessions } from '@/session/shared/remote-sessions/session-directory'

/** Agent rows retain their own unread count; project rows keep their existing attention state. */
export function useNativeAgentChats(chats: readonly ChatItem[]): ChatItem[] {
  const directory = useLiveDeviceSessions()
  const devices = useDirectoryDevices()
  useOwnedAgentEntries()
  return chats.map(chat => {
    if ((chat.kind !== 'dm' && chat.kind !== 'ai') || !isOwnedAgentPeer(chat.peer_user_id)) return chat
    const sessions = directoryRows(devices, directory).map(row => row.session).filter(session => session.agent?.userId === chat.peer_user_id)
    sessions.sort((a, b) => (b.lastInteractedAt ?? '').localeCompare(a.lastInteractedAt ?? ''))
    const count = sessions[0]?.nativeUnreadKeys?.length ?? sessions[0]?.nativeUnreadCount ?? 0
    return count ? { ...chat, unread_count: chat.unread_count + count } : chat
  })
}
