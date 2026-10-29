import { useEffect, useRef } from 'react'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { useChatStore } from '@/store/chatContext'
import { useChatConversation } from '@/store/useChatConversation'
import { useLiveDeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { isOwnedAgentPeer } from '@/lib/ownedAgentConversation'
import { useNativeConversationVisibility, type NativeConversationVisibility } from '@/lib/nativeConversationVisibility'
import { AgentDmReadCursor, visibleDmMessageIds } from './agent-dm-read'

/** Legacy IM receipts remain visible facts even after their entry opens the native task page. */
function ReadViewport({ chat, entry }: { chat: ChatItem; entry: NativeConversationVisibility }) {
  const { conversations } = useChatStore('conversations')
  const { messages, markMessageVisible } = useChatConversation(chat.id, conversations)
  const cursor = useRef(new AgentDmReadCursor(chat.unread_locator?.message_id ?? null, chat.last_read_seq))
  useEffect(() => {
    const current = cursor.current
    current.acknowledge(chat.last_read_seq)
    if (chat.unread_locator?.message_id && ![...entry.aliases.values()].some(ids => ids.includes(chat.unread_locator!.message_id!))) current.ignore([chat.unread_locator.message_id])
    current.ignore(messages.filter(row => ![...entry.aliases.values()].some(ids => ids.includes(row.id))).map(row => row.id))
    const ids = visibleDmMessageIds(entry.visible, entry.aliases, messages)
    for (const message of current.visible(ids, messages)) markMessageVisible(message)
  }, [chat, entry, messages, markMessageVisible])
  return null
}
export function NativeConversationReadHost() {
  const entries = useNativeConversationVisibility()
  const directory = useLiveDeviceSessions()
  const { chats } = useChatStore('chats')
  return [...entries].map(([key, entry]) => {
    const agentId = Object.values(directory).flatMap(value => value.sessions).find(session => session.conversationId === entry.sessionId)?.agent?.userId
    const chat = agentId && isOwnedAgentPeer(agentId) ? chats.find(chat => chat.peer_user_id === agentId && (chat.kind === 'dm' || chat.kind === 'ai')) : null
    return chat ? <ReadViewport key={`${key}/${chat.id}`} chat={chat} entry={entry} /> : null
  })
}
