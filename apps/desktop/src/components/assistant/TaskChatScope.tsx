import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAuth } from '../../store/auth'
import { ChatStoreProvider, useChatStore, type ChatContextValue } from '../../store/chatContext'
import { advanceReadWatermark } from '../../store/chatRealtimeMutations'
import { deriveThreadScope } from '../../store/threadScope'
import { useTopicLine } from '../../hooks/useTopicLine'
import { chatService } from '../../lib/chat'

/** A second live conversation; account, identity, drafts and outbox stay shared. */
export function TaskChatScope({ chatId, children }: { chatId: string; children: ReactNode }) {
  const store = useChatStore()
  const { user } = useAuth()
  const { subscribeAccountRevision, subscribeChatWindow, sendMessageToChat, patchChat } = store
  const line = useTopicLine(chatId, user?.id ?? null, subscribeAccountRevision)
  const { applyLocalWrite, appendOwn, reload, revalidate, revealOlder } = line
  const [loadingOlder, setLoadingOlder] = useState(false)
  const rowsRef = useRef(line.messages)
  rowsRef.current = line.messages
  useEffect(() => {
    let pending = new Set<string>()
    return subscribeChatWindow(chatId, (rows) => {
      const ids = new Set(rows.map((row) => row.id))
      applyLocalWrite(rows, new Set([...pending].filter((id) => !ids.has(id))))
      pending = new Set(rows.filter((row) => row.seq < 1).map((row) => row.id))
    })
  }, [chatId, subscribeChatWindow, applyLocalWrite])
  const sendMessage = useCallback<ChatContextValue['sendMessage']>((content, opts) => sendMessageToChat(chatId, content, opts), [chatId, sendMessageToChat])
  const removeMessage = useCallback((id: string) => applyLocalWrite([], new Set([id])), [applyLocalWrite])
  const toggleReaction = useCallback(async (id: string, emoji: string) => {
    if (!user) throw new Error('Not authenticated')
    await chatService.toggleReaction(id, user.id, emoji)
    await revalidate()
  }, [user, revalidate])
  const deleteMessage = useCallback(async (id: string) => {
    await chatService.deleteMessage(id)
    removeMessage(id)
  }, [removeMessage])
  const clearMessages = useCallback(async () => {
    await chatService.clearMessagesForMe(chatId)
    applyLocalWrite([], new Set(rowsRef.current.map((row) => row.id)))
  }, [chatId, applyLocalWrite])
  const loadOlderMessages = useCallback(async () => {
    setLoadingOlder(true)
    try { await revealOlder() } finally { setLoadingOlder(false) }
  }, [revealOlder])
  const loadMessageAnchor = useCallback(async (id: string) => {
    if (!user) throw new Error('Not authenticated')
    const anchor = await chatService.getMessageById(id, user.id)
    if (!anchor || anchor.chat_id !== chatId) throw new Error('Conversation message is unavailable')
    const [older, newer] = await Promise.all([
      chatService.getMessages(chatId, user.id, 'loadOlder', 20, anchor.seq + 1),
      chatService.getMessages(chatId, user.id, 'loadNewer', 20, undefined, anchor.seq),
    ])
    applyLocalWrite([...older, ...newer])
  }, [user, chatId, applyLocalWrite])
  const markMessageVisible = useCallback<ChatContextValue['markMessageVisible']>((message) => {
    if (message.chat_id === chatId && message.seq > 0 && !message.is_mine && !message.thread_root_id)
      advanceReadWatermark(store.chats, chatId, message.seq, patchChat)
  }, [chatId, store.chats, patchChat])
  const value = useMemo<ChatContextValue>(() => ({
    ...store,
    activeChatId: chatId,
    activeChat: store.chats.find((chat) => chat.id === chatId) ?? null,
    messages: line.messages, loadingMessages: line.loading,
    messagesError: line.error ? (line.error instanceof Error ? line.error : new Error(String(line.error))) : null,
    memberReadSeqs: line.memberReadSeqs, hasMoreOlder: !line.reachedOldest, loadingOlder,
    messageWindow: undefined, unreadNavigationPending: false, unreadEntry: null,
    activeThreadRootId: null, threadMessages: [], loadingThread: false,
    threadScope: deriveThreadScope({ rootId: null, messages: line.messages, threadMessages: [], loadingThread: false, loadingMessages: line.loading }),
    sendMessage, appendMessage: appendOwn, removeMessage, toggleReaction, deleteMessage, clearMessages,
    refreshMessages: reload, loadOlderMessages, markMessageVisible, loadMessageAnchor,
    loadNewerMessages: reload, returnToLatestMessages: reload, jumpToUnreadEntry: reload,
    // This line retains its loaded history, so it has no tail-window trimming to toggle.
    setFollowingTail: () => undefined,
  }), [store, chatId, line.messages, line.loading, line.error, line.memberReadSeqs, line.reachedOldest, loadingOlder, sendMessage, appendOwn, removeMessage, toggleReaction, deleteMessage, clearMessages, reload, loadOlderMessages, markMessageVisible, loadMessageAnchor])
  // 读失败由消息列表自己说(读不到 + 重试),❌ 在这里另起一行、底下仍是首次对话欢迎页。
  return <ChatStoreProvider value={value}>{children}</ChatStoreProvider>
}
