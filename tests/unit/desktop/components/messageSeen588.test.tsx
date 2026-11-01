// @vitest-environment jsdom
// #588 follow-up: a reply taller than the chat view never counted as seen (one 0.6 threshold it can never
// reach), so opening the assistant chat and reading all of it left its unread count in place.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { createReactHarness, message, renderWithAppProviders } from '../../../support/testHarness'
import type { ChatListRowItem, MessageListRowProps } from '../../../../apps/desktop/src/components/chat/MessageList'
import { MESSAGE_SEEN_THRESHOLDS, messageSeen } from '../../../../apps/desktop/src/components/chat/messageSeen'

vi.mock('../../../../apps/desktop/src/components/chat/MessageBubble', async () => {
  const React = await import('react')
  return { MessageBubble: ({ msg }: { msg: MessageItem }) => React.createElement('span', null, msg.content) }
})

const { MessageList } = await import('../../../../apps/desktop/src/components/chat/MessageList')

const VIEW = 600
function entry(elementHeight: number, visibleHeight: number) {
  return {
    isIntersecting: visibleHeight > 0,
    intersectionRatio: visibleHeight / elementHeight,
    intersectionRect: { height: visibleHeight } as DOMRectReadOnly,
    rootBounds: { height: VIEW } as DOMRectReadOnly,
  }
}

describe('messageSeen', () => {
  it('counts a short message once most of it is on screen, not before', () => {
    expect(messageSeen(entry(100, 60))).toBe(true)
    expect(messageSeen(entry(100, 59))).toBe(false)
    expect(messageSeen(entry(100, 0))).toBe(false)
  })

  it('counts a message taller than the view once it fills most of the view', () => {
    // 3 screens tall: at most a third of it can ever be visible, so the share rule alone never passes.
    expect(messageSeen(entry(VIEW * 3, VIEW))).toBe(true)
    expect(messageSeen(entry(VIEW * 3, VIEW * 0.6))).toBe(true)
    expect(messageSeen(entry(VIEW * 3, VIEW * 0.5))).toBe(false)
  })

  it('does not count a sliver of a tall message at the edge of the view', () => {
    expect(messageSeen(entry(VIEW * 3, 40))).toBe(false)
  })

  it('reports in steps fine enough for a tall message to cross one while it scrolls', () => {
    // A 10-screen message peaks at a 0.1 ratio; it must still cross a threshold on the way there.
    expect(MESSAGE_SEEN_THRESHOLDS.some((step) => step > 0 && step <= 0.1)).toBe(true)
    expect(MESSAGE_SEEN_THRESHOLDS).toContain(0.6)
  })
})

type Observed = { callback: IntersectionObserverCallback; options: IntersectionObserverInit | undefined; target: Element | null }

const noop = () => {}
function listProps(onVisible: (msg: MessageItem) => void) {
  const messages = [message({ id: 'long-reply', chat_id: 'dm-1', seq: 7, content: 'fifteen balcony tips' })]
  const rows: ChatListRowItem[] = messages.map((msg) => ({ type: 'message', message: msg }))
  const rowProps: MessageListRowProps = {
    rows, messages, isFiltering: false, mobile: true, memberReadSeqs: {}, deliveryWaits: new Map(), isGroupChat: false, memberProfiles: {},
    onReaction: noop, onQuote: noop, onForward: noop, onDelete: noop, onVisible, onOpenMemberProfile: undefined, onMentionMember: undefined,
    highlight: undefined, flashMessageId: undefined, threeParty: undefined, onShowReadReceipt: undefined, onOpenTopic: undefined, topicAnchors: undefined, onOpenTopicAnchor: undefined,
    agentFloodNoticeMessageId: undefined, onAgentFloodUndone: undefined, onOpenFile: undefined, onOpenLocalFileLink: undefined,
    selectMode: false, selectedIds: new Set(), onToggleSelect: noop, onEnterSelectMode: noop,
  }
  return { rows, rowProps, resetKey: 'dm-1#0#1' }
}

let harness: ReturnType<typeof createReactHarness>
let observed: Observed[]
beforeEach(() => {
  harness = createReactHarness()
  observed = []
  vi.stubGlobal('IntersectionObserver', class {
    private readonly record: Observed
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.record = { callback, options, target: null }
      observed.push(this.record)
    }
    observe(target: Element) { this.record.target = target }
    disconnect() {}
    unobserve() {}
    takeRecords() { return [] }
  })
})
afterEach(() => { harness.cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('MessageList read visibility', () => {
  it('marks a reply taller than the chat view as seen when it fills the view', async () => {
    const onVisible = vi.fn()
    await renderWithAppProviders(harness, createElement(MessageList, listProps(onVisible)))
    const row = observed.find((item) => item.target)
    expect(row).toBeDefined()
    // Measured against the message scroller, not the window.
    expect(row!.options?.root).toBe(harness.container.querySelector('[data-unread-stream-surface]'))
    expect(row!.options?.threshold).toEqual([...MESSAGE_SEEN_THRESHOLDS])

    row!.callback([entry(VIEW * 3, 40) as IntersectionObserverEntry], {} as IntersectionObserver)
    expect(onVisible).not.toHaveBeenCalled()

    row!.callback([entry(VIEW * 3, VIEW) as IntersectionObserverEntry], {} as IntersectionObserver)
    expect(onVisible).toHaveBeenCalledTimes(1)
    expect(onVisible.mock.calls[0]![0].id).toBe('long-reply')
  })
})
