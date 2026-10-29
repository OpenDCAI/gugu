// @vitest-environment jsdom
import { act, createElement, useLayoutEffect, useRef } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ChatContext, ChatState } from '@gugu/session-chat-ui'
import { createReactHarness } from '../../../support/testHarness'
vi.mock('../../../../apps/desktop/src/session/renderer/lib/chat/chat-transcript', () => ({
  ChatTranscript: (props: { onReady: (view: unknown) => void }) => {
    const ref = useRef<HTMLDivElement>(null)
    const { onReady } = props
    useLayoutEffect(() => { onReady({ composerSlot: ref.current }) }, [onReady])
    return <div><div data-agent-conversation-message="visible-message"><div data-user-card="">Reply</div></div><div ref={ref} data-test-composer="" /></div>
  },
}))
import { AgentConversationView } from '../../../../apps/desktop/src/session/renderer/lib/chat/agent-conversation-view'
let harness: ReturnType<typeof createReactHarness>
let observers: { callback: IntersectionObserverCallback; observe: ReturnType<typeof vi.fn>; options?: IntersectionObserverInit }[]
let messageTop: number
let frames: Map<number, FrameRequestCallback>
let nextFrame: number
beforeEach(() => {
  harness = createReactHarness(); observers = []
  frames = new Map(); nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  messageTop = 100
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const top = this.hasAttribute('data-test-composer') ? 500 : this.hasAttribute('data-agent-conversation-message') || this.hasAttribute('data-user-card') ? messageTop : 0
    const height = this.hasAttribute('data-agent-conversation') ? 600 : this.hasAttribute('data-test-composer') ? 100 : 20
    return { x: 0, y: top, top, bottom: top + height, left: 0, right: 400, width: 400, height, toJSON() {} }
  })
  vi.stubGlobal('IntersectionObserver', class {
    observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn()
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) { observers.push({ callback, options, observe: this.observe }) }
  })
})
afterEach(() => { harness.cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function paint() {
  await act(async () => {
    const pending = [...frames.values()]
    frames.clear()
    for (const callback of pending) callback(0)
  })
}
it('advances read only for actually visible messages and ignores callbacks after hiding the pane', async () => {
  const onVisibleItems = vi.fn()
  const render = (shown: boolean) => harness.render(createElement(AgentConversationView, { shown, onVisibleItems, context: {} as ChatContext, state: {} as ChatState }))
  await render(false)
  expect(observers).toHaveLength(0)
  await render(true)
  const target = harness.container.querySelector('[data-agent-conversation-message]')!
  const visible = { target, isIntersecting: true, intersectionRect: { height: 20 } } as IntersectionObserverEntry
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  const observer = observers.at(-1)!
  observer.callback([visible], {} as IntersectionObserver)
  expect(onVisibleItems).not.toHaveBeenCalled()
  visibility.mockReturnValue('visible')
  document.dispatchEvent(new Event('visibilitychange'))
  expect(observer.observe).toHaveBeenCalledTimes(2)
  observer.callback([visible], {} as IntersectionObserver)
  expect(onVisibleItems).toHaveBeenCalledWith(['visible-message'])
  onVisibleItems.mockClear()
  await render(false)
  observer.callback([visible], {} as IntersectionObserver)
  expect(onVisibleItems).not.toHaveBeenCalled()
})

it('excludes the floating editor from the observer and does not read a covered message body', async () => {
  const onVisibleItems = vi.fn()
  await harness.render(createElement(AgentConversationView, { shown: true, onVisibleItems, context: {} as ChatContext, state: {} as ChatState }))
  const observer = observers.at(-1)!
  expect(observer.options?.rootMargin).toBe('0px 0px -100px 0px')
  const target = harness.container.querySelector('[data-agent-conversation-message]')!
  const visible = { target, isIntersecting: true, intersectionRect: { height: 20 } } as IntersectionObserverEntry
  messageTop = 520
  observer.callback([visible], {} as IntersectionObserver)
  expect(onVisibleItems).not.toHaveBeenCalled()
  messageTop = 490 // Only the upper half is above the floating editor.
  observer.callback([visible], {} as IntersectionObserver)
  expect(onVisibleItems).not.toHaveBeenCalled()
  messageTop = 470
  observer.callback([visible], {} as IntersectionObserver)
  expect(onVisibleItems).toHaveBeenCalledWith(['visible-message'])
})

it('reads a resting message after anchor layout without requiring an intersection change or a scroll', async () => {
  const onVisibleItems = vi.fn()
  messageTop = 620
  await harness.render(createElement(AgentConversationView, { shown: true, onVisibleItems, context: {} as ChatContext, state: {} as ChatState }))
  await paint()
  expect(onVisibleItems).not.toHaveBeenCalled()
  await act(async () => {
    messageTop = 120
    harness.container.querySelector<HTMLElement>('[data-agent-conversation-message]')!.style.transform = 'translateY(-500px)'
  })
  await paint()
  expect(onVisibleItems).toHaveBeenCalledWith(['visible-message'])
})

it('does not let the post-layout scan read a covered message or run after hiding', async () => {
  const onVisibleItems = vi.fn()
  const draw = (shown: boolean) => harness.render(createElement(AgentConversationView, { shown, onVisibleItems, context: {} as ChatContext, state: {} as ChatState }))
  messageTop = 520
  await draw(true)
  await paint()
  expect(onVisibleItems).not.toHaveBeenCalled()
  messageTop = 100
  await draw(false)
  await paint()
  expect(onVisibleItems).not.toHaveBeenCalled()
})
