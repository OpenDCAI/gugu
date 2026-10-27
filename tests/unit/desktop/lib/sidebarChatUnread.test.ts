import { describe, expect, it } from 'vitest'
import { sidebarChatSignals } from '../../../../apps/desktop/src/lib/sidebarChatsBridge'
import type { AssistantShellSnapshot } from '../../../../apps/desktop/src/lib/assistantShellBridge'
import { chat } from '../../../support/testHarness'

const shell = {
  assistantState: 'found', assistant: { id: 'mine', display_name: 'Assistant', avatar: null, created_at: null }, chatId: 'assistant-dm',
} as AssistantShellSnapshot
const assistant = chat({ id: 'assistant-dm', kind: 'dm', peer_user_id: 'mine', unread_count: 1 })

describe('sidebar unread counts follow the visible conversation list', () => {
  it('does not show a phantom chat badge for the dedicated assistant DM', () => {
    expect(sidebarChatSignals([assistant], new Set(), shell).chatsUnread).toBe(0)
    expect(assistant.unread_count).toBe(1)
  })

  it('keeps ordinary chat and project-topic unread counts intact', () => {
    const rows = [assistant,
      chat({ id: 'ordinary', unread_count: 2 }),
      chat({ id: 'muted', unread_count: 20, is_muted: true }),
      chat({ id: 'project', kind: 'group', unread_count: 3 }),
      chat({ id: 'topic', kind: 'topic', source_chat_id: 'project', unread_count: 4 }),
    ]
    const signals = sidebarChatSignals(rows, new Set(['project']), shell)
    expect(signals.chatsUnread).toBe(2)
    expect(signals.groupUnread.get('project')).toBe(7)
    expect(signals.groupMainUnread.get('project')).toBe(3)
    expect(rows.map((row) => row.unread_count)).toEqual([1, 2, 20, 3, 4])
  })

  it('does not hide unread until the assistant and its canonical DM are actually known', () => {
    expect(sidebarChatSignals([assistant], new Set(), null).chatsUnread).toBe(1)
    expect(sidebarChatSignals([assistant], new Set(), { ...shell, assistantState: 'loading' }).chatsUnread).toBe(1)
    expect(sidebarChatSignals([assistant], new Set(), { ...shell, chatId: 'another-dm' }).chatsUnread).toBe(1)
  })
})
