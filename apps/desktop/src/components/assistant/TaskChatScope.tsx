import { useCallback, type ReactNode } from 'react'
import { useChatStore, type ChatContextValue } from '../../store/chatContext'
import { ChatLineScope } from '../../store/chatLineScope'
import { readSessionpageViewRequestBridge } from '../../lib/sessionpageViewRequestBridge'

/** A block supplies an address and presentation; the account owns its conversation. */
export function TaskChatScope({ chatId, children }: { chatId: string; children: ReactNode }) {
  const store = useChatStore()
  const storeSetActiveChatId = store.setActiveChatId
  const setActiveChatId = useCallback<ChatContextValue['setActiveChatId']>((next) => {
    const sessionPage = readSessionpageViewRequestBridge()
    if (next && sessionPage) sessionPage.openChat(next, false)
    else storeSetActiveChatId(next)
  }, [storeSetActiveChatId])
  return <ChatLineScope chatId={chatId} onNavigate={setActiveChatId}>{children}</ChatLineScope>
}
