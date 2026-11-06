import { describe, expect, it } from 'vitest'
import { chatsInReadScope, conversationCanDelete, conversationRowMenu, hasUnreadInRows } from '../../../../apps/desktop/src/session/shared/conversation-row-menu'

describe('conversation row actions', () => {
  it('limits owned agent DM deletion to archived or removed identities', () => {
    expect(conversationCanDelete('dm', null, { session_archived_at: null, removed_at: null })).toBe(false)
    expect(conversationCanDelete('dm', null, {})).toBe(false)
    expect(conversationCanDelete('dm', null, { session_archived_at: '2026-11-06T10:00:00Z' })).toBe(true)
    expect(conversationCanDelete('dm', null, { removed_at: '2026-11-06T10:00:00Z' })).toBe(true)
  })
  it('keeps distinct server authority for groups and topics', () => {
    expect(conversationCanDelete('dm', { can_dissolve: true })).toBe(false)
    expect(conversationCanDelete('ai', { can_dissolve: true }, { removed_at: '2026-11-06T10:00:00Z' })).toBe(false)
    expect(conversationCanDelete('group', null)).toBe(false)
    expect(conversationCanDelete('group', { can_archive_topic: true })).toBe(false)
    expect(conversationCanDelete('group', { can_dissolve: true })).toBe(true)
    expect(conversationCanDelete('topic', { can_dissolve: true })).toBe(false)
    expect(conversationCanDelete('topic', { can_archive_topic: true })).toBe(true)
  })
  it('puts the same scoped read action first, followed only by the row type’s own actions', () => {
    const chat = conversationRowMenu({ kind: 'chat', canDelete: true, hasUnread: true, hasAnyUnread: true })
    const project = conversationRowMenu({ kind: 'project', hasUnread: true })
    expect(chat[0]).toEqual(project[0])
    expect(chat.map((item) => item.id)).toEqual(['mark-read', 'pin', 'notifications', 'mark-all-read', 'delete-chat'])
    expect(project.map((item) => item.id)).toEqual(['mark-read', 'remove-project'])
    const topic = conversationRowMenu({ kind: 'topic', hasUnread: false, hasAnyUnread: true })
    expect(topic.map((item) => [item.id, item.disabled])).toEqual([['mark-read', true], ['mark-all-read', false]])
  })

  it('keeps personal actions when the server denies topic management', () => {
    const items = conversationRowMenu({ kind: 'chat', canDelete: false, hasUnread: true, hasAnyUnread: true })
    expect(items.map((item) => item.id)).toEqual(['mark-read', 'pin', 'notifications', 'mark-all-read'])
  })

  it('keeps scoped availability independent from unread conversations elsewhere', () => {
    const menu = conversationRowMenu({ kind: 'chat', canDelete: true, hasUnread: false, hasAnyUnread: true, pinned: true, notificationsMuted: true })
    expect(menu.find((item) => item.id === 'mark-read')?.disabled).toBe(true)
    expect(menu.find((item) => item.id === 'mark-all-read')?.disabled).toBe(false)
    expect(menu.find((item) => item.id === 'pin')?.label).toBe('unpin')
    expect(menu.find((item) => item.id === 'notifications')?.label).toBe('enableNotifications')
  })
})

describe('the selected conversation and its topics', () => {
  const rows = [
    { id: 'nested', kind: 'topic', source_chat_id: 'topic', unread_count: 2 },
    { id: 'outside-topic', kind: 'topic', source_chat_id: 'outside', unread_count: 4 },
    { id: 'root', kind: 'group', unread_count: 0 },
    { id: 'topic', kind: 'topic', source_chat_id: 'root', unread_count: 3 },
    { id: 'outside', kind: 'dm', unread_count: 1 },
  ]
  it('includes unread topic descendants even when the selected main line is already read', () => {
    const scope = chatsInReadScope(rows, 'root')
    expect(scope.map((row) => row.id)).toEqual(['nested', 'root', 'topic'])
    expect(hasUnreadInRows(scope)).toBe(true)
    expect(chatsInReadScope(rows, 'outside').map((row) => row.id)).toEqual(['outside-topic', 'outside'])
  })
  it('does not mark a topic’s parent or siblings, and includes a durable manual unread mark', () => {
    expect(chatsInReadScope(rows, 'topic').map((row) => row.id)).toEqual(['nested', 'topic'])
    expect(chatsInReadScope(rows, ['topic', 'outside-topic']).map((row) => row.id)).toEqual(['nested', 'outside-topic', 'topic'])
    expect(hasUnreadInRows([{ unread_count: 0, is_marked_unread: true }])).toBe(true)
  })
})
