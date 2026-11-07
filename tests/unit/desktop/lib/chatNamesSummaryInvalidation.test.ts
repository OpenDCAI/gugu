// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { publishChatSummaries, publishContactSummaries, subscribeChatSummaries } from '@/lib/chatSummariesBridge'
import { createSessionChatContext } from '@renderer/lib/chat/shared-chat-context'

type Subscribe = (listener: () => void) => () => void
const captured = vi.hoisted(() => ({ subscribe: null as Subscribe | null }))
vi.mock('@gugu/session-chat-ui', () => ({
  DEFAULT_CONFIG: {},
  createChatContext: (options: { subscribeChatNames: Subscribe }) => {
    captured.subscribe = options.subscribeChatNames
    return {}
  },
}))
vi.mock('@renderer/features/extensions/installed-extensions-store', () => ({ installedExtensionsStore: {} }))
vi.mock('@renderer/lib/ipc', () => ({ rpc: {} }))
vi.mock('@renderer/lib/chat/advertised-command-provider', () => ({ advertisedCommandProvider: {} }))
vi.mock('@renderer/lib/chat/sender-avatar', () => ({ senderAvatarUrl: () => null, subscribeSenderAvatars: () => () => {} }))
vi.mock('@renderer/lib/chat/chat-mention-provider', () => ({ chatMentionProvider: {}, registerIssueMentionIcons: () => {} }))
vi.mock('@renderer/localization/locale-store', () => ({ getSessionLocaleSnapshot: () => ({ resolvedLocale: 'en-US' }), subscribeSessionLocale: () => () => {}, translateSessionMessage: () => '' }))
vi.mock('@renderer/lib/chat/chat-name', () => ({ chatDisplayName: () => null }))
vi.mock('@renderer/lib/chat/actor-identity', () => ({ chatActor: () => null }))

const group = () => ({ id: 'chat', name: 'Review', kind: 'group', public_id: 123, peer_user_id: null as string | null, unread_count: 0, last_message_at: 'now', last_message_preview: 'old' })
const disposals: (() => void)[] = []
beforeEach(() => {
  publishChatSummaries([group()])
  captured.subscribe = null
  createSessionChatContext()
  expect(captured.subscribe).toBeTypeOf('function')
})
afterEach(() => { for (const off of disposals.splice(0)) off() })

it('does not invalidate transcript names for 500 preview/unread updates or contact publication', () => {
  const names = vi.fn(); const summaries = vi.fn()
  disposals.push(captured.subscribe!(names), subscribeChatSummaries(summaries))
  for (let i = 1; i <= 500; i++) {
    publishChatSummaries([{ ...group(), unread_count: i, unread_locator: { message_id: `m${i}` }, is_marked_unread: i % 2 === 0, last_message_preview: `message ${i}` }])
  }
  console.info(JSON.stringify({ scenario: '500-message-summary-updates', summaries: summaries.mock.calls.length, nameInvalidations: names.mock.calls.length }))
  expect(summaries).toHaveBeenCalledTimes(500)
  expect(names).not.toHaveBeenCalled()
  publishContactSummaries([{ id: 'contact', name: 'Person' }])
  expect(summaries).toHaveBeenCalledTimes(501)
  expect(names).not.toHaveBeenCalled()
})

it.each([
  { name: 'Renamed' }, { alias: 'My alias' }, { public_id: 456 },
  { kind: 'dm' }, { peer_user_id: 'new-peer' },
])('keeps a single name notification when address/name fields change: %j', patch => {
  const names = vi.fn(); disposals.push(captured.subscribe!(names))
  publishChatSummaries([{ ...group(), ...patch }])
  expect(names).toHaveBeenCalledTimes(1)
  publishChatSummaries([{ ...group(), ...patch }])
  expect(names).toHaveBeenCalledTimes(1)
})

it('keeps additions, removals and account replacement visible, and removes the listener on disposal', () => {
  const names = vi.fn(); const off = captured.subscribe!(names); disposals.push(off)
  publishChatSummaries([group(), { ...group(), id: 'other' }])
  publishChatSummaries([group()])
  publishChatSummaries([{ ...group(), id: 'replacement' }])
  publishChatSummaries([])
  expect(names).toHaveBeenCalledTimes(4)
  off()
  publishChatSummaries([group()])
  expect(names).toHaveBeenCalledTimes(4)
})
