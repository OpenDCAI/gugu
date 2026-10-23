import type { MessageItem } from '@gugu/core/shared/types/chat'
import { mergeMessagesById } from '@gugu/core/shared/ui/messageListModels'
import { chatService } from '../../apps/desktop/src/lib/chat'
import { openImRepository } from '../../apps/desktop/src/lib/imRepository'
import { createMemoryLocalSyncDb } from '../../apps/desktop/src/lib/localSyncDb'
import { applyMessageWindowRevalidation } from '../../apps/desktop/src/lib/chatMessageRevalidation'
import { ChatWindowCache, openCachedChatWindow, type ChatWindowAccess } from '../../apps/desktop/src/store/chatWindowPublication'

/** The real opening policy, with an isolated in-memory repository for scoped component tests. */
export function chatWindowStub(userId = 'user-1') {
  const cache = new ChatWindowCache()
  let repository: ReturnType<typeof openImRepository> | undefined
  const write = (chatId: string, updater: (rows: MessageItem[]) => MessageItem[]) => cache.set(chatId, updater(cache.get(chatId) ?? []))
  const access: ChatWindowAccess = {
    read: (chatId) => cache.get(chatId), write, persist: () => undefined,
    revalidate: async (chatId) => {
      const ids = (cache.get(chatId) ?? []).filter((row) => row.seq >= 0).map((row) => row.id)
      if (!ids.length) return
      const result = await chatService.revalidateWindow(ids, userId)
      write(chatId, (rows) => applyMessageWindowRevalidation(rows, new Set(ids), result))
    },
    open: (chatId, observer) => openCachedChatWindow({
      chatId, userId, cache,
      getRepository: () => repository ??= openImRepository(userId, { adapter: createMemoryLocalSyncDb() }),
      expectedTailSeq: null, hasPositiveUnread: false, observer,
      commit: (rows, replace) => write(chatId, (previous) => mergeMessagesById(replace ? previous.filter((row) => row.seq < 1) : previous, rows, chatId)),
      revalidate: () => access.revalidate(chatId),
    }),
    heal: async (chatId, _throw, readSeqs) => access.open(chatId, {
      current: () => true, painted: () => undefined, ready: () => undefined,
      readSeqs: (seqs) => readSeqs?.(seqs),
    }),
  }
  return { messageWindows: access, subscribeChatWindow: cache.subscribe }
}
