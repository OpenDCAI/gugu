import type { ChatItem } from '@gugu/core/shared/types/chat'
import { isOwnedAgentPeer, useOwnedAgentEntries } from '@/lib/ownedAgentConversation'
import { directoryRows, useDirectoryDevices, useLiveDeviceSessions } from '@/session/shared/remote-sessions/session-directory'

/** An owned agent's row previews its latest reply; only the DM's own unread counter lights the badge. */
export function useNativeAgentChats(chats: readonly ChatItem[]): ChatItem[] {
  const directory = useLiveDeviceSessions()
  const devices = useDirectoryDevices()
  useOwnedAgentEntries()
  return chats.map(chat => {
    if ((chat.kind !== 'dm' && chat.kind !== 'ai') || !isOwnedAgentPeer(chat.peer_user_id)) return chat
    const sessions = directoryRows(devices, directory).map(row => row.session).filter(session => session.agent?.userId === chat.peer_user_id)
    sessions.sort((a, b) => (b.lastInteractedAt ?? '').localeCompare(a.lastInteractedAt ?? ''))
    const last = sessions[0]?.nativeLastMessage
    const newer = last && Date.parse(last.at) > (chat.last_message_at ? Date.parse(chat.last_message_at) : 0)
    // Its machine away, only its heartbeat summary is here: no last message, but the task is still there — the row stays,
    // placed by when the task was last used (❌ dropped from the list: the task page would have no way in).
    const seen = sessions[0] && last === undefined && !chat.last_message_at ? sessions[0].lastInteractedAt : undefined
    return newer ? { ...chat, last_message_preview: last.text, last_message_at: last.at } : seen ? { ...chat, last_message_at: seen } : chat
  })
}
