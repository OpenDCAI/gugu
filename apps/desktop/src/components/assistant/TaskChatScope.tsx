import { useCallback, type ReactNode } from 'react'
import { ChatStoreProvider, useChatStore, type ChatContextValue } from '../../store/chatContext'
import { useChatConversation } from '../../store/useChatConversation'
import { readSessionpageViewRequestBridge } from '../../lib/sessionpageViewRequestBridge'

/** A block supplies an address and presentation; the account owns its conversation. */
export function TaskChatScope({ chatId, children }: { chatId: string; children: ReactNode }) {
  const store = useChatStore()
  const line = useChatConversation(chatId, store.conversations)
  const storeSetActiveChatId = store.setActiveChatId
  const setActiveChatId = useCallback<ChatContextValue['setActiveChatId']>((next) => {
    const sessionPage = readSessionpageViewRequestBridge()
    if (next && sessionPage) sessionPage.openChat(next, false)
    else storeSetActiveChatId(next)
  }, [storeSetActiveChatId])
  return <ChatStoreProvider value={{ ...store, ...line, setActiveChatId, activeChatId: chatId,
    activeChat: store.chats.find((chat) => chat.id === chatId) ?? null }}>{children}</ChatStoreProvider>
}
