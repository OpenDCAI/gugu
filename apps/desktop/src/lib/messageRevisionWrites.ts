import { messageItemFromRow } from '@gugu/core/cloud/messageItem'
import type { ImMessageBatch, ImMessageWrite } from '../session/shared/core/im-messages'
import type { AccountRevisionOperation } from './accountRevisionRuntime'
import { readMemberRosterRevision, readMessageCreatedRevision, readRevisionResourceKey } from './accountRevisionCoordinator'
import { entityKey, membershipId, splitMembershipId, type ProjectionCache } from './chatProjectionAlgebra'
import { rendererLogger } from './log'

/** Parse server facts directly, before any IndexedDB delivery-queue or cursor commit. */
export function messageRevisionWrites(accountId: string, operations: readonly AccountRevisionOperation[], throughRevision: string): ImMessageBatch {
  return { writes: [], throughRevision, revisions: operations.map(operation => {
    const writes: ImMessageWrite[] = []
    if (operation.event === 'message_created') {
      const { chatId, messageId, message } = readMessageCreatedRevision(operation.payload)
      if (!message) {
        // Old payloads name no sequence. No interval can safely bridge this unknown arrival.
        writes.push({ type: 'truncateRange', chatId })
      } else {
        const row = message as typeof message & { deleted_at?: unknown; deleted_for_user_ids?: unknown; is_imported_history_root?: unknown }
        if (row.deleted_at || (Array.isArray(row.deleted_for_user_ids) && row.deleted_for_user_ids.includes(accountId))) {
          writes.push({ type: 'delete', chatId, id: messageId })
        } else if (row.is_imported_history_root !== true) {
          const item = messageItemFromRow(row, accountId)
          if (item) writes.push({ type: 'put', message: item })
          else {
            rendererLogger('chat/message-ingest').warn({ chatId, messageId }, 'Malformed message row invalidated local coverage')
            writes.push({ type: 'truncateRange', chatId })
          }
        }
      }
    } else if (operation.event === 'message_deleted') {
      const { chatId, entityId } = readRevisionResourceKey(operation.payload, 'message_deleted')
      if (!entityId) throw new Error('message_deleted revision requires entity_id')
      writes.push({ type: 'delete', chatId, id: entityId })
    } else if (operation.event === 'chat_members_changed') {
      const member = readMemberRosterRevision(operation.payload)
      if (member.memberId === accountId) writes.push({ type: 'chatAccess', access: {
        chatId: member.chatId, ownMember: !member.left, membershipRevoked: member.left,
      } })
    } else if (operation.event === 'chat_changed') {
      const { chatId } = readRevisionResourceKey(operation.payload, 'chat_changed')
      if ((operation.payload as { tombstone?: unknown }).tombstone === true) writes.push({ type: 'deleteChat', chatId })
    }
    return { revision: operation.revision, writes }
  }) }
}

/**
 * Access facts of the chats these keys name (a chat row, or my own membership row), read from authoritative cells,
 * including known null memberships; never infer access from list absence.
 */
export function messageAccessWrites(cells: ProjectionCache, accountId: string, keys: Iterable<string>): ImMessageWrite[] {
  const chatIds = new Set<string>()
  for (const key of keys) {
    if (key.startsWith('chat:')) chatIds.add(key.slice('chat:'.length))
    else if (key.startsWith('membership:')) {
      const { chatId, userId } = splitMembershipId(key.slice('membership:'.length))
      if (userId === accountId) chatIds.add(chatId)
    }
  }
  const writes: ImMessageWrite[] = []
  for (const chatId of chatIds) {
    const cell = cells.get(entityKey('chat', chatId))
    if (!cell?.value) continue
    const chat = cell.value as unknown as { id: string; source_chat_id?: string | null; status?: string }
    const member = cells.get(entityKey('membership', membershipId(chat.id, accountId)))
    writes.push({ type: 'chatAccess', access: { chatId: chat.id, sourceChatId: chat.source_chat_id ?? null,
      archived: chat.status === 'archived', revision: cell.stamp } })
    if (member) writes.push({ type: 'chatAccess', access: { chatId: chat.id,
      ownMember: member.value !== null, revision: member.stamp } })
  }
  return writes
}
