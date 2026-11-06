import { describe, expect, it } from 'vitest'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { chatAttention, mergeConversationVisibility, visibleConversationRows } from '@gugu/core/shared/ui/chatModels'
import { phoneChatUnread } from '../../../apps/desktop/src/mobile/chat/phoneChatUnread'
import { chat } from '../../support/testHarness'

const hiddenAt = '2026-11-06T17:00:00Z'
const topic = (id: string, source: string, unread: number, addressed: number) => chat({ id, kind: 'topic', source_chat_id: source, unread_count: unread,
  unread_locator: { stream_id: `main:${id}`, stream_kind: 'main', thread_root_id: null, message_id: `${id}-first`, message_seq: 1,
    unread_count: unread, addressed_count: addressed, cursor_seq: 0, version: 1, is_marked_unread: false } })

describe('phone personal conversation-list counts', () => {
  it('counts the source main stream once and only addressed topic messages, independent of search', () => {
    const rows = [chat({ id: 'source', kind: 'group', unread_count: 4 }), topic('work', 'source', 11, 2), topic('background', 'source', 83, 0)]
    expect([...phoneChatUnread(rows)]).toEqual([['source', 6]])
    expect(rows.map(row => row.unread_count)).toEqual([4, 11, 83])
  })
  it('excludes a separately hidden topic while preserving the visible source and its retained read cursor', () => {
    const source = chat({ id: 'source', kind: 'group', unread_count: 4, last_read_seq: 17 })
    const hidden = { ...topic('work', 'source', 11, 2), conversation_hidden_at: hiddenAt }
    expect(phoneChatUnread([source, hidden]).get('source')).toBe(4)
    expect(hidden.unread_locator?.addressed_count).toBe(2)
    expect(source.last_read_seq).toBe(17)
  })
  it('a hidden source suppresses descendant contributions without overwriting topic visibility or read state', () => {
    const rows = [chat({ id: 'source', kind: 'group', conversation_hidden_at: hiddenAt, unread_count: 4 }),
      topic('work', 'source', 11, 2), topic('nested', 'work', 7, 1), chat({ id: 'other', unread_count: 3 })]
    const before = structuredClone(rows)
    expect([...phoneChatUnread(rows)]).toEqual([['other', 3]])
    expect(rows).toEqual(before)
  })
  it('uses the authoritative source hide field when the source is not loaded; missing source/peer alone never hides', () => {
    const knownHidden = { ...topic('hidden', 'not-loaded', 9, 2), source_conversation_hidden_at: hiddenAt }
    const incomplete = topic('visible', 'not-loaded-either', 8, 3)
    const missingPeer = chat({ id: 'dm', peer_user_id: 'not-loaded-peer', unread_count: 4 })
    expect([...phoneChatUnread([knownHidden, incomplete, missingPeer])]).toEqual([['not-loaded-either', 3], ['dm', 4]])
  })
  it('a newer restoration restores retained counts, but cannot undo a topic separate hide or manufacture unread', () => {
    const source = chat({ id: 'source', kind: 'group', conversation_hidden_at: hiddenAt, conversation_visibility_revision: '9007199254740992', unread_count: 4 })
    const restored = mergeConversationVisibility({ ...source, conversation_hidden_at: null, conversation_visibility_revision: '9007199254740993' }, source)
    const hiddenTopic = { ...topic('hidden', 'source', 11, 2), conversation_hidden_at: hiddenAt }
    const readElsewhere = topic('read', 'source', 0, 0)
    expect(phoneChatUnread([restored, hiddenTopic, readElsewhere]).get('source')).toBe(4)
    expect(phoneChatUnread([source, hiddenTopic, readElsewhere]).has('source')).toBe(false)
    expect(readElsewhere.unread_count).toBe(0)
  })
  it('hidden native notification counts do not leak into visible totals; muted restoration keeps list count only', () => {
    // The native overlay adds explicit owner notifications to this DM's raw unread count.
    const hidden = chat({ id: 'native', unread_count: 7, conversation_hidden_at: hiddenAt, is_muted: true })
    expect(phoneChatUnread([hidden]).has('native')).toBe(false)
    expect(visibleConversationRows([hidden]).reduce((sum, row) => sum + chatAttention(row).askingYou, 0)).toBe(0)
    const restored: ChatItem = { ...hidden, conversation_hidden_at: null }
    expect(phoneChatUnread([restored]).get('native')).toBe(7)
    expect(chatAttention(restored).askingYou).toBe(0)
    expect(hidden.unread_count).toBe(7)
  })
})
