import { createElement, type ReactNode } from 'react'
import { ChatStoreProvider, useChatStore, type ChatContextValue } from './chatContext'
import { useChatConversation } from './useChatConversation'

/** Explicit chat addresses share their account pipeline; a nested matching scope needs no new owner. */
export function ChatLineScope({ chatId, children, onNavigate }: {
  chatId: string | null; children?: ReactNode; onNavigate?: ChatContextValue['setActiveChatId']
}) {
  const store = useChatStore()
  return store.activeChatId === chatId && !onNavigate ? children : createElement(ConversationScope, { chatId, onNavigate }, children)
}
function ConversationScope({ chatId, children, onNavigate }: {
  chatId: string | null; children?: ReactNode; onNavigate?: ChatContextValue['setActiveChatId']
}) {
  const store = useChatStore()
  const line = useChatConversation(chatId, store.conversations)
  return createElement(ChatStoreProvider, { value: { ...store, ...line, activeChatId: chatId,
    activeChat: store.chats.find((chat) => chat.id === chatId) ?? null,
    setActiveChatId: onNavigate ?? store.setActiveChatId } }, children)
}
