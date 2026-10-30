import { describe, expect, it } from 'vitest'
import { searchDocumentFromRow } from './document'

const row = {
  id: 'm1', chat_id: 'g', sender_user_id: 'peer', to_user_ids: ['me'], seq: 3, content: 'see https://example.com',
  content_type: 'text', created_at: '2026-10-29T12:00:00.123456+00:00', is_whisper: true, thread_root_id: null,
}

describe('searchDocumentFromRow', () => {
  it('maps a read row through the existing message mapper and keeps the raw row', () => {
    expect(searchDocumentFromRow(row, 'me')).toEqual({
      id: 'm1', chatId: 'g', threadRootId: null, seq: 3, senderId: 'peer', createdAt: row.created_at,
      text: 'see https://example.com', toUserIds: ['me'], isWhisper: true,
      hasFile: false, hasImage: false, hasLink: true,
    })
  })
  it('indexes an attachment by file name and caption', () => {
    const content = '[附件] plan.pdf (application/pdf)\n[Size] 10\n[Kind] file\n[Caption]\nrelease notes'
    expect(searchDocumentFromRow({ ...row, content, content_type: 'attachment', file_blob_id: 'b' }, 'me'))
      .toMatchObject({ text: 'plan.pdf\nrelease notes', hasFile: true, hasImage: false })
  })
  it.each([
    ['retracted', { retracted_at: '2026-10-29T12:01:00Z' }],
    ['system', { content_type: 'system' }],
    ['card', { content_type: 'card', content: '{"title":"x"}' }],
    ['empty', { content: '  ' }],
    ['unsequenced', { seq: null }],
    ['malformed', { chat_id: undefined }],
  ])('does not index a %s row', (_name, patch) => {
    expect(searchDocumentFromRow({ ...row, ...patch }, 'me')).toBeNull()
  })
})
