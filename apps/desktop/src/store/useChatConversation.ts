import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { ChatContextValue } from './chatContext'
import { ChatHistoryWindow } from './chatHistoryWindow'
import type { ConversationSnapshot, ConversationViewport } from './chatWindowCache'
import { deriveThreadScope } from './threadScope'

type ConversationActions = Pick<ChatContextValue,
  'sendAttachments' | 'sendMessage' | 'toggleReaction' | 'refreshMessages' | 'loadOlderMessages' | 'loadNewerMessages' |
  'loadMessageAnchor' | 'returnToLatestMessages' | 'markMessageVisible' |
  'clearMessages' | 'removeMessage' | 'deleteMessage' | 'appendMessage' | 'openThread' |
  'openUnreadChat' | 'jumpToUnreadEntry' | 'unreadEntry' | 'unreadNavigationPending'>

export type ChatConversationAccess = {
  read: (chatId: string) => ConversationSnapshot
  subscribe: (chatId: string, listener: (rows: MessageItem[]) => void, viewport: ConversationViewport) => () => void
  setFollowingTail: (chatId: string, viewport: ConversationViewport, following: boolean | undefined) => void
  actions: (chatId: string | null) => ConversationActions
  errorOf: (chatId: string | null) => Error | null
}
const EMPTY: ConversationSnapshot = {
  messageWindow: new ChatHistoryWindow().getSnapshot(), loading: false, memberReadSeqs: {},
  activeThreadRootId: null, threadMessages: [], loadingThread: false,
}

/** Every surface observes the account's same conversation, including its read and navigation state. */
export function useChatConversation(chatId: string | null, access: ChatConversationAccess) {
  const { subscribe: observe, read: snapshot, actions: actionsOf, setFollowingTail: reportFollowing } = access
  const viewport = useMemo<ConversationViewport>(() => ({ following: undefined, chatId }), [chatId])
  const setFollowingTail = useCallback((following: boolean | undefined) => {
    if (chatId) reportFollowing(chatId, viewport, following)
  }, [reportFollowing, chatId, viewport])
  const subscribe = useCallback((listener: () => void) => chatId ? observe(chatId, listener, viewport) : () => undefined, [observe, chatId, viewport])
  const read = useCallback(() => chatId ? snapshot(chatId) : EMPTY, [snapshot, chatId])
  const state = useSyncExternalStore(subscribe, read)
  const actions = useMemo(() => actionsOf(chatId), [actionsOf, chatId])
  const { messageWindow, memberReadSeqs, activeThreadRootId, threadMessages, loadingThread } = state
  const { messages, hasOlder: hasMoreOlder } = messageWindow
  const threadScope = useMemo(() => deriveThreadScope({ rootId: activeThreadRootId, messages,
    threadMessages, loadingThread, loadingMessages: state.loading }), [activeThreadRootId, messages, threadMessages, loadingThread, state.loading])
  return { ...actions, setFollowingTail, messages, messageWindow, memberReadSeqs, hasMoreOlder,
    loadingOlder: messageWindow.loading === 'older', loadingMessages: state.loading,
    messagesError: access.errorOf(chatId), activeThreadRootId, threadMessages, loadingThread, threadScope }
}
export type ChatConversation = ReturnType<typeof useChatConversation>
