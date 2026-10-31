// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileFileContextMenu } from '@/components/preview/MobileFileContextMenu'
import { bindFileViewerMenu } from '@/components/preview/file-viewer-menu'
import { createNode, createReactHarness, clickElement } from '../../../support/testHarness'

const state = vi.hoisted(() => ({ mobile: true, copy: vi.fn(async (_text: string) => {}), browserCopy: vi.fn(async (_text: string) => {}), toast: vi.fn() }))
vi.mock('@/hooks/useMobileShell', () => ({ useMobileShell: () => state.mobile }))
vi.mock('@/platform', () => ({ platform: { kind: 'capacitor', writeClipboardText: state.copy } }))
vi.mock('@/components/toastContext', () => ({ useToast: () => ({ toast: state.toast }) }))
vi.mock('react-i18next', async importOriginal => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ i18n: { resolvedLanguage: 'en-US' } }) }))
let harness: ReturnType<typeof createReactHarness>
let root: HTMLElement
let body: HTMLElement
let unbind: () => void
const quote = vi.fn()
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role=menuitem]')]
const item = (label: string) => menuItems().find(node => node.querySelector('.gg-menu-item-label')?.textContent === label)!
const pointer = (target: EventTarget, type: string, x = 30, pointerType = 'touch') => {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, { clientX: x, clientY: 40, pointerType })
  target.dispatchEvent(event)
}
const hold = async (target = body) => {
  await act(async () => { pointer(target, 'pointerdown'); vi.advanceTimersByTime(500) })
}
const select = () => {
  const range = document.createRange()
  range.selectNodeContents(body)
  document.getSelection()!.removeAllRanges()
  document.getSelection()!.addRange(range)
}

beforeEach(async () => {
  state.mobile = true
  state.copy.mockClear()
  state.browserCopy.mockClear()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: state.browserCopy } })
  state.toast.mockClear()
  quote.mockReset()
  root = document.createElement('aside')
  root.innerHTML = '<header>fixture.txt</header><div data-file-selection>Precise file selection</div>'
  document.body.append(root)
  body = root.lastElementChild as HTMLElement
  unbind = bindFileViewerMenu(root, () => ({ quote, canSelectAll: true }), state.toast)
  harness = createReactHarness()
  await harness.render(createNode(MobileFileContextMenu))
  vi.useFakeTimers()
})
afterEach(async () => {
  vi.useRealTimers()
  await harness.cleanup()
  unbind()
  root.remove()
  document.getSelection()?.removeAllRanges()
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
  else Reflect.deleteProperty(navigator, 'clipboard')
})

describe('mobile file menu uses captured viewer actions', () => {
  it('copies the captured selection through the host after focus clears it', async () => {
    select()
    await hold()
    expect(menuItems().map(node => node.querySelector('.gg-menu-item-label')?.textContent)).toEqual(['Copy', 'Select All', 'Quote Selection', 'Quote File'])
    document.getSelection()!.removeAllRanges()
    vi.useRealTimers()
    await clickElement(item('Copy'))
    expect(state.copy).toHaveBeenCalledWith('Precise file selection')
    expect(state.browserCopy).not.toHaveBeenCalled()
    expect(quote).not.toHaveBeenCalled()
  })

  it('quotes the captured selection through the existing binding and suppresses the release tap', async () => {
    select()
    await hold()
    const release = new Event('touchend', { bubbles: true, cancelable: true })
    body.dispatchEvent(release)
    expect(release.defaultPrevented).toBe(true)
    document.getSelection()!.removeAllRanges()
    vi.useRealTimers()
    await clickElement(item('Quote Selection'))
    expect(quote).toHaveBeenCalledWith({ text: 'Precise file selection' })
  })

  it('ignores selections outside the file and supports an HTML header without reaching into its iframe', async () => {
    unbind()
    unbind = bindFileViewerMenu(root, () => ({ quote, canSelectAll: false }), state.toast)
    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-scripts')
    body.replaceChildren(frame)
    pointer(frame.contentDocument!.body, 'pointerdown')
    await act(async () => vi.advanceTimersByTime(650))
    expect(menuItems()).toHaveLength(0)
    const outside = document.createElement('p')
    outside.textContent = 'unrelated chat text'
    document.body.append(outside)
    const range = document.createRange()
    range.selectNodeContents(outside)
    document.getSelection()!.addRange(range)
    await hold(root.firstElementChild as HTMLElement)
    expect(item('Copy').getAttribute('aria-disabled')).toBe('true')
    expect(item('Select All').getAttribute('aria-disabled')).toBe('true')
    expect(item('Quote Selection').getAttribute('aria-disabled')).toBe('true')
    vi.useRealTimers()
    await clickElement(item('Quote File'))
    expect(quote).toHaveBeenCalledWith(null)
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    outside.remove()
  })

  it('does not execute a captured action against a replacement file', async () => {
    await hold()
    unbind()
    const nextQuote = vi.fn()
    unbind = bindFileViewerMenu(root, () => ({ quote: nextQuote }), state.toast)
    vi.useRealTimers()
    await clickElement(item('Quote File'))
    expect(quote).not.toHaveBeenCalled()
    expect(nextQuote).not.toHaveBeenCalled()
  })

  it.each(['short tap', 'scroll', 'cancel', 'mouse'])('leaves %s without a long-press menu or suppressed click', async mode => {
    await act(async () => {
      pointer(body, 'pointerdown', 30, mode === 'mouse' ? 'mouse' : 'touch')
      if (mode === 'short tap') pointer(body, 'pointerup')
      if (mode === 'scroll') pointer(body, 'pointermove', 40)
      if (mode === 'cancel') pointer(body, 'pointercancel')
      vi.advanceTimersByTime(650)
    })
    expect(menuItems()).toHaveLength(0)
    const release = new Event('touchend', { bubbles: true, cancelable: true })
    body.dispatchEvent(release)
    expect(release.defaultPrevented).toBe(false)
  })

  it('keeps desktop file gestures on their existing host path', async () => {
    state.mobile = false
    await harness.render(createNode(MobileFileContextMenu))
    await hold()
    expect(menuItems()).toHaveLength(0)
  })
})
