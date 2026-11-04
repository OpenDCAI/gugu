// @vitest-environment jsdom
import { act, type ComponentProps, type MemoExoticComponent, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageBubble } from '../../../../apps/desktop/src/components/chat/MessageBubble'
import { Markdown } from '../../../../apps/desktop/src/components/markdown/Markdown'
import { TOOLTIP_OPEN_DELAY_MS } from '../../../../apps/desktop/src/styles/motion'
import { readHoverOwner, releaseHoverOwner } from '../../../../apps/desktop/src/components/chat/hover-owner'
import { createNode, createReactHarness, message, renderWithAppProviders } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }))

const bubble = MessageBubble as MemoExoticComponent<(props: ComponentProps<typeof MessageBubble>) => ReactNode>
const markdown = Markdown as MemoExoticComponent<(props: ComponentProps<typeof Markdown>) => ReactNode>

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.spyOn(bubble, 'type')
  vi.spyOn(markdown, 'type')
  harness = createReactHarness()
})
afterEach(() => {
  harness.cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const renderCounts = () => ({
  bubble: vi.mocked(bubble.type).mock.calls.length,
  markdown: vi.mocked(markdown.type).mock.calls.length,
})

async function renderMessage() {
  await renderWithAppProviders(harness, createNode(MessageBubble, {
    msg: message({ id: 'hover-render', content: 'A hover body with **stable** markup.', sender_user_id: 'sender-1' }),
    compactMobile: false, isGroup: true, memberReadSeqs: {},
    onReaction: vi.fn(), onQuote: vi.fn(), onForward: vi.fn(), onDelete: vi.fn(),
  }))
}

async function hoverMessage() {
  const row = harness.container.querySelector('[data-message-bubble-row]')
  expect(row).not.toBeNull()
  const over = new MouseEvent('pointerover', { bubbles: true })
  Object.defineProperty(over, 'pointerType', { value: 'mouse' })
  await act(async () => {
    row!.dispatchEvent(over)
    row!.dispatchEvent(new MouseEvent('mouseenter'))
  })
}

async function renderPair() {
  const props = { compactMobile: false, isGroup: true, memberReadSeqs: {}, onReaction: vi.fn(), onQuote: vi.fn(), onForward: vi.fn(), onDelete: vi.fn() }
  await renderWithAppProviders(harness, <>{['first', 'second'].map((id) => createNode(MessageBubble, {
    ...props, key: id, msg: message({ id, content: 'A stable neighboring message.', sender_user_id: 'sender-1' }),
  }))}</>)
  return [...harness.container.querySelectorAll<HTMLElement>('[data-message-bubble-row]')]
}

async function enter(row: Element, x = 0, y = 0) {
  const over = new MouseEvent('pointerover', { bubbles: true, clientX: x, clientY: y })
  Object.defineProperty(over, 'pointerType', { value: 'mouse' })
  await act(async () => {
    row.dispatchEvent(over)
    row.dispatchEvent(new MouseEvent('mouseenter', { clientX: x, clientY: y }))
    vi.advanceTimersByTime(0)
  })
}

describe('message hover rendering', () => {
  it.each([false, true])('hands over to an adjacent row without the tooltip delay (up: %s)', async (up) => {
    const rows = await renderPair()
    const [from, to] = up ? [...rows].reverse() : rows
    await enter(from)
    expect(from.hasAttribute('data-popup-open')).toBe(true)
    const before = renderCounts()
    await enter(to)
    expect(to.hasAttribute('data-popup-open')).toBe(true)
    expect(from.hasAttribute('data-popup-open')).toBe(false)
    expect(document.querySelectorAll('[data-testid="message-hover-actions"]')).toHaveLength(1)
    expect(renderCounts()).toEqual(before)
  })

  it.each(['release', 'move', 'leave-window'] as const)('resolves waiting ownership after movement, window exit, or owner release (%s)', async (action) => {
    const [upper, lower] = await renderPair()
    vi.spyOn(upper, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 600, 80))
    vi.spyOn(lower, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 200, 600, 80))
    await enter(lower, 650, 240)
    const popup = document.querySelector<HTMLElement>('[data-testid="message-hover-actions"]')!
    vi.spyOn(popup, 'getBoundingClientRect').mockReturnValue(new DOMRect(590, 158, 110, 40))
    await enter(upper, 650, 180)
    expect(lower.hasAttribute('data-popup-open')).toBe(true)
    expect(upper.hasAttribute('data-popup-open')).toBe(false)
    await act(async () => {
      if (action === 'leave-window') upper.dispatchEvent(new MouseEvent('pointerleave', { relatedTarget: null }))
      if (action !== 'move') releaseHoverOwner(readHoverOwner()!.id)
      else upper.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 110, clientY: 180 }))
    })
    expect(upper.hasAttribute('data-popup-open')).toBe(action !== 'leave-window')
    expect(lower.hasAttribute('data-popup-open')).toBe(false)
  })

  it('opens message actions without waiting for the button tooltip delay', async () => {
    await renderMessage()
    await hoverMessage()
    await act(async () => { vi.advanceTimersByTime(0) })
    expect(document.querySelector('[data-testid="message-hover-actions"]')).not.toBeNull()
  })

  it('keeps the message and Markdown render counts stable when the bar opens', async () => {
    await renderMessage()
    const before = renderCounts()
    expect(before.bubble).toBeGreaterThan(0)
    expect(before.markdown).toBeGreaterThan(0)
    await hoverMessage()
    await act(async () => { vi.advanceTimersByTime(TOOLTIP_OPEN_DELAY_MS) })
    expect(document.querySelector('[data-testid="message-hover-actions"]')).not.toBeNull()
    const after = renderCounts()
    console.info('[hover-render-counts]', JSON.stringify({ before, after }))
    expect(after).toEqual(before)
  })
})
