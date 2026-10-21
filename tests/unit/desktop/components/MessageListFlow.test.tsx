// @vitest-environment jsdom
// #6595 消息列表按文档流排整个消息窗口(滚动机制在 lib/flowList.ts,那边有落点 / 贴底 / 头部插行的几何用例)。
// 这里判列表组件自己的几件事:窗口里每一行都在、两栏各报各的表面、落点未定时整块藏着、「↑ N 条新消息」。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { createReactHarness, message, renderWithAppProviders } from '../../../support/testHarness'
import type { ChatListRowItem, MessageListRowProps } from '../../../../apps/desktop/src/components/chat/MessageList'

vi.mock('../../../../apps/desktop/src/components/chat/MessageBubble', async () => {
  const React = await import('react')
  return { MessageBubble: ({ msg }: { msg: MessageItem }) => React.createElement('span', null, msg.content) }
})

const { MessageList } = await import('../../../../apps/desktop/src/components/chat/MessageList')

const noop = () => {}
function listProps(chatId: string, count: number) {
  const messages = Array.from({ length: count }, (_, i) => message({ id: `${chatId}-m${i}`, chat_id: chatId, seq: i + 1, content: `${chatId} line ${i}` }))
  const rows: ChatListRowItem[] = messages.map((msg) => ({ type: 'message', message: msg }))
  const rowProps: MessageListRowProps = {
    rows, messages, isFiltering: false, mobile: false, memberReadSeqs: {}, isAgentChat: false, isGroupChat: true, memberProfiles: {},
    onReaction: noop, onQuote: noop, onForward: noop, onDelete: noop, onVisible: noop,
    selectMode: false, selectedIds: new Set(), onToggleSelect: noop, onEnterSelectMode: noop,
  }
  return { rows, rowProps, resetKey: `${chatId}#0#1` }
}
const ids = (root: Element | null) => Array.from(root?.querySelectorAll<HTMLElement>('[data-msg-id]') ?? []).map((row) => row.dataset.msgId)

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); vi.restoreAllMocks() })

describe('MessageList 文档流', () => {
  it.each([false, true])('协作消息保留发送者并按己方归属排版,不显示指向或无效消息操作 (is_mine=%s)', async (isMine) => {
    vi.stubGlobal('IntersectionObserver', undefined)
    try {
      const props = listProps('chat-1', 1)
      const direct = message({ id: 'session-direct:delegation', chat_id: 'chat-1', seq: -1, sender_user_id: 'assistant-id', content: '请检查本周报告', is_mine: isMine })
      props.rows.push({ type: 'task-exchange', message: direct, recipientUserId: 'task-id' })
      const onVisible = vi.fn()
      props.rowProps = { ...props.rowProps, rows: props.rows, messages: props.rows.map((row) => row.message), onVisible }
      await renderWithAppProviders(harness, createElement(MessageList, props), { contacts: { contacts: [
        { id: 'assistant-id', display_name: '咕咕', avatar: null, bio: null, type: 'agent' },
        { id: 'task-id', display_name: '报告任务', avatar: null, bio: null, type: 'agent' },
      ] } })
      const row = harness.container.querySelector('[data-task-exchange]')!
      expect(row.textContent).toContain('咕咕')
      expect(row.textContent).not.toContain('→')
      expect(row.hasAttribute('data-own')).toBe(isMine)
      expect(row.textContent).toContain('请检查本周报告')
      expect(row.querySelector('button')).toBeNull()
      expect(onVisible).toHaveBeenCalledTimes(1)
      expect(onVisible.mock.calls[0]![0].id).toBe('chat-1-m0')
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('窗口里的每一行都按顺序排在滚动容器里(不再只渲染视口附近的几行)', async () => {
    await harness.render(createElement(MessageList, listProps('chat-1', 30)))
    const scroller = harness.container.querySelector('[data-testid="chat-message-list"]')
    expect(scroller?.getAttribute('data-unread-stream-surface')).toBe('main')
    expect(ids(scroller)).toEqual(Array.from({ length: 30 }, (_, i) => `chat-1-m${i}`))
  })

  it('topInset:顶部给悬浮小鸟让位 —— 加在滚动容器的内边距上(滚到最上面时第一条不在它脚下);不传 = 不加', async () => {
    const scroller = () => harness.container.querySelector<HTMLElement>('[data-testid="chat-message-list"]')!
    await harness.render(createElement(MessageList, { ...listProps('chat-1', 3), topInset: 16 }))
    expect(scroller().style.paddingTop).toBe('16px')
    await harness.render(createElement(MessageList, { ...listProps('chat-1', 3) }))
    expect(scroller().style.paddingTop).toBe('')
  })

  it('副栏报自己的表面,未读定位器只看得见主线', async () => {
    await harness.render(createElement(MessageList, { ...listProps('topic-1', 3), surface: 'aside' }))
    expect(harness.container.querySelector('[data-testid="chat-message-list"]')).toBeNull()
    expect(harness.container.querySelector('[data-testid="chat-message-list-aside"]')?.getAttribute('data-unread-stream-surface')).toBe('aside')
  })

  it('换一条线(resetKey)换一个滚动容器;同一条线的重渲沿用原来那个', async () => {
    await harness.render(createElement(MessageList, listProps('chat-1', 3)))
    const first = harness.container.querySelector('[data-testid="chat-message-list"]')
    await harness.render(createElement(MessageList, { ...listProps('chat-1', 4) }))
    expect(harness.container.querySelector('[data-testid="chat-message-list"]')).toBe(first)
    await harness.render(createElement(MessageList, listProps('chat-2', 3)))
    expect(harness.container.querySelector('[data-testid="chat-message-list"]')).not.toBe(first)
  })

  // 恢复位置的锚点还在载入(null):先按最新处放但整块藏着,不露出与终态无关的最新几行;锚点那段换进窗口时整列表重挂。
  it('落点还没定(null)时整块藏着;调用方放弃等待、落点变回最新处就露出来', async () => {
    const props = listProps('chat-1', 5)
    const frame = () => harness.container.querySelector<HTMLElement>('[data-testid="chat-message-list"]')!.parentElement!
    await harness.render(createElement(MessageList, { ...props, initialTopMostItemIndex: null }))
    expect(frame().style.visibility).toBe('hidden')
    await harness.render(createElement(MessageList, { ...props, initialTopMostItemIndex: { index: 'LAST', align: 'end' } }))
    expect(frame().style.visibility).toBe('')
  })
})

// @@@6530 微信式打开:列表停在最新处,这次打开时的第一条未读在视口上方才出「↑ N 条新消息」。
// 视口 0–500;列表停在底部 ⇒ 最后 10 行(每行 50)看得见,更早的在上方。jsdom 没有布局,矩形由这里给。
function stubViewport() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid === 'chat-message-list') return { top: 0, bottom: 500 } as DOMRect
    const index = Number(this.getAttribute('aria-posinset') ?? 0) - 1
    return { top: 500 - (30 - index) * 50, bottom: 550 - (30 - index) * 50 } as DOMRect
  })
}
const pill = () => harness.container.querySelector<HTMLElement>('[data-unread-above]')

describe('MessageList「↑ N 条新消息」', () => {
  it('第一条未读在视口上方:列表落位后就出,点它交给定位', async () => {
    stubViewport()
    const onJump = vi.fn()
    await harness.render(createElement(MessageList, { ...listProps('chat-1', 30), unreadAbove: { messageId: 'chat-1-m5', messageSeq: 6, label: '↑ 25 条新消息', onJump } }))
    expect(pill()?.textContent).toBe('↑ 25 条新消息')
    await act(async () => { pill()!.click() })
    expect(onJump).toHaveBeenCalledTimes(1)
  })

  it('第一条未读就在屏内(未读少)不出;窗口里还没有它(尾部对账未回)也不出', async () => {
    stubViewport()
    await harness.render(createElement(MessageList, { ...listProps('chat-1', 30), unreadAbove: { messageId: 'chat-1-m25', messageSeq: 26, label: 'x', onJump: noop } }))
    expect(pill()).toBeNull()
    await harness.render(createElement(MessageList, { ...listProps('chat-2', 30), unreadAbove: { messageId: 'chat-2-m40', messageSeq: 41, label: 'x', onJump: noop } }))
    expect(pill()).toBeNull()
  })

  it('比窗口最早一条还早(积压超过一窗)⇒ 在上方', async () => {
    stubViewport()
    await harness.render(createElement(MessageList, { ...listProps('chat-1', 30), unreadAbove: { messageId: 'older', messageSeq: 0, label: '↑ 99 条新消息', onJump: noop } }))
    expect(pill()?.textContent).toBe('↑ 99 条新消息')
  })
})
