import { describe, expect, it } from 'vitest'
import type { ChatItem } from '@gugu/core/shared/types/chat'

import { topicPinGroups, topicUnreadTotal } from '@/components/chat/topicPinsModel'
function topic(id: string, activity: string, overrides: Partial<ChatItem> = {}): ChatItem {
  return { id, kind: 'topic', status: 'active', name: id, source_chat_id: 'g', created_at: activity,
    last_message_at: activity, last_message_preview: 'Latest message', unread_count: 0, pinned_message_id: null, last_read_seq: 0, next_message_seq: 1, ...overrides }
}
describe('topic menu projection', () => {
  it('uses pin order, then activity order without promoting unread or unavailable topics', () => {
    const chats = [topic('recent', '2026-10-29'), topic('old-unread', '2026-10-27', { unread_count: 10 }), topic('pinned-new', '2026-10-29'), topic('pinned-old', '2026-10-20'), topic('archived', '2026-10-29', { status: 'archived' }), topic('other-group', '2026-10-29', { source_chat_id: 'elsewhere' })]
    const grouped = topicPinGroups(chats, 'g', ['missing', 'pinned-old', 'pinned-new', 'archived'])
    expect(grouped.pinned.map((item) => item.id)).toEqual(['pinned-old', 'pinned-new'])
    expect(grouped.others.map((item) => item.id)).toEqual(['recent', 'old-unread'])
    expect(topicPinGroups(chats, null, ['pinned-old']).topics).toEqual([])
  })

  it('excludes muted topics from the total while retaining their unread row counts', () => {
    const muted = topic('muted', '2026-10-29', { unread_count: 120, is_muted: true })
    expect(topicUnreadTotal([muted, topic('live', '2026-10-29', { unread_count: 4 })])).toBe(4)
    expect(muted.unread_count).toBe(120)
  })
})
