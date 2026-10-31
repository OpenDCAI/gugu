// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { publishChatSummaries, subscribeChatNames } from '../../../../apps/desktop/src/lib/chatSummariesBridge'

const row = (id: string, name: string, preview: string, unread = 0) => ({ id, kind: 'group', name, unread_count: unread, last_message_preview: preview, last_message_at: '2026-10-31T00:00:00Z' })

afterEach(() => publishChatSummaries([]))

it('a new message (preview, unread) does not tell transcripts to re-lay-out their chat names; a rename does', () => {
  publishChatSummaries([row('g1', 'Team', 'hello')])
  const changed = vi.fn()
  const stop = subscribeChatNames(changed)
  publishChatSummaries([row('g1', 'Team', 'a newer message', 3)])
  expect(changed).not.toHaveBeenCalled()
  publishChatSummaries([row('g1', 'Team renamed', 'a newer message', 3)])
  expect(changed).toHaveBeenCalledTimes(1)
  publishChatSummaries([row('g1', 'Team renamed', 'a newer message', 3), row('g2', 'Second', 'hi')])
  expect(changed).toHaveBeenCalledTimes(2)
  stop()
})
