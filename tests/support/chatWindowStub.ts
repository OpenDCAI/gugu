import { ChatWindowCache } from '../../apps/desktop/src/store/chatWindowCache'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { mergeMessagesById } from '@gugu/core/shared/ui/messageListModels'
import type { ChatWindowAccess } from '../../apps/desktop/src/store/chatWindowPublication'
import type { openImRepository } from '../../apps/desktop/src/lib/imRepository'

/** The real opening policy, with an isolated in-memory repository for scoped component tests. */
export function chatWindowStub(userId = 'user-1') {
  const cache = new ChatWindowCache()
  const subscribeChatWindow = cache.subscribe
  let repository: ReturnType<typeof openImRepository> | undefined
  const write = (chatId: string, updater: (rows: MessageItem[]) => MessageItem[]) => {
    const rows = updater(cache.get(chatId) ?? [])
    cache.set(chatId, rows)
  }
  const access: ChatWindowAccess = {
    window: (chatId) => cache.history(chatId),
    load: async (chatId, direction) => {
      const { fetchChatHistoryPage } = await import('../../apps/desktop/src/store/chatWindowPublication')
      await cache.history(chatId).load(direction, fetchChatHistoryPage(userId))
      await access.revalidate(chatId)
    },
    anchor: async (chatId, messageId) => {
      const { restoreChatHistoryAnchor } = await import('../../apps/desktop/src/store/chatWindowPublication')
      await restoreChatHistoryAnchor(cache.history(chatId), userId, messageId)
      await access.revalidate(chatId)
    },
    read: (chatId) => cache.get(chatId), write, persist: () => undefined,
    revalidate: async (chatId) => {
      const [{ chatService }, { applyMessageWindowRevalidation }] = await Promise.all([
        import('../../apps/desktop/src/lib/chat'), import('../../apps/desktop/src/lib/chatMessageRevalidation'),
      ])
      const ids = (cache.get(chatId) ?? []).filter((row) => row.seq >= 0).map((row) => row.id)
      if (!ids.length) return
      const result = await chatService.revalidateWindow(ids, userId)
      write(chatId, (rows) => applyMessageWindowRevalidation(rows, new Set(ids), result))
    },
    open: async (chatId, observer) => {
      const [{ openCachedChatWindow }, { openImRepository }, { createMemoryLocalSyncDb }] = await Promise.all([
        import('../../apps/desktop/src/store/chatWindowPublication'), import('../../apps/desktop/src/lib/imRepository'), import('../../apps/desktop/src/lib/localSyncDb'),
      ])
      return openCachedChatWindow({
      chatId, userId, cache, history: cache.history(chatId),
      getRepository: () => repository ??= openImRepository(userId, { adapter: createMemoryLocalSyncDb() }),
      expectedTailSeq: null, hasPositiveUnread: false, observer,
      commit: (rows, replace) => write(chatId, (previous) => mergeMessagesById(replace ? previous.filter((row) => row.seq < 1) : previous, rows, chatId)),
      revalidate: () => access.revalidate(chatId),
      })
    },
    heal: async (chatId, _throw, readSeqs) => access.open(chatId, {
      current: () => true, painted: () => undefined, ready: () => undefined,
      readSeqs: (seqs) => readSeqs?.(seqs),
    }),
  }
  return { messageWindows: access, subscribeChatWindow }
}

/** History ports for pane tests that render supplied rows without opening an account. */
export function topicHistoryStub(chatId = 'topic-1') {
  const window = new ChatWindowCache().history(chatId)
  return {
    messageWindow: window.getSnapshot(), setFollowingTail: window.setFollowingTail,
    revealOlder: async () => {}, loadNewer: async () => {}, returnToLatest: async () => {}, loadMessageAnchor: async () => {},
  }
}
