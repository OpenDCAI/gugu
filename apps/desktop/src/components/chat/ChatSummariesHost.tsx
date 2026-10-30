import { useEffect } from 'react'
import { chatDisplayName } from '@gugu/core/shared/ui/chatModels'
import { useChatStore } from '@/store/chatContext'
import { useContactsStore } from '@/store/contactsContext'
import { useNativeAgentChats } from '@/hooks/useNativeAgentChats'
import { publishChatSummaries, publishContactSummaries } from '@/lib/chatSummariesBridge'

/** One account writer in both shells, even when no desktop chat slot exists. */
export function ChatSummariesHost() {
  const { chats: imChats, chatsRead, identitiesById } = useChatStore('chats', 'chatsRead', 'identitiesById')
  const chats = useNativeAgentChats(imChats)
  const { contacts } = useContactsStore()
  useEffect(() => {
    if (chatsRead) publishChatSummaries(chats.map(chat => ({ ...chat, name: chatDisplayName(chat, identitiesById[chat.peer_user_id ?? '']?.display_name) })))
  }, [chats, chatsRead, identitiesById])
  useEffect(() => () => { publishChatSummaries([]); publishContactSummaries([]) }, [])
  useEffect(() => { publishContactSummaries(contacts.map(contact => ({ id: contact.id, name: contact.alias || contact.display_name || contact.id }))) }, [contacts])
  return null
}
