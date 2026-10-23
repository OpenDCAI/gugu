// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'
import { useUnreadLocatorNavigation } from '../../../../apps/desktop/src/hooks/useUnreadLocatorNavigation'
import { UI_EVENTS } from '../../../../apps/desktop/src/lib/uiEvents'
import type { UnreadMessageRevealRequest } from '../../../../apps/desktop/src/lib/chatUnreadLocator'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })

async function setup(loading = false) {
  const older = vi.fn().mockResolvedValue(undefined)
  const newer = vi.fn().mockResolvedValue(undefined)
  const input = {
    activeChatId: 'a', navigationTarget: true, enabled: true, onNavigate: vi.fn(), rows: [{ type: 'message', message: { id: 'm10', seq: 10 } }, { type: 'message', message: { id: 'm20', seq: 20 } }],
    scrollerRef: { current: null as HTMLElement | null }, listRef: { current: null }, setFollowingTail: vi.fn(), setFlashMessageId: vi.fn(),
    flashTimerRef: { current: null }, hasMoreOlder: true, loadingOlder: loading, loadOlderMessages: older,
    hasMoreNewer: true, loadingNewer: false, loadNewerMessages: newer,
  }
  function Probe() { useUnreadLocatorNavigation(input); return null }
  await harness.render(createNode(Probe))
  const reveal = async (seq: number, current = true) => {
    const request: UnreadMessageRevealRequest = {
      token: `token-${seq}`, chatId: 'a', streamId: 'main:a', streamKind: 'main', threadRootId: null,
      messageId: `m${seq}`, messageSeq: seq, confirm: vi.fn(), reject: vi.fn(), isCurrent: () => current,
    }
    await act(async () => { window.dispatchEvent(new CustomEvent(UI_EVENTS.openUnreadMessage, { detail: request })) })
    return request
  }
  return { older, newer, input, reveal, Probe, render: () => harness.render(createNode(Probe)) }
}

describe('unread reveal outside a bounded history window', () => {
  it.each([{ seq: 5, direction: 'older' }, { seq: 30, direction: 'newer' }])('loads $direction for sequence $seq', async ({ seq, direction }) => {
    const context = await setup()
    const request = await context.reveal(seq)
    expect(context[direction as 'older' | 'newer']).toHaveBeenCalledOnce()
    expect(context[direction === 'older' ? 'newer' : 'older']).not.toHaveBeenCalled()
    expect(request.confirm).not.toHaveBeenCalled()
    expect(request.reject).not.toHaveBeenCalled()
  })

  it('keeps pending presentation local while another same-chat viewport remains available', async () => {
    const context = await setup(true)
    const other = document.createElement('div'), target = document.createElement('div')
    context.input.scrollerRef.current = target
    let aPending = false, bPending = false
    function A() { aPending = useUnreadLocatorNavigation(context.input); return null }
    function B() { bPending = useUnreadLocatorNavigation({ ...context.input, navigationTarget: false, scrollerRef: { current: other } }); return null }
    await harness.render(createNode('div', null, createNode(A), createNode(B)))
    const request = { token: 'owned', chatId: 'a', streamId: 'main:a', streamKind: 'main', threadRootId: null,
      viewport: target, messageId: 'm5', messageSeq: 5, confirm: vi.fn(), reject: vi.fn() }
    await act(async () => { window.dispatchEvent(new CustomEvent(UI_EVENTS.openUnreadMessage, { detail: request })) })
    expect(aPending).toBe(true)
    expect(bPending).toBe(false)
    expect(request.reject).not.toHaveBeenCalled()
  })

  it('ignores another chat and another viewport instead of rejecting their request', async () => {
    const context = await setup()
    const other = document.createElement('div')
    const request = { token: 'other', chatId: 'b', streamId: 'main:b', streamKind: 'main', threadRootId: null,
      messageId: 'm10', messageSeq: 10, confirm: vi.fn(), reject: vi.fn() }
    await act(async () => { window.dispatchEvent(new CustomEvent(UI_EVENTS.openUnreadMessage, { detail: request })) })
    await act(async () => { window.dispatchEvent(new CustomEvent(UI_EVENTS.openUnreadMessage, { detail: { ...request, chatId: 'a', viewport: other } })) })
    expect(request.reject).not.toHaveBeenCalled()
    expect(context.input.setFollowingTail).not.toHaveBeenCalled()
  })

  it('addresses the primary navigation surface, ignoring a same-chat empty hidden or filtered pane', async () => {
    const context = await setup()
    function OtherPane() { useUnreadLocatorNavigation({ ...context.input, navigationTarget: false, rows: [] }); return null }
    await harness.render(createNode('div', null, createNode(context.Probe), createNode(OtherPane)))
    context.input.enabled = false
    const request = await context.reveal(5)
    expect(context.input.onNavigate).toHaveBeenCalledOnce()
    expect(request.reject).not.toHaveBeenCalled()
    expect(context.older).not.toHaveBeenCalled()
    context.input.enabled = true
    await harness.render(createNode('div', null, createNode(context.Probe), createNode(OtherPane)))
    expect(context.older).toHaveBeenCalledOnce()
    expect(request.reject).not.toHaveBeenCalled()
  })

  it('waits for an in-flight page instead of rejecting the locator', async () => {
    const context = await setup(true)
    const request = await context.reveal(5)
    expect(request.reject).not.toHaveBeenCalled()
    expect(context.older).not.toHaveBeenCalled()
    context.input.loadingOlder = false
    await context.render()
    expect(context.older).toHaveBeenCalledOnce()
  })

  it('does not scroll, fetch or confirm a superseded request', async () => {
    const context = await setup()
    const request = await context.reveal(30, false)
    expect(request.reject).toHaveBeenCalledWith(expect.objectContaining({ name: 'AbortError' }))
    expect(request.confirm).not.toHaveBeenCalled()
    expect(context.older).not.toHaveBeenCalled()
    expect(context.newer).not.toHaveBeenCalled()
    expect(context.input.setFollowingTail).not.toHaveBeenCalled()
  })

  it('rejects a missing message inside the fetched range rather than paging away', async () => {
    const context = await setup()
    const request = await context.reveal(15)
    expect(request.reject).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('not loaded') }))
    expect(context.older).not.toHaveBeenCalled()
    expect(context.newer).not.toHaveBeenCalled()
  })
})
