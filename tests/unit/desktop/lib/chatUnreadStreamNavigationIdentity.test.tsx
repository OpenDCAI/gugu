// @vitest-environment jsdom
import { act, useRef, useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { createReactHarness, chat } from '../../../support/testHarness'
import { useChatUnreadStreamNavigation } from '../../../../apps/desktop/src/lib/chatUnreadStreamNavigation'

let harness: ReturnType<typeof createReactHarness> | undefined
afterEach(() => harness?.cleanup())
const snapshotEpoch = () => 0 // the store's epoch reader is a stable callback

// Callers pass a fresh deps object each render. The navigation callbacks must keep their identity anyway,
// or every chat store render rebuilds conversation actions and re-renders each message row (Reply, draft saves).
it('keeps navigation callbacks stable across renders while calling the latest deps', async () => {
  const seen: ReturnType<typeof useChatUnreadStreamNavigation>[] = []
  const calls: string[] = []
  let rerender = () => {}
  function Host() {
    const [revision, setRevision] = useState(0)
    rerender = () => setRevision((value) => value + 1)
    const chatsRef = useRef([chat({ id: 'c1', unread_locator: null })])
    const activeChatIdRef = useRef<string | null>(null), cancelChatOpenRef = useRef(() => {})
    seen.push(useChatUnreadStreamNavigation({ user: { id: 'u1' }, chatsRef, activeChatIdRef, cancelChatOpenRef,
      getMessageSnapshotEpoch: snapshotEpoch, isChatOpen: () => true, threadRootOf: () => null,
      setActiveChatId: (id) => calls.push(`${id}@${revision}`), setActiveThreadRootId: () => {}, setLoadingThread: () => {},
      setThreadMessages: () => {}, loadChats: async () => {} }))
    return null
  }
  harness = createReactHarness()
  await harness.render(<Host />)
  await act(async () => rerender())
  const [first, last] = [seen[0], seen.at(-1)!]
  expect(seen.length).toBeGreaterThan(1)
  expect(last.openUnreadChat).toBe(first.openUnreadChat)
  expect(last.openStreamAtLocator).toBe(first.openStreamAtLocator)
  expect(last.entryFor).toBe(first.entryFor)
  expect(last.jumpToUnreadEntry).toBe(first.jumpToUnreadEntry)
  await act(async () => { await first.openUnreadChat('c1') })
  expect(calls).toEqual(['c1@1'])
})
