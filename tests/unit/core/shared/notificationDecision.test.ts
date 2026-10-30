import { describe, expect, it } from 'vitest'
import type { AgentStatusView } from '@gugu/core/shared/agentStatus'
import { shouldNotify } from '@gugu/core/shared/ui/notificationModels'
import type { ChatItem, ChatKind } from '@gugu/core/shared/types/chat'
import { chat } from '../../../support/testHarness'

const on = { enabled: true, onScreen: false }
/** unread 条未读,其中叫到你的 addressed 条(服务端 list_unread_locators.addressed_count)。 */
const row = (kind: ChatKind, unread: number, addressed: number, extra: Partial<ChatItem> = {}): ChatItem => chat({ id: kind, kind, unread_count: unread,
  unread_locator: unread === 0 ? null : { stream_id: `main:${kind}`, stream_kind: 'main', thread_root_id: null, message_id: 'first', message_seq: 1,
    unread_count: unread, addressed_count: addressed, cursor_seq: 0, version: 1, is_marked_unread: false }, ...extra })
const chatChange = (previous: ChatItem | undefined, next: ChatItem) => ({ kind: 'chat' as const, previous, next })
const agentChange = (previous: AgentStatusView | null, next: AgentStatusView | null) => ({ kind: 'agent' as const, previous, next })
const working: AgentStatusView = { status: 'working', detail: 'running' }

describe('only someone needing your reply raises a notification (owner 10-30)', () => {
  it('a new direct message notifies, addressed or not', () => {
    expect(shouldNotify(chatChange(row('dm', 0, 0), row('dm', 1, 0)), on)).toBe(true)
    expect(shouldNotify(chatChange(row('ai', 2, 0), row('ai', 3, 0)), on)).toBe(true)
  })

  it('a group or topic message notifies only when it is addressed to you', () => {
    expect(shouldNotify(chatChange(row('group', 4, 0), row('group', 5, 1)), on)).toBe(true)
    expect(shouldNotify(chatChange(undefined, row('topic', 1, 1)), on)).toBe(true)
    expect(shouldNotify(chatChange(row('group', 0, 0), row('group', 1, 0)), on)).toBe(false)
    expect(shouldNotify(chatChange(row('topic', 5, 0), row('topic', 6, 0)), on)).toBe(false)
  })

  it('an agent stopping to ask for approval or an answer notifies; a new ask on the same wait does too', () => {
    expect(shouldNotify(agentChange(working, { status: 'needs_user', detail: 'approval' }), on)).toBe(true)
    expect(shouldNotify(agentChange(working, { status: 'needs_user', detail: 'question' }), on)).toBe(true)
    expect(shouldNotify(agentChange({ status: 'needs_user', detail: 'approval' }, { status: 'needs_user', detail: 'question' }), on)).toBe(true)
    expect(shouldNotify(agentChange({ status: 'needs_user', detail: 'approval' }, { status: 'needs_user', detail: 'approval' }), on)).toBe(false)
  })

  it('an agent finishing, erroring or starting work is a state change, not a notification', () => {
    expect(shouldNotify(agentChange(working, { status: 'idle', detail: 'done' }), on)).toBe(false)
    expect(shouldNotify(agentChange(working, { status: 'error', detail: null }), on)).toBe(false)
    expect(shouldNotify(agentChange({ status: 'idle', detail: 'plain' }, working), on)).toBe(false)
    expect(shouldNotify(agentChange(working, null), on)).toBe(false)
  })

  it('stays quiet when switched off, on screen, or muted', () => {
    const ask = agentChange(working, { status: 'needs_user', detail: 'approval' })
    expect(shouldNotify(ask, { enabled: false, onScreen: false })).toBe(false)
    expect(shouldNotify(ask, { enabled: true, onScreen: true })).toBe(false)
    expect(shouldNotify(chatChange(row('dm', 0, 0), row('dm', 1, 0, { is_muted: true })), on)).toBe(false)
  })
})
