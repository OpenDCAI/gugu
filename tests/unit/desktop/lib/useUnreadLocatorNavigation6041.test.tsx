// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'
import { useUnreadLocatorNavigation } from '../../../../apps/desktop/src/hooks/useUnreadLocatorNavigation'
import { UI_EVENTS } from '../../../../apps/desktop/src/lib/uiEvents'
import type { UnreadMessageRevealRequest } from '../../../../apps/desktop/src/lib/chatUnreadLocator'
import type { UnreadLocatorCommit } from '../../../../apps/desktop/src/lib/chatUnreadLocatorWindow'

let harness: ReturnType<typeof createReactHarness>
let surface: HTMLElement
beforeEach(() => { harness = createReactHarness(); surface = document.createElement('div'); document.body.appendChild(surface) })
afterEach(() => { harness.cleanup(); surface.remove(); vi.restoreAllMocks() })

async function setup() {
  let resolve = () => {}
  let reject = (_error: Error) => {}
  const revealMessage = vi.fn((_id: string, _commit?: UnreadLocatorCommit) => new Promise<void>((ok, fail) => { resolve = ok; reject = fail }))
  const input = { activeChatId: 'a', navigationTarget: true, enabled: true, onNavigate: vi.fn(),
    scrollerRef: { current: surface as HTMLElement | null }, revealMessage, setFlashMessageId: vi.fn(), flashTimerRef: { current: null } }
  let pending = false
  function Probe() { pending = useUnreadLocatorNavigation(input); return null }
  const render = () => harness.render(createNode(Probe))
  await render()
  const request = (extra: Partial<UnreadMessageRevealRequest> = {}): UnreadMessageRevealRequest => ({
    token: 'unread-10', chatId: 'a', streamId: 'main:a', streamKind: 'main', threadRootId: null,
    messageId: 'm10', messageSeq: 10, confirm: vi.fn(), reject: vi.fn(), isCurrent: () => true, ...extra,
  })
  const dispatch = (detail: UnreadMessageRevealRequest) => act(async () => { window.dispatchEvent(new CustomEvent(UI_EVENTS.openUnreadMessage, { detail })) })
  const visible = () => {
    const row = document.createElement('div')
    row.dataset.msgId = 'm10'
    surface.appendChild(row)
    const view = new DOMRect(0, 0, 300, 500), bounds = new DOMRect(0, 100, 300, 50)
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(view)
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(bounds)
    vi.spyOn(surface, 'getClientRects').mockReturnValue([view] as unknown as DOMRectList)
    vi.spyOn(row, 'getClientRects').mockReturnValue([bounds] as unknown as DOMRectList)
    // jsdom has no checkVisibility; the row is laid out and shown.
    row.checkVisibility = () => true
  }
  return { input, revealMessage, Probe, render, request, dispatch, visible, pending: () => pending,
    resolve: () => act(async () => resolve()), fail: (error: Error) => act(async () => reject(error)) }
}

describe('unread navigation through the shared anchor landing', () => {
  it('passes the fetched window to the anchor owner and confirms only after it resolves visibly', async () => {
    const view = await setup()
    const commit = { rows: [], readSeq: 100, reachedTail: false }
    const request = view.request({ commit })
    await view.dispatch(request)
    expect(view.revealMessage).toHaveBeenCalledExactlyOnceWith('m10', commit)
    expect(request.confirm).not.toHaveBeenCalled()
    expect(view.pending()).toBe(true)
    view.visible()
    await view.resolve()
    expect(request.confirm).toHaveBeenCalledExactlyOnceWith('m10')
    expect(view.input.setFlashMessageId).toHaveBeenCalledWith('m10')
    expect(request.reject).not.toHaveBeenCalled()
    expect(view.pending()).toBe(false)
  })

  it('keeps a request local to the addressed viewport', async () => {
    const view = await setup()
    const other = document.createElement('div')
    let otherPending = false
    function Other() { otherPending = useUnreadLocatorNavigation({ ...view.input, navigationTarget: false, scrollerRef: { current: other } }); return null }
    await harness.render(createNode('div', null, createNode(view.Probe), createNode(Other)))
    await view.dispatch(view.request({ viewport: surface }))
    expect(view.pending()).toBe(true)
    expect(otherPending).toBe(false)
    expect(view.revealMessage).toHaveBeenCalledOnce()
  })

  it('ignores another chat and another viewport without rejecting their requests', async () => {
    const view = await setup()
    const request = view.request({ chatId: 'b' })
    await view.dispatch(request)
    await view.dispatch({ ...request, chatId: 'a', viewport: document.createElement('div') })
    expect(view.revealMessage).not.toHaveBeenCalled()
    expect(request.reject).not.toHaveBeenCalled()
  })

  it('opens a filtered surface first and waits until it is enabled before revealing', async () => {
    const view = await setup()
    view.input.enabled = false
    await view.render()
    const request = view.request()
    await view.dispatch(request)
    expect(view.input.onNavigate).toHaveBeenCalledOnce()
    expect(view.revealMessage).not.toHaveBeenCalled()
    view.input.enabled = true
    await view.render()
    expect(view.revealMessage).toHaveBeenCalledOnce()
    expect(request.reject).not.toHaveBeenCalled()
  })

  it('does not start a superseded request', async () => {
    const view = await setup()
    const request = view.request({ isCurrent: () => false })
    await view.dispatch(request)
    expect(request.reject).toHaveBeenCalledWith(expect.objectContaining({ name: 'AbortError' }))
    expect(view.revealMessage).not.toHaveBeenCalled()
    expect(request.confirm).not.toHaveBeenCalled()
  })

  it('does not confirm a request superseded while its window was loading', async () => {
    const view = await setup()
    let current = true
    const request = view.request({ isCurrent: () => current })
    await view.dispatch(request)
    current = false
    view.visible()
    await view.resolve()
    expect(request.confirm).not.toHaveBeenCalled()
    expect(request.reject).toHaveBeenCalledWith(expect.objectContaining({ name: 'AbortError' }))
  })

  it('rejects a failed anchor load without confirming or highlighting it', async () => {
    const view = await setup()
    const request = view.request(), error = new Error('The message is not available')
    await view.dispatch(request)
    await view.fail(error)
    expect(request.reject).toHaveBeenCalledWith(error)
    expect(request.confirm).not.toHaveBeenCalled()
    expect(view.input.setFlashMessageId).not.toHaveBeenCalled()
  })

  it('requires the resolved anchor to be visibly rendered before confirming it', async () => {
    const view = await setup(), request = view.request()
    await view.dispatch(request)
    await view.resolve()
    expect(request.reject).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('not visible') }))
    expect(request.confirm).not.toHaveBeenCalled()
  })
})
