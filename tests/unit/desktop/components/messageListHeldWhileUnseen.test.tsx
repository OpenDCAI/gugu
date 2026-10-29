// @vitest-environment jsdom
// 主窗最小化 / 收进托盘(宿主发 __window_seen=false):消息流停在离开时那一帧 —— 新到的消息不渲染、不被「看见即已读」读掉;
// 窗口回来一次补齐。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { ANIMATION_WINDOW_SEEN_EVENT } from '@gugu/session-shared/animation-visibility'
import { createReactHarness, message } from '../../../support/testHarness'
import type { ChatListRowItem, MessageListRowProps } from '../../../../apps/desktop/src/components/chat/MessageList'

vi.mock('../../../../apps/desktop/src/components/chat/MessageBubble', async () => {
  const React = await import('react')
  return { MessageBubble: ({ msg }: { msg: MessageItem }) => React.createElement('span', null, msg.content) }
})
const { MessageList } = await import('../../../../apps/desktop/src/components/chat/MessageList')

const noop = () => {}
function props(count: number, onVisible: (msg: MessageItem) => void) {
  const messages = Array.from({ length: count }, (_, i) => message({ id: `m${i}`, chat_id: 'g', seq: i + 1, content: `line ${i}` }))
  const rows: ChatListRowItem[] = messages.map((msg) => ({ type: 'message', message: msg }))
  const rowProps: MessageListRowProps = {
    rows, messages, isFiltering: false, mobile: false, memberReadSeqs: {}, queuedIds: new Set(), isAgentChat: false, isGroupChat: true, memberProfiles: {},
    onReaction: noop, onQuote: noop, onForward: noop, onDelete: noop, onVisible, onOpenMemberProfile: undefined, onMentionMember: undefined,
    highlight: undefined, flashMessageId: undefined, threeParty: undefined, onShowReadReceipt: undefined, onOpenTopic: undefined, topicAnchors: undefined, onOpenTopicAnchor: undefined,
    agentFloodNoticeMessageId: undefined, onAgentFloodUndone: undefined, onOpenFile: undefined, onOpenLocalFileLink: undefined,
    selectMode: false, selectedIds: new Set(), onToggleSelect: noop, onEnterSelectMode: noop,
  }
  return { rows, rowProps, resetKey: 'g#0#1' }
}
const ids = (root: Element) => Array.from(root.querySelectorAll<HTMLElement>('[data-msg-id]')).map((row) => row.dataset.msgId)
const windowSeen = (seen: boolean) => act(() => { window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: seen })) })

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); vi.stubGlobal('IntersectionObserver', undefined) })
afterEach(async () => { await windowSeen(true); harness.cleanup(); vi.unstubAllGlobals() })

describe('MessageList while the window is not seen', () => {
  it('holds the last frame, then catches up when the window comes back', async () => {
    const onVisible = vi.fn()
    await harness.render(createElement(MessageList, props(2, onVisible)))
    expect(ids(harness.container)).toEqual(['m0', 'm1'])
    onVisible.mockClear()

    await windowSeen(false)
    await harness.render(createElement(MessageList, props(4, onVisible)))
    expect(ids(harness.container)).toEqual(['m0', 'm1'])
    expect(onVisible.mock.calls.map(([msg]) => msg.id)).not.toContain('m3')

    await windowSeen(true)
    expect(ids(harness.container)).toEqual(['m0', 'm1', 'm2', 'm3'])
    expect(onVisible.mock.calls.map(([msg]) => msg.id)).toContain('m3')
  })
})
