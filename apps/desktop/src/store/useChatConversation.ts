import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'
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
  subscribe: (chatId: string, listener: (rows: MessageItem[]) => void) => () => void
  actions: (chatId: string | null) => ConversationActions
  errorOf: (chatId: string | null) => Error | null
}
const EMPTY: ConversationSnapshot = {
  messageWindow: new ChatHistoryWindow().getSnapshot(), loading: false, memberReadSeqs: {},
  activeThreadRootId: null, threadMessages: [], loadingThread: false,
}

/** Every surface observes the account's same conversation, including its read and navigation state. */
export function useChatConversation(chatId: string | null, access: ChatConversationAccess) {
  const { subscribe: observe, read: snapshot, actions: actionsOf } = access
  const subscribe = useCallback((listener: () => void) => chatId ? observe(chatId, listener) : () => undefined, [observe, chatId])
  const read = useCallback(() => chatId ? snapshot(chatId) : EMPTY, [snapshot, chatId])
  const state = useSyncExternalStore(subscribe, read)
  const actions = useMemo(() => actionsOf(chatId), [actionsOf, chatId])
  const { messageWindow, memberReadSeqs, activeThreadRootId, threadMessages, loadingThread } = state
  const { messages, hasOlder: hasMoreOlder } = messageWindow
  const threadScope = useMemo(() => deriveThreadScope({ rootId: activeThreadRootId, messages,
    threadMessages, loadingThread, loadingMessages: state.loading }), [activeThreadRootId, messages, threadMessages, loadingThread, state.loading])
  return { ...actions, messages, messageWindow, memberReadSeqs, hasMoreOlder,
    loadingOlder: messageWindow.loading === 'older', loadingMessages: state.loading,
    messagesError: access.errorOf(chatId), activeThreadRootId, threadMessages, loadingThread, threadScope }
}
export type ChatConversation = ReturnType<typeof useChatConversation>
