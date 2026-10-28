import { describe, expect, it } from 'vitest'
import { sidebarChatSignals } from '../../../../apps/desktop/src/lib/sidebarChatsBridge'
import type { AssistantShellSnapshot } from '../../../../apps/desktop/src/lib/assistantShellBridge'
import { chat } from '../../../support/testHarness'
import type { ChatItem } from '@gugu/core/shared/types/chat'

const shell = {
  assistantState: 'found', assistant: { id: 'mine', display_name: 'Assistant', avatar: null, created_at: null }, chatId: 'assistant-dm',
} as AssistantShellSnapshot
const assistant = chat({ id: 'assistant-dm', kind: 'dm', peer_user_id: 'mine', unread_count: 1 })
/** 话题未读 unread 条,其中叫到你的 addressed 条(服务端 list_unread_locators.addressed_count)。 */
const topic = (id: string, source: string, unread: number, addressed: number): ChatItem => chat({ id, kind: 'topic', source_chat_id: source, unread_count: unread,
  unread_locator: { stream_id: `main:${id}`, stream_kind: 'main', thread_root_id: null, message_id: `${id}-first`, message_seq: 1,
    unread_count: unread, addressed_count: addressed, cursor_seq: 0, version: 1, is_marked_unread: false } })

describe('sidebar unread counts follow the visible conversation list', () => {
  it('does not show a phantom chat badge for the dedicated assistant DM', () => {
    expect(sidebarChatSignals([assistant], new Set(), shell).chatsUnread).toBe(0)
    expect(assistant.unread_count).toBe(1)
  })

  it('keeps ordinary chat counts and counts a project topic only by what is addressed to you', () => {
    const rows = [assistant,
      chat({ id: 'ordinary', unread_count: 2 }),
      chat({ id: 'muted', unread_count: 20, is_muted: true }),
      chat({ id: 'project', kind: 'group', unread_count: 3 }),
      topic('topic', 'project', 4, 1),
    ]
    const signals = sidebarChatSignals(rows, new Set(['project']), shell)
    expect(signals.chatsUnread).toBe(2)
    expect(signals.groupUnread.get('project')).toBe(4)
    expect(rows.map((row) => row.unread_count)).toEqual([1, 2, 20, 3, 4])
  })

  it('agent-to-agent topics the owner was enrolled in do not keep the project row up after the group is read (owner 10-28)', () => {
    const topics = [topic('a', 'project', 83, 0), topic('b', 'project', 56, 0), topic('c', 'project', 17, 0), topic('d', 'project', 10, 0)]
    const unread = sidebarChatSignals([chat({ id: 'project', kind: 'group', unread_count: 3 }), ...topics], new Set(['project']), shell)
    expect(unread.groupUnread.get('project')).toBe(3)
    const read = sidebarChatSignals([chat({ id: 'project', kind: 'group', unread_count: 0 }), ...topics], new Set(['project']), shell)
    expect(read.groupUnread.has('project')).toBe(false)
    // 对照:话题里点名你的那条照样把项目行顶起来。
    const named = sidebarChatSignals([chat({ id: 'project', kind: 'group', unread_count: 0 }), topic('a', 'project', 84, 1)], new Set(['project']), shell)
    expect(named.groupUnread.get('project')).toBe(1)
  })

  it('does not hide unread until the assistant and its canonical DM are actually known', () => {
    expect(sidebarChatSignals([assistant], new Set(), null).chatsUnread).toBe(1)
    expect(sidebarChatSignals([assistant], new Set(), { ...shell, assistantState: 'loading' }).chatsUnread).toBe(1)
    expect(sidebarChatSignals([assistant], new Set(), { ...shell, chatId: 'another-dm' }).chatsUnread).toBe(1)
  })
})
