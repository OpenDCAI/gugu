import { useEffect, useRef } from 'react'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { useChatStore } from '@/store/chatContext'
import { useChatConversation } from '@/store/useChatConversation'
import { useConversationSessionSummary } from '@/hooks/useConversationSessionSummary'
import { isOwnedAgentPeer, useOwnedAgentEntries } from '@/lib/ownedAgentConversation'
import { publishNativeConversationReadState, useNativeConversationVisibility, type NativeConversationVisibility } from '@/lib/nativeConversationVisibility'
import { AgentDmReadCursor, visibleDmMessageIds } from './agent-dm-read'

/** Legacy IM receipts remain visible facts even after their entry opens the native task page. */
function ReadViewport({ chat, entry, readerKey }: { chat: ChatItem; entry: NativeConversationVisibility; readerKey: string }) {
  const { conversations } = useChatStore('conversations')
  const { messages, markMessageVisible } = useChatConversation(chat.id, conversations)
  const cursor = useRef(new AgentDmReadCursor(chat.unread_locator?.message_id ?? null, chat.last_read_seq, chat.unread_locator?.message_seq ?? undefined))
  useEffect(() => {
    if (document.visibilityState === 'hidden') return
    const current = cursor.current
    current.acknowledge(chat.last_read_seq)
    if (chat.unread_locator?.message_id && ![...entry.dmIds.values()].some(ids => ids.includes(chat.unread_locator!.message_id!))) current.ignore([chat.unread_locator.message_id])
    current.ignore(messages.filter(row => ![...entry.dmIds.values()].some(ids => ids.includes(row.id))).map(row => row.id))
    const ids = visibleDmMessageIds(entry.visible, entry.dmIds, messages)
    const pending = current.visible(ids, messages)
    publishNativeConversationReadState(readerKey, { chatId: chat.id, firstUnreadId: current.firstUnreadId, confirmedSeq: chat.last_read_seq,
      loaded: messages.map(message => message.id), visible: ids, pendingSeqs: pending.map(message => message.seq) })
    for (const message of pending) markMessageVisible(message)
  }, [chat, entry, messages, markMessageVisible, readerKey])
  useEffect(() => () => publishNativeConversationReadState(readerKey, null), [readerKey])
  return null
}
function ReadConversation({ entry, readerKey }: { entry: NativeConversationVisibility; readerKey: string }) {
  const session = useConversationSessionSummary(entry.sessionId)
  const { chats } = useChatStore('chats')
  useOwnedAgentEntries()
  const agentId = session?.agent?.userId
  const chat = agentId && isOwnedAgentPeer(agentId) ? chats.find(chat => chat.peer_user_id === agentId && (chat.kind === 'dm' || chat.kind === 'ai')) : null
  return chat ? <ReadViewport key={chat.id} chat={chat} entry={entry} readerKey={readerKey} /> : null
}
export function NativeConversationReadHost() {
  const entries = useNativeConversationVisibility()
  return [...entries].map(([key, entry]) => <ReadConversation key={key} readerKey={key} entry={entry} />)
}
