import { ChatWindowCache } from '../../apps/desktop/src/store/chatWindowCache'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { ChatConversationAccess } from '../../apps/desktop/src/store/useChatConversation'

/** Presentation fixtures observe rows; account-pipeline tests mount the real ChatProvider. */
export function chatWindowStub(_userId = 'user-1') {
  const cache = new ChatWindowCache()
  const conversations: ChatConversationAccess = {
    read: (chatId, viewport) => cache.view(chatId, viewport), subscribe: (id, listener, viewport) => cache.subscribe(id, listener, undefined, viewport), setFollowingTail: cache.setFollowingTail, errorOf: () => null,
    actions: () => conversationActions,
  }
  return { conversations, write: (chatId: string, update: (rows: MessageItem[]) => MessageItem[]) => cache.update(chatId, update) }
}

const conversationActions = {
  sendAttachments: async () => undefined, sendMessage: async () => undefined, toggleReaction: async () => {}, refreshMessages: async () => {},
  loadOlderMessages: async () => {}, loadNewerMessages: async () => {}, loadMessageAnchor: async () => {},
  returnToLatestMessages: async () => {}, setFollowingTail: () => {}, markMessageVisible: () => {},
  clearMessages: async () => {}, removeMessage: () => {}, deleteMessage: async () => {}, appendMessage: () => {},
  openThread: () => {}, openUnreadChat: async () => {}, jumpToUnreadEntry: async () => {},
  unreadEntry: null, unreadNavigationPending: false,
}

/** Presentation fixtures supply a conversation without owning a read pipeline. */
export function topicHistoryStub(chatId = 'topic-1') {
  const window = new ChatWindowCache().history(chatId)
  return {
    ...conversationActions,
    messageWindow: window.getSnapshot(), setFollowingTail: (following: boolean | undefined) => { if (following !== undefined) window.setFollowingTail(following) },
    messages: [], memberReadSeqs: {}, hasMoreOlder: false, loadingOlder: false, loadingMessages: false,
    messagesError: null, activeThreadRootId: null, threadMessages: [], loadingThread: false,
    threadScope: { rootId: null, isOpen: false, messages: [], loading: false },
  }
}
