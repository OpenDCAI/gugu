// Global search (globalSearch.v3): what the chat store hands the local search index. The index is fed
// only by this account's own reads (chat.ts), the account revisions below and the authoritative chat list.
import { useEffect, useRef } from 'react'
import type { RawMessageRow } from '@gugu/core/cloud/messageItem'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { readMessageCreatedRevision, readRevisionResourceKey, type AccountRevisionEvent, type AccountRevisionListener } from '../lib/accountRevisionCoordinator'
import { chatService } from '../lib/chat'
import { startSearchBackfill } from '../lib/searchBackfill'
import { feedChats, feedRemoved, feedRows } from '../lib/searchIndexFeed'
import { useGlobalSearchV3 } from '../session/renderer/features/global-search/global-search-flag'
import { rpcOn } from '../session/renderer/lib/ipc'

type SubscribeAccountRevision = (events: AccountRevisionEvent | readonly AccountRevisionEvent[], listener: AccountRevisionListener) => () => void
type DeletableRow = RawMessageRow & { deleted_at?: unknown; deleted_for_user_ids?: unknown }

/** message_created carries the messages_view row; message_deleted names the id. Rejections are retried by the coordinator. */
export function searchIndexRevisionListener(userId: string): AccountRevisionListener {
  return async (operations) => {
    const rows: RawMessageRow[] = []
    const removed: string[] = []
    for (const operation of operations) {
      if (operation.event === 'message_deleted') {
        const { entityId } = readRevisionResourceKey(operation.payload, 'message_deleted')
        if (!entityId) throw new Error('message_deleted revision requires entity_id')
        removed.push(entityId)
        continue
      }
      const { messageId, message } = readMessageCreatedRevision(operation.payload)
      const row = message as DeletableRow | null
      const deletedForMe = Array.isArray(row?.deleted_for_user_ids) && row.deleted_for_user_ids.includes(userId)
      if (row && !row.deleted_at && !deletedForMe) rows.push(row)
      else removed.push(messageId)
    }
    await Promise.all([feedRows(rows), feedRemoved(removed)])
  }
}

export function useSearchIndexWiring(options: {
  userId: string | null
  chats: readonly ChatItem[]
  /** The list has been read from the server at least once for this account. */
  chatsRead: boolean
  activeChatId: string | null
  subscribeAccountRevision: SubscribeAccountRevision
}): void {
  const { userId, chats, chatsRead, activeChatId, subscribeAccountRevision } = options
  const enabled = useGlobalSearchV3()
  const live = useRef({ chats, activeChatId })
  live.current = { chats, activeChatId }

  // Always registered so these events never wait on a closed surface; with the flag off it consumes and drops.
  useEffect(() => userId
    ? subscribeAccountRevision(['message_created', 'message_deleted'], searchIndexRevisionListener(userId))
    : undefined, [userId, subscribeAccountRevision])

  useEffect(() => {
    if (!enabled || !userId || !chatsRead) return
    void feedChats(chats.map((chat) => ({ id: chat.id, kind: chat.kind, sourceChatId: chat.source_chat_id ?? null })))
      .catch((error) => console.error('[search-index] chat list apply failed', error))
  }, [enabled, userId, chatsRead, chats])

  useEffect(() => {
    if (!enabled || !userId || !chatsRead) return
    return startSearchBackfill({
      coverage: () => rpcOn(null).search.coverage(),
      mainPage: (chatId, beforeSeq, afterSeq) => chatService.getMessages(chatId, userId, 'searchBackfill', 100, beforeSeq, afterSeq),
      threadPage: (chatId, rootId, beforeSeq) => chatService.getThreadMessages(chatId, rootId, userId, 100, beforeSeq),
    }, {
      chats: () => live.current.chats,
      activeChatId: () => live.current.activeChatId,
      canRead: () => !document.hidden && navigator.onLine,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    })
  }, [enabled, userId, chatsRead])
}
