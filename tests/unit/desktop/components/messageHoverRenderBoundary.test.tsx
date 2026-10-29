// @vitest-environment jsdom
import { act, type ComponentProps, type MemoExoticComponent, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageBubble } from '../../../../apps/desktop/src/components/chat/MessageBubble'
import { Markdown } from '../../../../apps/desktop/src/components/markdown/Markdown'
import { TOOLTIP_OPEN_DELAY_MS } from '../../../../apps/desktop/src/styles/motion'
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

describe('message hover rendering', () => {
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
