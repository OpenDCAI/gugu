// @vitest-environment jsdom
// #1708 来源消息定位(群右栏工作区 App 的 gugu.showMessage → 壳的 app-show-message 事件):
// 已加载的直接滚过去;没加载的交给会话滚动记忆的 revealMessage(载锚点、落位、核对),落稳了才闪;
// 载不到 / 等不来 → fail-loud,不滚去别处。
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'
import { askReveal, useSourceMessageReveal } from '../../../../apps/desktop/src/hooks/useSourceMessageReveal'
import { UI_EVENTS } from '../../../../apps/desktop/src/lib/uiEvents'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })

const row = (id: string) => ({ type: 'message', message: { id } })

async function setup(reveal: (id: string) => Promise<void> = () => Promise.resolve()) {
  const scrollToIndex = vi.fn()
  const input = {
    activeChatId: 'g1', navigationTarget: true,
    rows: [row('m40'), row('m41')],
    listRef: { current: { scrollToIndex } } as never,
    isAtBottomRef: { current: true },
    setFollowingTail: vi.fn(),
    setFlashMessageId: vi.fn(),
    flashTimerRef: { current: null },
    revealMessage: vi.fn(reveal),
    onMissing: vi.fn(),
  }
  function Probe() { useSourceMessageReveal(input); return null }
  await harness.render(createNode(Probe))
  const show = (messageId: string, chatId = 'g1') =>
    act(async () => { askReveal(chatId, messageId); window.dispatchEvent(new CustomEvent(UI_EVENTS.chatAsked, { detail: { chatId } })) })
  return { input, scrollToIndex, show }
}

describe('source message reveal', () => {
  it('scrolls to a loaded message and flashes it, without loading anything', async () => {
    const c = await setup()
    await c.show('m41')
    expect(c.scrollToIndex).toHaveBeenCalledWith({ index: 1, align: 'center' })
    expect(c.input.setFlashMessageId).toHaveBeenCalledWith('m41')
    expect(c.input.isAtBottomRef.current).toBe(false)
    expect(c.input.revealMessage).not.toHaveBeenCalled()
    expect(c.input.onMissing).not.toHaveBeenCalled()
  })

  it('hands a message the chat has not loaded to revealMessage, and flashes it once it has settled', async () => {
    let settle: () => void = () => {}
    const c = await setup(() => new Promise<void>((resolve) => { settle = resolve }))
    await c.show('m1')
    expect(c.input.revealMessage).toHaveBeenCalledWith('m1')
    expect(c.scrollToIndex).not.toHaveBeenCalled() // the list is not scrolled somewhere else meanwhile
    expect(c.input.setFlashMessageId).not.toHaveBeenCalled()
    await act(async () => { settle() })
    expect(c.input.setFlashMessageId).toHaveBeenCalledWith('m1')
    expect(c.input.onMissing).not.toHaveBeenCalled()
  })

  it('says so when the message cannot be shown (in a thread, deleted, never settled)', async () => {
    const c = await setup(() => Promise.reject(new Error('Saved conversation message is no longer available')))
    await c.show('gone')
    await vi.waitFor(() => expect(c.input.onMissing).toHaveBeenCalledOnce())
    expect(c.scrollToIndex).not.toHaveBeenCalled()
    expect(c.input.setFlashMessageId).not.toHaveBeenCalled()
  })

  it('a later request wins: an earlier one that settles late neither flashes nor complains', async () => {
    const pending: Array<{ resolve: () => void; reject: (e: Error) => void }> = []
    const c = await setup(() => new Promise<void>((resolve, reject) => { pending.push({ resolve, reject }) }))
    await c.show('m1')
    await c.show('m41') // loaded: scrolls at once
    await act(async () => { pending[0].reject(new Error('superseded')) })
    expect(c.input.onMissing).not.toHaveBeenCalled()
    expect(c.input.setFlashMessageId).toHaveBeenCalledTimes(1)
    expect(c.input.setFlashMessageId).toHaveBeenCalledWith('m41')
  })

  it('keeps local quote callbacks and routed App requests with their presentation target', async () => {
    const a = { scrollToIndex: vi.fn(), flash: vi.fn(), show: null as ((id: string) => void) | null }
    const b = { scrollToIndex: vi.fn(), flash: vi.fn(), show: null as ((id: string) => void) | null }
    function Pane({ view, viewportKey }: { view: typeof a; viewportKey: string }) {
      view.show = useSourceMessageReveal({ activeChatId: 'g1', viewportKey, rows: [row('m40'), row('m41')],
        listRef: { current: { scrollToIndex: view.scrollToIndex } } as never, isAtBottomRef: { current: true }, setFollowingTail: vi.fn(),
        setFlashMessageId: view.flash, flashTimerRef: { current: null }, revealMessage: vi.fn(async () => {}), onMissing: vi.fn() })
      return null
    }
    await harness.render(createNode('div', null, createNode(Pane, { view: a, viewportKey: 'slot-a' }), createNode(Pane, { view: b, viewportKey: 'slot-b' })))
    await act(async () => { a.show!('m40') })
    expect(a.scrollToIndex).toHaveBeenCalledOnce()
    expect(b.scrollToIndex).not.toHaveBeenCalled()
    await act(async () => { askReveal('g1', 'm41', 'slot-b'); window.dispatchEvent(new CustomEvent(UI_EVENTS.chatAsked)) })
    expect(a.scrollToIndex).toHaveBeenCalledOnce()
    expect(b.scrollToIndex).toHaveBeenCalledWith({ index: 1, align: 'center' })
  })

  it('ignores a request for another group', async () => {
    const c = await setup()
    await c.show('m41', 'g2')
    expect(c.scrollToIndex).not.toHaveBeenCalled()
    expect(c.input.revealMessage).not.toHaveBeenCalled()
  })
})
