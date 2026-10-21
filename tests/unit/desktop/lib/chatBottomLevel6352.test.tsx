// @vitest-environment jsdom
// #6352 「读者在底部」是电平:门打开 / 几何变化到底时要重读,不能只认那一次边沿。
// 产品面读数(mac1,长历史群聊):① 未读定位打开、全部未读已在屏内 ⇒ Virtuoso 在「定位中」那一刻
// 报过一次到底,之后不再报;② 快速滚回底部,最后一次 scroll 停在阈值外、列表量完变矮才到底 ⇒ 没有
// scroll 事件。两种都让窗口以为读者在翻历史,自己发一条就回到最新页、整表重挂(闪)。
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'
import { useFollowingTail } from '../../../../apps/desktop/src/components/chat/useFollowingTail'
import { useChatHistoryPagination } from '../../../../apps/desktop/src/components/chat/useChatHistoryPagination'
import { ChatHistoryWindow, HISTORY_START_INDEX, type HistoryWindow } from '../../../../apps/desktop/src/store/chatHistoryWindow'
import { message } from '../../../support/testHarness'
import { MAX_WINDOW } from '../../../../apps/desktop/src/store/chatMessageWindow'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })

describe('following the tail is derived from the at-bottom level', () => {
  async function setup() {
    const setFollowingTail = vi.fn()
    const isAtBottomRef = { current: false }
    const input = { resetKey: 'chat-1#0#1', unreadNavigationPending: true, hasNewer: false, loading: false, preserving: false }
    let onAtBottomChange: (atBottom: boolean) => void = () => {}
    function Probe() {
      onAtBottomChange = useFollowingTail({ ...input, isPreservingPosition: () => input.preserving, isAtBottomRef, setFollowingTail }).onAtBottomChange
      return null
    }
    const render = () => harness.render(createNode(Probe))
    await render()
    return { setFollowingTail, isAtBottomRef, input, render, report: (atBottom: boolean) => act(async () => { onAtBottomChange(atBottom) }) }
  }

  it('rejoins the tail when the unread-navigation gate opens after the only at-bottom report', async () => {
    const view = await setup()
    await view.report(true) // the list reports once, while the unread locator is still pending
    expect(view.setFollowingTail).toHaveBeenLastCalledWith(false)
    view.input.unreadNavigationPending = false
    await view.render() // no second report: the reader never moved
    expect(view.setFollowingTail).toHaveBeenLastCalledWith(true)
    expect(view.isAtBottomRef.current).toBe(true)
  })

  it('stays off the tail when the gate opens but the reader is not at the bottom (control)', async () => {
    const view = await setup()
    await view.report(false)
    view.input.unreadNavigationPending = false
    await view.render()
    expect(view.setFollowingTail).toHaveBeenLastCalledWith(false)
    expect(view.isAtBottomRef.current).toBe(false)
  })

  it('keeps a reader restored to a saved off-bottom position off the tail when a gate flips afterwards', async () => {
    const view = await setup()
    view.input.unreadNavigationPending = false
    view.input.preserving = true // reopening a chat whose saved position is up in history
    await view.render()
    await view.report(true) // the list opens at LAST first ...
    await view.report(false) // ... then the restore scrolls it to the saved anchor
    view.setFollowingTail(false) // the restore ends by leaving the tail itself
    view.input.preserving = false
    view.input.loading = true // the reader then loads an older page
    await view.render()
    view.input.loading = false
    await view.render()
    expect(view.setFollowingTail).toHaveBeenLastCalledWith(false)
  })

  it('rejoins when the last newer page clears hasNewer under a reader already at the bottom', async () => {
    const view = await setup()
    view.input.unreadNavigationPending = false
    view.input.hasNewer = true
    await view.render()
    await view.report(true)
    expect(view.setFollowingTail).toHaveBeenLastCalledWith(false)
    view.input.hasNewer = false
    await view.render()
    expect(view.setFollowingTail).toHaveBeenLastCalledWith(true)
  })
})

describe('the newer page is requested from the at-bottom level, not only from scroll events', () => {
  function historyWindow(): HistoryWindow {
    const messages = Array.from({ length: 120 }, (_, index) => ({ id: `m${index + 11}`, seq: index + 11 })) as HistoryWindow['messages']
    return { chatId: 'chat-1', messages, firstItemIndex: HISTORY_START_INDEX, hasOlder: true, hasNewer: true, loading: null,
      change: 'older', navigation: 'older', navigationVersion: 4, viewVersion: 1, newMessageCount: 0, latestSeen: 200 }
  }
  function scrollerAt(fromBottom: number): HTMLElement {
    const element = document.createElement('div')
    Object.defineProperty(element, 'scrollHeight', { value: 11_503 })
    Object.defineProperty(element, 'clientHeight', { value: 776 })
    element.scrollTop = 11_503 - 776 - fromBottom
    return element
  }
  async function setup(fromBottom: number) {
    const loadNewer = vi.fn(async () => {})
    const loadOlder = vi.fn(async () => {})
    const input = { atBottom: false }
    const window = historyWindow()
    const scroller = scrollerAt(fromBottom)
    function Probe() {
      useChatHistoryPagination({ resetKey: 'chat-1#0#1', messages: window.messages, enabled: true, scroller, atBottom: input.atBottom, loadOlder, loadNewer, window })
      return null
    }
    const render = () => harness.render(createNode(Probe))
    await render()
    return { loadNewer, loadOlder, input, render }
  }

  it('loads newer when the list shrinks the reader onto the bottom without a scroll event', async () => {
    const view = await setup(0)
    expect(view.loadNewer).not.toHaveBeenCalled()
    view.input.atBottom = true
    await view.render()
    expect(view.loadNewer).toHaveBeenCalledOnce()
    expect(view.loadOlder).not.toHaveBeenCalled()
  })

  it('does not load newer from a stale level while the geometry is away from the bottom (control)', async () => {
    const view = await setup(1_400)
    view.input.atBottom = true
    await view.render()
    expect(view.loadNewer).not.toHaveBeenCalled()
    expect(view.loadOlder).not.toHaveBeenCalled()
  })
})

describe('a tail-following window slides instead of shrinking in bulk', () => {
  const rows = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => message({ id: `m${from + index}`, seq: from + index, chat_id: 'chat-1' }))
  async function readHistoryThenReturn() {
    const window = new ChatHistoryWindow('user-1')
    window.reset('chat-1', rows(161, 200))
    await window.load('older', async (_chat, _way, cursor, limit) => rows(Math.max(1, cursor - limit), cursor - 1))
    expect(window.getSnapshot()).toMatchObject({ hasNewer: false, loading: null })
    expect(window.getSnapshot().messages).toHaveLength(100)
    return window
  }

  it('keeps the rows a reader returns to when it rejoins the tail; new rows grow it up to MAX_WINDOW, then slide by one', async () => {
    const window = await readHistoryThenReturn()
    const head = window.getSnapshot().messages[0]!.id
    expect(window.setFollowingTail(true)).toBe(true)
    expect(window.getSnapshot().messages).toHaveLength(100)
    expect(window.getSnapshot().messages[0]!.id).toBe(head)
    window.update((previous) => [...previous, message({ id: 'mine', seq: -1, is_mine: true, chat_id: 'chat-1' })])
    expect(window.getSnapshot().messages).toHaveLength(101)
    expect(window.getSnapshot().messages.at(-1)!.id).toBe('mine')
    expect(window.getSnapshot().messages[0]!.id, '长尾不删头:在底部的读者看到的是追加').toBe(head)
    window.update((previous) => [...previous.filter((row) => row.seq > 0), ...rows(201, 220)])
    expect(window.getSnapshot().messages).toHaveLength(MAX_WINDOW)
    window.update((previous) => [...previous, ...rows(221, 221)])
    expect(window.getSnapshot().messages).toHaveLength(MAX_WINDOW)
    expect(window.getSnapshot().messages.at(-1)!.id).toBe('m221')
    expect(window.getSnapshot().messages[0]!.id).not.toBe(head)
  })

  // #6530 打开一个已缓存(40 行)的会话,尾部对账一次补进 k 条:从前窗口滑动 k 行(长度不变),Virtuoso 看不到追加,
  // 跟随不触发,mac1 上 9 次里 4 次停在底部上方 ~2000px。现在是追加。
  it('a burst of new rows on an open 40-row window is an append, not a slide', () => {
    const window = new ChatHistoryWindow('user-1')
    window.reset('chat-1', rows(161, 200))
    const head = window.getSnapshot().messages[0]!.id
    window.update((previous) => [...previous, ...rows(201, 225)])
    expect(window.getSnapshot().messages).toHaveLength(65)
    expect(window.getSnapshot().messages[0]!.id).toBe(head)
    expect(window.getSnapshot().messages.at(-1)!.id).toBe('m225')
  })

  it('still opens a chat at the initial window size (control)', () => {
    const window = new ChatHistoryWindow('user-1')
    window.reset('chat-1', rows(101, 200))
    expect(window.getSnapshot().messages).toHaveLength(40)
  })
})
