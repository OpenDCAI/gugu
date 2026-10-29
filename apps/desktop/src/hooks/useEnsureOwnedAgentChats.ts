import { useEffect, useRef } from 'react'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { createOptimisticDmChat } from '@gugu/core/shared/ui/chatModels'
import { readAssistantShellBridge } from '@/lib/assistantShellBridge'
import { chatService } from '@/lib/chat'
import { isOwnedAgent } from '@/lib/ownedAgentConversation'
import { rendererLogger } from '@/lib/log'

/** The owner's task agent has an entry before its first reply; a row is not another session or page. */
export function useEnsureOwnedAgentChats(input: {
  ownerId: string; contacts: readonly ContactUser[]; chats: readonly ChatItem[]; active: boolean
  upsertChat: (chat: ChatItem) => void; refreshChats: () => Promise<unknown>
}) {
  const current = useRef(input)
  current.current = input
  const pending = useRef(new Set<string>())
  useEffect(() => {
    if (!input.active) return
    const assistantId = readAssistantShellBridge()?.getSnapshot()?.assistant?.id
    const listed = new Set(input.chats.map(chat => chat.peer_user_id))
    for (const contact of input.contacts) {
      if (!isOwnedAgent(contact, input.ownerId) || contact.session_archived_at || contact.id === assistantId || listed.has(contact.id)) continue
      const key = `${input.ownerId}/${contact.id}`
      if (pending.current.has(key)) continue
      pending.current.add(key)
      void chatService.getOrCreateDM(input.ownerId, contact.id).then(async chatId => {
        if (current.current.ownerId !== input.ownerId || !current.current.active) return
        current.current.upsertChat(createOptimisticDmChat(chatId, contact.id))
        await current.current.refreshChats()
      }).catch(error => rendererLogger('chat/own-agent-entry').warn({ agentId: contact.id, error: String(error) }, 'Could not create owned agent conversation entry'))
        .finally(() => pending.current.delete(key))
    }
  }, [input.active, input.ownerId, input.chats, input.contacts])
}
