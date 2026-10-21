import { createElement, useCallback, useMemo, useState, type ReactNode } from 'react'
import { ChatStoreProvider, useChatStore, type ChatContextValue, type SendMessageOptions } from './chatContext'
import { offLineChatValue } from './chatLine'

// #7199 一块聊天面只认自己那条会话 —— 为什么这样做、线怎么借怎么还,见同目录 chatLine.ts。

/** 这块面显示 `chatId` 那条:线就在它上面 = store 原样;不在 = offLineChatValue。 */
export function ChatLineScope({ chatId, children }: { chatId: string | null; children?: ReactNode }) {
  const store = useChatStore()
  // 线离开前自己那一帧。渲染期写(与 ChatStoreProvider 的 handle.value 同理):同一轮里往下渲染的就是这一份。
  const [memory] = useState<{ last: ChatContextValue | null }>(() => ({ last: null }))
  const onLine = store.activeChatId === chatId
  if (onLine) memory.last = store
  const { sendMessageToChat } = store
  const sendHere = useCallback(
    async (content: string, opts?: SendMessageOptions) => (chatId ? sendMessageToChat(chatId, content, opts) : undefined),
    [chatId, sendMessageToChat],
  )
  const value = useMemo(
    () => (onLine ? store : offLineChatValue(store, chatId, memory.last, sendHere)),
    [onLine, store, chatId, memory, sendHere],
  )
  return createElement(ChatStoreProvider, { value }, children)
}
