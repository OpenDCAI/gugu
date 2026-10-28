import { describe, expect, it } from 'vitest'
import { shouldNotifyForChat } from '@gugu/core/shared/ui/chatNotificationModels'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { chat } from '../../../support/testHarness'

const on = { activeChatId: null, notificationsEnabled: true }
/** 话题未读 unread 条,其中叫到你的 addressed 条(服务端 list_unread_locators.addressed_count)。 */
const topic = (unread: number, addressed: number): ChatItem => chat({ id: 'topic', kind: 'topic', source_chat_id: 'project', unread_count: unread,
  unread_locator: unread === 0 ? null : { stream_id: 'main:topic', stream_kind: 'main', thread_root_id: null, message_id: 'first', message_seq: 1,
    unread_count: unread, addressed_count: addressed, cursor_seq: 0, version: 1, is_marked_unread: false } })

describe('a topic notifies only for what is addressed to you (owner 10-28)', () => {
  it('a new agent-to-agent message in a topic the owner was enrolled in does not notify', () => {
    expect(shouldNotifyForChat(topic(0, 0), topic(1, 0), on)).toBe(false)
    expect(shouldNotifyForChat(topic(5, 0), topic(6, 0), on)).toBe(false)
  })

  it('a message that @-mentions the owner in that topic notifies', () => {
    expect(shouldNotifyForChat(topic(5, 0), topic(6, 1), on)).toBe(true)
    expect(shouldNotifyForChat(undefined, topic(1, 1), on)).toBe(true)
  })

  it('the project group itself still notifies on every new unread message', () => {
    const group = (unread: number) => chat({ id: 'project', kind: 'group', unread_count: unread })
    expect(shouldNotifyForChat(group(0), group(1), on)).toBe(true)
    expect(shouldNotifyForChat(group(1), group(1), on)).toBe(false)
  })
})
