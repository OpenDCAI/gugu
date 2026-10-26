import { describe, expect, test } from 'vitest'
import { resolveReplyDelivery, type ReplySource } from '../../packages/core/src/shared/replyDelivery'

const source: ReplySource = { sender_user_id: 'alice', to_user_ids: ['bob'], is_whisper: true }

describe('whisper reply delivery', () => {
  test.each([
    ['bob', 'alice'],
    ['alice', 'bob'],
  ])('keeps the original pair when %s replies', (senderUserId, peer) => {
    expect(resolveReplyDelivery({ senderUserId, source })).toEqual({ toUserIds: [peer], isWhisper: true })
  })
  test('mentions cannot accidentally broaden a private reply', () => {
    expect(resolveReplyDelivery({ senderUserId: 'bob', source, toUserIds: ['carol', '*'] }))
      .toEqual({ toUserIds: ['alice'], isWhisper: true })
  })
  test('only an explicit public choice removes inherited privacy', () => {
    expect(resolveReplyDelivery({ senderUserId: 'bob', source, whisper: false, toUserIds: ['carol'] }))
      .toEqual({ toUserIds: ['carol'], isWhisper: false })
  })
  test('preserves ordinary recipient and explicit whisper choices', () => {
    expect(resolveReplyDelivery({ toUserIds: ['carol'] })).toEqual({ toUserIds: ['carol'], isWhisper: false })
    expect(resolveReplyDelivery({ toUserIds: ['carol'], whisper: true })).toEqual({ toUserIds: ['carol'], isWhisper: true })
  })
  test.each([null, 'carol'])('refuses to guess a private peer for %s', (senderUserId) => {
    expect(resolveReplyDelivery({ senderUserId, source })).toBeNull()
  })
})
