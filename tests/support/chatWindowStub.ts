import type { MessageItem } from '@gugu/core/shared/types/chat'
import { mergeMessagesById } from '@gugu/core/shared/ui/messageListModels'
import type { ChatWindowAccess } from '../../apps/desktop/src/store/chatWindowPublication'
import type { openImRepository } from '../../apps/desktop/src/lib/imRepository'

/** The real opening policy, with an isolated in-memory repository for scoped component tests. */
export function chatWindowStub(userId = 'user-1') {
  const cache = new Map<string, MessageItem[]>()
  const listeners = new Map<string, Set<(rows: MessageItem[]) => void>>()
  const subscribeChatWindow = (chatId: string, listener: (rows: MessageItem[]) => void) => {
    let bucket = listeners.get(chatId)
    if (!bucket) { bucket = new Set(); listeners.set(chatId, bucket) }
    bucket.add(listener)
    listener(cache.get(chatId) ?? [])
    return () => { bucket.delete(listener) }
  }
  let repository: ReturnType<typeof openImRepository> | undefined
  const write = (chatId: string, updater: (rows: MessageItem[]) => MessageItem[]) => {
    const rows = updater(cache.get(chatId) ?? [])
    cache.set(chatId, rows)
    for (const listener of listeners.get(chatId) ?? []) listener(rows)
  }
  const access: ChatWindowAccess = {
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
      chatId, userId, cache,
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
