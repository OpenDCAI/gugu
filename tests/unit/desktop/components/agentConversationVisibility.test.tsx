// @vitest-environment jsdom
import { createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ChatContext, ChatState } from '@gugu/session-chat-ui'
import { createReactHarness } from '../../../support/testHarness'
vi.mock('../../../../apps/desktop/src/session/renderer/lib/chat/chat-transcript', () => ({
  ChatTranscript: () => createElement('div', { 'data-agent-conversation-message': 'visible-message' }),
}))
import { AgentConversationView } from '../../../../apps/desktop/src/session/renderer/lib/chat/agent-conversation-view'
let harness: ReturnType<typeof createReactHarness>
let observers: { callback: IntersectionObserverCallback; observe: ReturnType<typeof vi.fn> }[]
beforeEach(() => {
  harness = createReactHarness(); observers = []
  vi.stubGlobal('IntersectionObserver', class {
    observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn()
    constructor(callback: IntersectionObserverCallback) { observers.push({ callback, observe: this.observe }) }
  })
})
afterEach(() => { harness.cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('advances read only for actually visible messages and ignores callbacks after hiding the pane', async () => {
  const onVisibleItems = vi.fn()
  const render = (shown: boolean) => harness.render(createElement(AgentConversationView, { shown, onVisibleItems, context: {} as ChatContext, state: {} as ChatState }))
  await render(false)
  expect(observers).toHaveLength(0)
  await render(true)
  const target = harness.container.querySelector('[data-agent-conversation-message]')!
  const visible = { target, isIntersecting: true, intersectionRect: { height: 20 } } as IntersectionObserverEntry
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  observers[0]!.callback([visible], {} as IntersectionObserver)
  expect(onVisibleItems).not.toHaveBeenCalled()
  visibility.mockReturnValue('visible')
  document.dispatchEvent(new Event('visibilitychange'))
  expect(observers[0]!.observe).toHaveBeenCalledTimes(2)
  observers[0]!.callback([visible], {} as IntersectionObserver)
  expect(onVisibleItems).toHaveBeenCalledWith(['visible-message'])
  onVisibleItems.mockClear()
  await render(false)
  observers[0]!.callback([visible], {} as IntersectionObserver)
  expect(onVisibleItems).not.toHaveBeenCalled()
})
