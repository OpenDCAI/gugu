import type { ImChatAccess, ImMessageWrite } from '@shared/core/im-messages'
import { decimal, dropMessages, dropRanges, requireId, type MessageSqlDatabase } from './message-row'

type AccessRow = { source_chat_id: string | null; own_member: number | null; membership_revoked: number; archived: number;
  membership_revision: string | null; chat_revision: string | null }

/** Permission facts decide which histories may stay on disk, including observer topics absent from the chat list. */
export function createChatAccess(connection: MessageSqlDatabase) {
  const departed = (accountId: string, chatId: string) => !!connection.prepare(`SELECT 1 FROM im_message_tombstones
    WHERE account_id=? AND chat_id=? AND message_id=''`).get(accountId, chatId)

  function removeChat(accountId: string, chatId: string): ImMessageWrite {
    connection.prepare(`INSERT INTO im_message_tombstones(account_id, chat_id, message_id)
      VALUES (?, ?, '') ON CONFLICT DO NOTHING`).run(accountId, chatId)
    dropMessages(connection, 'account_id = ? AND chat_id = ?', accountId, chatId)
    dropRanges(connection, accountId, chatId)
    return { type: 'deleteChat', chatId }
  }

  function applyAccess(accountId: string, access: ImChatAccess, revision?: string): ImMessageWrite[] {
    requireId(access.chatId)
    if (access.sourceChatId != null) requireId(access.sourceChatId)
    const stamp = access.revision ?? revision
    if (stamp !== undefined && !decimal.test(stamp)) throw new Error('Invalid message access revision')
    const old = connection.prepare('SELECT * FROM im_message_chats WHERE account_id=? AND chat_id=?')
      .get(accountId, access.chatId) as AccessRow | undefined
    const fresh = (previous: string | null | undefined) => stamp === undefined || previous == null || BigInt(stamp) >= BigInt(previous)
    const membership = (access.ownMember !== undefined || access.membershipRevoked !== undefined) && fresh(old?.membership_revision)
    const chat = (access.sourceChatId !== undefined || access.archived !== undefined) && fresh(old?.chat_revision)
    const source = !chat || access.sourceChatId === undefined ? old?.source_chat_id ?? null : access.sourceChatId
    const member = !membership || access.ownMember === undefined ? old?.own_member ?? null : Number(access.ownMember)
    const revoked = (membership && access.membershipRevoked) || (old?.own_member === 1 && member === 0)
      ? 1 : member === 1 ? 0 : old?.membership_revoked ?? 0
    const archived = !chat || access.archived === undefined ? old?.archived ?? 0 : Number(access.archived)
    connection.prepare(`INSERT INTO im_message_chats(account_id,chat_id,source_chat_id,own_member,membership_revoked,archived,membership_revision,chat_revision)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(account_id,chat_id) DO UPDATE SET
      source_chat_id=excluded.source_chat_id,own_member=excluded.own_member,
      membership_revoked=excluded.membership_revoked,archived=excluded.archived,
      membership_revision=excluded.membership_revision,chat_revision=excluded.chat_revision`)
      .run(accountId, access.chatId, source, member, revoked, archived,
        membership ? stamp ?? old?.membership_revision ?? null : old?.membership_revision ?? null,
        chat ? stamp ?? old?.chat_revision ?? null : old?.chat_revision ?? null)
    // Observer reads do not receive every revision. Joining starts a new coverage baseline.
    if (membership && member === 1 && old?.own_member !== 1) dropRanges(connection, accountId, access.chatId)
    const applied: ImMessageWrite[] = []
    if (archived || revoked || (member === 0 && source && departed(accountId, source))) {
      applied.push(removeChat(accountId, access.chatId))
    } else if (member === 1 || (member === 0 && source && !departed(accountId, source))) {
      connection.prepare(`DELETE FROM im_message_tombstones WHERE account_id=? AND chat_id=? AND message_id=''`)
        .run(accountId, access.chatId)
    }
    // A source membership revocation affects only locally known observer topics. Own topic memberships survive.
    if (revoked) {
      const children = connection.prepare(`SELECT chat_id FROM im_message_chats
        WHERE account_id=? AND source_chat_id=? AND own_member=0`).all(accountId, access.chatId) as { chat_id: string }[]
      for (const child of children) applied.push(removeChat(accountId, child.chat_id))
    }
    return applied
  }

  return applyAccess
}
