import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '@gugu/core/shared/types/chat'

const io = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>>(), failWrite: false }))
vi.mock('@/lib/supabase', () => ({ identityDb: { from: () => ({
  select: () => ({ eq: (_: string, userId: string) => ({ eq: (_: string, scope: string) => ({ maybeSingle: async () => ({ data: io.rows.get(`${userId}/${scope}`) ?? null, error: null }) }) }) }),
  upsert: (row: Record<string, unknown>) => ({ select: () => ({ single: async () => {
    if (io.failWrite) return { data: null, error: { message: 'write refused' } }
    io.rows.set(`${row.user_id}/${row.scope}`, structuredClone(row))
    return { data: row, error: null }
  } }) }),
}) } }))
vi.mock('@/lib/realtimeChannel', () => ({ subscribePrivateUserEventBus: vi.fn(), unsubscribePrivateUserEventBus: vi.fn() }))
vi.mock('@/platform', () => ({ platform: { subscribeAppForeground: () => () => {} } }))

const { readChatTopicPins, setChatTopicPin } = await import('@/lib/chatTopicPins')
const { topicPinGroups, topicUnreadTotal } = await import('@/components/chat/topicPinsModel')
function topic(id: string, activity: string, overrides: Partial<ChatItem> = {}): ChatItem {
  return { id, kind: 'topic', status: 'active', name: id, source_chat_id: 'g', created_at: activity,
    last_message_at: activity, last_message_preview: 'Latest message', unread_count: 0, pinned_message_id: null, last_read_seq: 0, next_message_seq: 1, ...overrides }
}
beforeEach(() => { io.rows.clear(); io.failWrite = false })

describe('personal topic preferences', () => {
  it('keeps account/group isolation and unrelated chat preferences while maintaining pin order', async () => {
    io.rows.set('u/chat:g', { scope: 'chat:g', config: { pinnedAppIds: ['board'], other: true }, updated_at: 'now' })
    expect(await readChatTopicPins('u', 'g')).toEqual([])
    await setChatTopicPin('u', 'g', 'second', true, ['first', 'second'])
    await setChatTopicPin('u', 'g', 'first', true, ['first', 'second'])
    await setChatTopicPin('u', 'g', 'second', true, ['first', 'second'])
    expect(await readChatTopicPins('u', 'g')).toEqual(['second', 'first'])
    expect(io.rows.get('u/chat:g')?.config).toEqual({ pinnedAppIds: ['board'], other: true, pinnedTopicIds: ['second', 'first'] })
    expect(await readChatTopicPins('other-user', 'g')).toEqual([])
    expect(await readChatTopicPins('u', 'other-group')).toEqual([])
  })

  it('removes unavailable pins on the next write and persists removing the final pin', async () => {
    io.rows.set('u/chat:g', { scope: 'chat:g', config: { pinnedTopicIds: ['deleted', 'live'] }, updated_at: 'now' })
    expect(await setChatTopicPin('u', 'g', 'live', false, ['live'])).toEqual([])
    expect(await readChatTopicPins('u', 'g')).toEqual([])
    await expect(setChatTopicPin('u', 'g', 'deleted', true, ['live'])).rejects.toThrow('no longer available')
  })

  it('reports corrupt preferences and rejected writes without acknowledging an unsaved pin', async () => {
    io.rows.set('u/chat:g', { scope: 'chat:g', config: { pinnedTopicIds: 'bad' }, updated_at: 'now' })
    await expect(readChatTopicPins('u', 'g')).rejects.toThrow('Invalid pinned topic')
    io.rows.clear(); io.failWrite = true
    await expect(setChatTopicPin('u', 'g', 'live', true, ['live'])).rejects.toThrow('write refused')
    expect(await readChatTopicPins('u', 'g')).toEqual([])
  })
})

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
