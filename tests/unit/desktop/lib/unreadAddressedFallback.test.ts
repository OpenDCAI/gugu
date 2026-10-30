// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { ChatItem, ChatUnreadLocator } from '@gugu/core/shared/types/chat'
import { unreadForYou } from '@gugu/core/shared/ui/chatModels'
import { shouldNotify } from '@gugu/core/shared/ui/notificationModels'
import { chatService } from '../../../../apps/desktop/src/lib/chat'
import { mergeUnreadRows } from '../../../../apps/desktop/src/lib/chatProjection'
import { phoneChatUnread } from '../../../../apps/desktop/src/mobile/chat/phoneChatUnread'
import { advanceReadWatermark } from '../../../../apps/desktop/src/store/chatRealtimeMutations'
import { chat } from '../../../support/testHarness'

const on = { enabled: true, onScreen: false }
const locator = (unread: number, addressed?: number): ChatUnreadLocator => ({
  stream_id: 'main:topic', stream_kind: 'main', thread_root_id: null, message_id: 'first', message_seq: 1,
  unread_count: unread, cursor_seq: 0, version: 1, is_marked_unread: false,
  ...(addressed === undefined ? {} : { addressed_count: addressed }),
})
const topic = (unread: number, addressed?: number, source = 'project'): ChatItem =>
  chat({ id: `topic-${source}`, kind: 'topic', source_chat_id: source, unread_count: unread, unread_locator: unread ? locator(unread, addressed) : null })
const row = (stream: string, unread: number, addressed?: number) => ({
  chat_id: 'topic', stream_id: stream, stream_kind: stream.startsWith('thread') ? 'thread' : 'main', thread_root_id: null,
  message_id: `m-${stream}`, message_seq: 1, unread_count: unread, cursor_seq: 0, version: 1, is_marked_unread: false,
  ...(addressed === undefined ? {} : { addressed_count: addressed }),
})

describe('a backend without addressed_count (older than gugu-supabase#73) falls back to the full unread', () => {
  it('the locator rows still merge, with the full count standing in for the addressed one', () => {
    const merged = mergeUnreadRows([row('main:topic', 4), row('thread:root', 2)]).get('topic')
    expect(merged).toMatchObject({ unread_count: 6, addressed_count: 6 })
  })

  it('the new column is summed across streams when it is there', () => {
    expect(mergeUnreadRows([row('main:topic', 4, 1), row('thread:root', 2, 1)]).get('topic')).toMatchObject({ unread_count: 6, addressed_count: 2 })
  })

  it('a topic without the count counts in full, so a message that names you is never counted away', () => {
    expect(unreadForYou(topic(5))).toBe(5)
    expect(unreadForYou(topic(5, 1))).toBe(1)
  })

  it('a row cached by an older client does not raise a false notification once the real count arrives', () => {
    expect(shouldNotify({ kind: 'chat', previous: topic(5), next: topic(5, 2) }, on)).toBe(false)
    expect(shouldNotify({ kind: 'chat', previous: topic(5), next: topic(6, 3) }, on)).toBe(false)
  })
})

describe('the phone folds a topic into its group row by what is addressed to you', () => {
  it('agent-to-agent topic traffic does not light the group row; a message to you does', () => {
    const group = chat({ id: 'project', kind: 'group', unread_count: 3 })
    expect(phoneChatUnread([group, topic(111, 0)]).get('project')).toBe(3)
    expect(phoneChatUnread([group, topic(111, 2)]).get('project')).toBe(5)
  })
})

describe('a failed mark-read puts the topic locator back', () => {
  it('so the project row does not drop the addressed count until the next refresh', async () => {
    let fail!: (error: Error) => void
    const spy = vi.spyOn(chatService, 'markRead').mockReturnValue(new Promise((_, reject) => { fail = reject }))
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const before = { ...topic(5, 2), last_read_seq: 0, next_message_seq: 6 }
    const patches: Array<Partial<ChatItem>> = []
    advanceReadWatermark([before], before.id, 5, (_id, partial) => { patches.push(partial) })
    expect(patches.at(-1)).toMatchObject({ unread_count: 0, unread_locator: null })
    fail(new Error('offline'))
    await Promise.resolve(); await Promise.resolve()
    expect(patches.at(-1)).toMatchObject({ unread_count: 5, unread_locator: before.unread_locator })
    spy.mockRestore(); quiet.mockRestore()
  })
})
