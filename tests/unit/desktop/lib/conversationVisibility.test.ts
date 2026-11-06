import { describe, expect, it } from 'vitest'
import { chatAttention, mergeConversationVisibility, mergeFetchedChatsPreservingActiveLocal, visibleConversationRows } from '@gugu/core/shared/ui/chatModels'
import { chat } from '../../../support/testHarness'
import { phoneChatUnread } from '../../../../apps/desktop/src/mobile/chat/phoneChatUnread'

const hiddenAt = '2026-11-06T17:00:00Z'
describe('personal conversation visibility', () => {
  it('preserves hidden addressable rows while filtering their source descendants from lists and phone totals', () => {
    const rows = [chat({ id: 'g', kind: 'group', conversation_hidden_at: hiddenAt, unread_count: 2 }),
      chat({ id: 't', kind: 'topic', source_chat_id: 'g', unread_count: 3 }),
      chat({ id: 'nested', kind: 'topic', source_chat_id: 't', unread_count: 4 }),
      chat({ id: 'other', kind: 'dm', unread_count: 5 })]
    expect(visibleConversationRows(rows).map((row) => row.id)).toEqual(['other'])
    expect([...phoneChatUnread(rows)]).toEqual([['other', 5]])
    expect(rows).toHaveLength(4)
    expect(rows[1].unread_count).toBe(3)
  })
  it('does not treat a missing source as a hide and excludes only the explicitly hidden topic', () => {
    const rows = [chat({ id: 'g', kind: 'group', unread_count: 2 }),
      chat({ id: 't', kind: 'topic', source_chat_id: 'g', conversation_hidden_at: hiddenAt, unread_count: 3 }),
      chat({ id: 'orphan', kind: 'topic', source_chat_id: 'absent', unread_count: 4 })]
    expect(visibleConversationRows(rows).map((row) => row.id)).toEqual(['g', 'orphan'])
    expect(phoneChatUnread(rows).get('g')).toBe(2)
  })
  it('keeps raw unread/read cursors while suppressing hidden attention, including muted rows', () => {
    const hidden = chat({ conversation_hidden_at: hiddenAt, unread_count: 5, last_read_seq: 7, is_muted: false })
    expect(chatAttention(hidden)).toEqual({ unread: 5, forYou: 0, askingYou: 0 })
    const restored = { ...hidden, conversation_hidden_at: null, is_muted: true }
    expect(chatAttention(restored)).toEqual({ unread: 5, forYou: 5, askingYou: 0 })
    expect(restored.last_read_seq).toBe(7)
  })
  it('compares revisions above 2^53 exactly and protects both hides and newer restorations', () => {
    const old = { conversation_hidden_at: hiddenAt, conversation_visibility_revision: '9007199254740992' }
    const restored = { conversation_hidden_at: null, conversation_visibility_revision: '9007199254740993' }
    expect(mergeConversationVisibility(old, restored)).toEqual(restored)
    expect(mergeConversationVisibility(restored, old)).toEqual(restored)
    const newerHide = { conversation_hidden_at: hiddenAt, conversation_visibility_revision: '9007199254740994' }
    expect(mergeConversationVisibility(restored, newerHide)).toEqual(newerHide)
  })
  it('merges own and source seats independently without changing fetched activity or read state', () => {
    const fetched = chat({ conversation_hidden_at: null, conversation_visibility_revision: '12', source_conversation_hidden_at: hiddenAt,
      source_conversation_visibility_revision: '8', unread_count: 2, last_read_seq: 11 })
    const local = chat({ conversation_hidden_at: hiddenAt, conversation_visibility_revision: '11', source_conversation_hidden_at: null,
      source_conversation_visibility_revision: '9', unread_count: 8, last_read_seq: 1 })
    const merged = mergeConversationVisibility(fetched, local)
    expect(merged.conversation_hidden_at).toBeNull()
    expect(merged.source_conversation_hidden_at).toBeNull()
    expect(merged.unread_count).toBe(2)
    expect(merged.last_read_seq).toBe(11)
    expect(mergeFetchedChatsPreservingActiveLocal([fetched], [local], null)[0].source_conversation_hidden_at).toBeNull()
  })
  it.each(['1e3', '0x10', '-1', '01', '', '1.5'])('rejects a noncanonical revision %s', (value) => {
    expect(() => mergeConversationVisibility({ conversation_visibility_revision: value })).toThrow('Invalid conversation visibility revision')
  })
  it('reports malformed source cycles instead of concealing missing rows', () => {
    expect(() => visibleConversationRows([chat({ id: 'a', kind: 'topic', source_chat_id: 'b' }),
      chat({ id: 'b', kind: 'topic', source_chat_id: 'a' })])).toThrow('Conversation source cycle')
  })
})
