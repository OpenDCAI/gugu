import { describe, expect, it } from 'vitest'
import { messageItemFromRow } from '@gugu/core/cloud/messageItem'
import { optimisticReplyFields } from '@gugu/core/shared/ui/messageListModels'
import {
  deriveMessageSendState, deriveReadReceipt, isReadByRecipients, isReadByRecipientsPrecise,
} from '@gugu/core/shared/ui/messageState'

const source = messageItemFromRow({
  id: 'source', chat_id: 'group', sender_user_id: 'alice', seq: 1, content: 'hello',
}, 'sender')!
const members = { alice: 0, bob: 0, carol: 0 }
const memberIds = Object.keys(members)

describe('reply and mention recipients share the read-receipt denominator', () => {
  it.each([
    { name: 'reply without mentions', reply: optimisticReplyFields([source], source.id), to: [], expected: ['alice'] },
    { name: 'reply and mention someone else', reply: optimisticReplyFields([source], source.id), to: ['bob'], expected: ['alice', 'bob'] },
    { name: 'reply and mention the same person', reply: optimisticReplyFields([source], source.id), to: ['alice', 'alice'], expected: ['alice'] },
    { name: 'reply to a whisper', reply: optimisticReplyFields([{ ...source, is_whisper: true }], source.id), to: [], expected: memberIds },
    { name: 'reply to a deleted message', reply: optimisticReplyFields([], source.id), to: [], expected: memberIds },
    { name: 'reply to a system message', reply: optimisticReplyFields([{ ...source, sender_user_id: null, content_type: 'system' }], source.id), to: [], expected: memberIds },
    { name: 'unresolved reply with a mention', reply: optimisticReplyFields([], source.id), to: ['bob'], expected: ['bob'] },
    { name: 'ordinary mention', reply: optimisticReplyFields([], null), to: ['bob'], expected: ['bob'] },
    { name: 'broadcast with null targets', reply: optimisticReplyFields([], null), to: null, expected: memberIds },
    { name: 'broadcast with empty targets', reply: optimisticReplyFields([], null), to: [], expected: memberIds },
    { name: 'broadcast sentinel overrides reply', reply: optimisticReplyFields([source], source.id), to: ['*'], expected: memberIds },
    { name: 'reply recipient has left', reply: optimisticReplyFields([{ ...source, sender_user_id: 'left' }], source.id), to: [], expected: [] },
    { name: 'reply to self excludes sender', reply: optimisticReplyFields([{ ...source, sender_user_id: 'sender' }], source.id), to: [], expected: [] },
  ])('$name', ({ reply, to, expected }) => {
    const message = { ...source, id: 'reply', sender_user_id: 'sender', seq: 10, delivered: true, ...reply, to_user_ids: to }
    expect(deriveReadReceipt(message, members)).toEqual({
      recipientIds: expected, totalRecipients: expected.length,
      readerIds: [], readCount: 0, unreadCount: expected.length,
    })

    // A partial recipient set must not turn the send state into read.
    for (const readIds of [expected.slice(0, -1), expected]) {
      const allRead = expected.length > 0 && readIds.length === expected.length
      const watermarks = Object.fromEntries(memberIds.map((id) => [id, readIds.includes(id) ? 10 : 0]))
      const messageReaders = { reply: new Set(readIds) }
      expect(isReadByRecipients(message, watermarks)).toBe(allRead)
      expect(isReadByRecipientsPrecise(message, memberIds, messageReaders)).toBe(allRead)
      expect(deriveMessageSendState(message, watermarks)).toBe(allRead ? 'read' : 'delivered')
      expect(deriveMessageSendState(message, members, { memberIds, messageReaders })).toBe(allRead ? 'read' : 'delivered')
      for (const receipt of [deriveReadReceipt(message, watermarks), deriveReadReceipt(message, members, { messageReaders })]) {
        expect(receipt.recipientIds).toEqual(expected)
        expect(receipt.readerIds).toEqual(readIds)
        expect(receipt.unreadCount).toBe(expected.length - readIds.length)
      }
    }
  })
})
