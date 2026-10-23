import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { ChatContextValue } from './chatContext'
import { ChatHistoryWindow } from './chatHistoryWindow'
import type { ConversationSnapshot } from './chatWindowCache'
import { deriveThreadScope } from './threadScope'

type ConversationActions = Pick<ChatContextValue,
  'sendMessage' | 'toggleReaction' | 'refreshMessages' | 'loadOlderMessages' | 'loadNewerMessages' |
  'loadMessageAnchor' | 'returnToLatestMessages' | 'setFollowingTail' | 'markMessageVisible' |
  'clearMessages' | 'removeMessage' | 'deleteMessage' | 'appendMessage' | 'openThread' |
  'openUnreadChat' | 'jumpToUnreadEntry' | 'unreadEntry' | 'unreadNavigationPending'>

export type ChatConversationAccess = {
  read: (chatId: string) => ConversationSnapshot
  subscribe: ChatContextValue['subscribeChatWindow']
  actions: (chatId: string | null) => ConversationActions
  errorOf: (chatId: string | null) => Error | null
}
const EMPTY: ConversationSnapshot = {
  messageWindow: new ChatHistoryWindow().getSnapshot(), loading: false, memberReadSeqs: {},
  activeThreadRootId: null, threadMessages: [], loadingThread: false,
}

/** Every surface observes the account's same conversation, including its read and navigation state. */
export function useChatConversation(chatId: string | null, access: ChatConversationAccess) {
  const subscribe = useCallback((listener: () => void) => chatId ? access.subscribe(chatId, listener) : () => undefined, [access.subscribe, chatId])
  const read = useCallback(() => chatId ? access.read(chatId) : EMPTY, [access.read, chatId])
  const state = useSyncExternalStore(subscribe, read)
  const actions = useMemo(() => access.actions(chatId), [access.actions, chatId])
  const { messageWindow, memberReadSeqs, activeThreadRootId, threadMessages, loadingThread } = state
  const { messages, hasOlder: hasMoreOlder } = messageWindow
  const threadScope = useMemo(() => deriveThreadScope({ rootId: activeThreadRootId, messages,
    threadMessages, loadingThread, loadingMessages: state.loading }), [activeThreadRootId, messages, threadMessages, loadingThread, state.loading])
  return { ...actions, messages, messageWindow, memberReadSeqs, hasMoreOlder,
    loadingOlder: messageWindow.loading === 'older', loadingMessages: state.loading,
    messagesError: access.errorOf(chatId), activeThreadRootId, threadMessages, loadingThread, threadScope }
}
export type ChatConversation = ReturnType<typeof useChatConversation>
