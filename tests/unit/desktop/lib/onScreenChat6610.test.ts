// @vitest-environment jsdom
// App 在不在前台只信宿主(subscribeAppActive):这里 document.visibilityState 一直是 visible,它若被读到,「切到后台」那条就红。
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'

const host = vi.hoisted(() => ({
  listener: null as null | ((active: boolean) => void),
  subscribeAppActive: undefined as undefined | ((listener: (active: boolean) => void) => () => void),
}))
vi.mock('../../../../apps/desktop/src/platform', () => ({
  platform: {
    get subscribeAppActive() { return host.subscribeAppActive },
  },
}))

const { chatOnScreen, useReportChatOnScreen } = await import('../../../../apps/desktop/src/lib/onScreenChat')

let harness: ReturnType<typeof createReactHarness>
const seen: Array<string | null> = []
function Shell({ shown }: { shown: string | null }) {
  seen.push(useReportChatOnScreen(shown))
  return null
}

beforeEach(() => {
  harness = createReactHarness()
  seen.length = 0
  host.listener = null
  host.subscribeAppActive = (listener) => {
    host.listener = listener
    listener(true)
    return () => { host.listener = null }
  }
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
})
afterEach(() => { harness.cleanup() })

describe('#6610 chat on screen', () => {
  it('is the chat the shell shows, and nothing once the app goes to the background', async () => {
    await harness.render(createNode(Shell, { shown: 'chat-1' }))
    expect(chatOnScreen()).toBe('chat-1')
    expect(seen.at(-1)).toBe('chat-1')

    await act(async () => { host.listener?.(false) })
    expect(chatOnScreen(), 'backgrounded while the page still says visible').toBeNull()
    expect(seen.at(-1), 'the shell re-renders with the chat no longer on screen').toBeNull()

    await act(async () => { host.listener?.(true) })
    expect(chatOnScreen()).toBe('chat-1')
    expect(seen.at(-1)).toBe('chat-1')
  })

  it('follows the shell synchronously and clears when the shell goes away', async () => {
    await harness.render(createNode(Shell, { shown: 'chat-1' }))
    const rendersBefore = seen.length
    await harness.render(createNode(Shell, { shown: 'chat-2' }))
    // 切会话的那一次渲染就给出新值,不先渲染一帧「没在看」。
    expect(seen.slice(rendersBefore)).not.toContain(null)
    expect(chatOnScreen()).toBe('chat-2')
    await harness.render(createNode(Shell, { shown: null }))
    expect(chatOnScreen(), 'back to the list').toBeNull()
    await harness.render(createNode(Shell, { shown: 'chat-2' }))
    expect(chatOnScreen()).toBe('chat-2')
    await harness.render(null)
    expect(chatOnScreen(), 'no shell, nothing on screen').toBeNull()
  })

  it('falls back to page visibility on hosts that cannot tell', async () => {
    host.subscribeAppActive = undefined
    await harness.render(createNode(Shell, { shown: 'chat-1' }))
    expect(chatOnScreen()).toBe('chat-1')
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(chatOnScreen()).toBeNull()
  })

  it('waits for a new host answer and ignores a delayed answer from the previous subscription', async () => {
    await harness.render(createNode(Shell, { shown: 'chat-1' }))
    const previousAnswer = host.listener
    expect(chatOnScreen()).toBe('chat-1')
    await harness.render(null)
    host.subscribeAppActive = (listener) => {
      host.listener = listener // the real host's initial answer is asynchronous
      return () => { host.listener = null }
    }
    await harness.render(createNode(Shell, { shown: 'chat-2' }))
    expect(chatOnScreen()).toBeNull()
    expect(seen.at(-1)).toBeNull()
    await act(async () => { previousAnswer?.(true) })
    expect(chatOnScreen()).toBeNull()
    await act(async () => { host.listener?.(false) })
    expect(chatOnScreen()).toBeNull()
    await act(async () => { host.listener?.(true) })
    expect(chatOnScreen()).toBe('chat-2')
  })
})

describe('#7199 more than one place can show a chat', () => {
  it('is the chat whichever reporter shows, whatever the order they mounted in', async () => {
    const both = (chat: string | null, assistant: string | null) =>
      createNode('div', null, createNode(Shell, { shown: chat }), createNode(Shell, { shown: assistant }))
    await harness.render(both(null, 'dm'))
    expect(chatOnScreen(), 'the chat page reports nothing; the assistant chat is on screen').toBe('dm')
    await harness.render(both('chat-1', null))
    expect(chatOnScreen()).toBe('chat-1')
    await harness.render(both(null, null))
    expect(chatOnScreen()).toBeNull()
  })
})
