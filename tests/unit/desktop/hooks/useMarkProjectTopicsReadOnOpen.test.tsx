// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { sidebarChatSignals } from '../../../../apps/desktop/src/lib/sidebarChatsBridge'
import { topicsReadOnOpen, useMarkTopicsReadWhenShown } from '../../../../apps/desktop/src/hooks/useMarkProjectTopicsReadOnOpen'
import { chat, createReactHarness } from '../../../support/testHarness'

const GROUP = 'group-1'

function topic(id: string, unread: number, addressed: number, patch: Partial<ChatItem> = {}): ChatItem {
  return chat({
    id, kind: 'topic', source_chat_id: GROUP, unread_count: unread, next_message_seq: unread + 1,
    unread_locator: { stream_id: id, stream_kind: 'main', thread_root_id: null, message_id: `${id}-m1`, message_seq: 1,
      unread_count: unread, addressed_count: addressed, cursor_seq: 0, version: 1, is_marked_unread: false },
    ...patch,
  })
}

// The owner's case (#1057): the group's main stream is read; two topics opened from it still mention you (17 + 2).
const CHATS: ChatItem[] = [
  chat({ id: GROUP, kind: 'group', unread_count: 0 }),
  topic('topic-17', 30, 17),
  topic('topic-2', 2, 2),
  topic('topic-quiet', 5, 0),
  topic('topic-manual', 1, 1, { is_marked_unread: true }),
  topic('topic-other-group', 3, 3, { source_chat_id: 'group-2' }),
]

describe('topicsReadOnOpen', () => {
  it('picks the topics of this group that still mention you, and leaves a manual mark alone', () => {
    expect(topicsReadOnOpen(CHATS, GROUP).map((c) => c.id)).toEqual(['topic-17', 'topic-2'])
  })

  it('reading them leaves the project row with nothing but what you marked yourself', () => {
    const before = sidebarChatSignals(CHATS, new Set([GROUP])).groupUnread.get(GROUP)
    const cleared = new Set(topicsReadOnOpen(CHATS, GROUP).map((c) => c.id))
    const after = sidebarChatSignals(CHATS.map((c) => (cleared.has(c.id) ? { ...c, unread_count: 0, unread_locator: null } : c)), new Set([GROUP])).groupUnread.get(GROUP)
    expect(before).toBe(17 + 2 + 1)
    expect(after).toBe(1)
  })
})

let harness: ReturnType<typeof createReactHarness>
function Probe({ shown, chatsRead, markRead }: { shown: ReadonlySet<string>; chatsRead: boolean; markRead: (topics: ChatItem[]) => void }) {
  useMarkTopicsReadWhenShown(shown, CHATS, chatsRead, markRead)
  return null
}

describe('useMarkTopicsReadWhenShown', () => {
  beforeEach(() => { harness = createReactHarness() })
  afterEach(() => harness.cleanup())

  it('reads once per opening: not while hidden, once when shown, again only after it was closed', async () => {
    const markRead = vi.fn()
    const render = (shown: string[]) => harness.render(<Probe shown={new Set(shown)} chatsRead markRead={markRead} />)
    await render([])
    expect(markRead).not.toHaveBeenCalled()
    await render([GROUP])
    expect(markRead).toHaveBeenCalledTimes(1)
    expect(markRead.mock.calls[0][0].map((c: ChatItem) => c.id)).toEqual(['topic-17', 'topic-2'])
    await render([GROUP])
    expect(markRead).toHaveBeenCalledTimes(1)
    await render([])
    await render([GROUP])
    expect(markRead).toHaveBeenCalledTimes(2)
  })

  it('waits for the chat list before counting an opening', async () => {
    const markRead = vi.fn()
    await harness.render(<Probe shown={new Set([GROUP])} chatsRead={false} markRead={markRead} />)
    expect(markRead).not.toHaveBeenCalled()
    await harness.render(<Probe shown={new Set([GROUP])} chatsRead markRead={markRead} />)
    expect(markRead).toHaveBeenCalledTimes(1)
  })
})
