// @vitest-environment jsdom
import { createElement, act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { MessageFilePreviewPanel } from '../../../../apps/desktop/src/components/chat/MessageFilePreviewPanel'
import { HtmlPreviewSurface } from '../../../../apps/desktop/src/components/preview/HtmlPreviewSurface'
import { runWindowMenuCommand, type WindowMenuCommandTarget } from '../../../../apps/desktop/electron/window-menu-commands'

let harness: ReturnType<typeof createReactHarness>
const originalVisibility = HTMLElement.prototype.checkVisibility
beforeEach(() => { harness = createReactHarness(); localStorage.clear(); HTMLElement.prototype.checkVisibility = () => true })
afterEach(() => { harness.cleanup(); localStorage.clear(); HTMLElement.prototype.checkVisibility = originalVisibility })
const preview = (kind: 'markdown' | 'text') => createElement(MessageFilePreviewPanel, {
  kind, content: 'A readable file', file: { fileName: kind === 'text' ? 'notes.txt' : 'README.md', sizeBytes: 15, mimeType: 'text/plain' }, loading: false, onClose() {},
})
const native = () => {
  let level = 0
  const contents = { executeJavaScript: vi.fn(async (source: string) => Function('document', 'CustomEvent', `return ${source}`)(document, CustomEvent)), getZoomLevel: () => level, setZoomLevel: vi.fn((value: number) => { level = value }) }
  return { contents, target: { contents, window: {} } as unknown as WindowMenuCommandTarget }
}

it.each(['markdown', 'text'] as const)('native zoom changes %s content while the host window stays at its original scale; reset and reopen retain the type preference', async kind => {
  await harness.render(preview(kind))
  const viewport = harness.container.querySelector<HTMLElement>('[data-file-selection]')!
  viewport.tabIndex = -1
  viewport.focus()
  const n = native()
  await act(async () => runWindowMenuCommand('zoomIn', n.target))
  expect(Number((viewport.firstElementChild as HTMLElement).style.zoom)).toBeCloseTo(1.2)
  expect(n.contents.setZoomLevel).not.toHaveBeenCalled()
  await harness.render(createElement('div'))
  await harness.render(preview(kind))
  const reopened = harness.container.querySelector<HTMLElement>('[data-file-selection]')!
  expect(Number((reopened.firstElementChild as HTMLElement).style.zoom)).toBeCloseTo(1.2)
  reopened.tabIndex = -1
  reopened.focus()
  await act(async () => runWindowMenuCommand('resetZoom', n.target))
  expect(Number((reopened.firstElementChild as HTMLElement).style.zoom)).toBe(1)
  expect(n.contents.setZoomLevel).not.toHaveBeenCalled()
})

it('keeps markdown and code/text separate and leaves keys outside a file on the original window route', async () => {
  await harness.render(preview('markdown'))
  const viewport = harness.container.querySelector<HTMLElement>('[data-file-selection]')!
  viewport.tabIndex = -1; viewport.focus()
  await act(async () => viewport.dispatchEvent(new KeyboardEvent('keydown', { key: '=', metaKey: true, bubbles: true, cancelable: true })))
  expect(Number((viewport.firstElementChild as HTMLElement).style.zoom)).toBeCloseTo(1.2)
  await harness.render(preview('text'))
  expect(Number((harness.container.querySelector('[data-file-selection]')!.firstElementChild as HTMLElement).style.zoom)).toBe(1)
  await harness.render(createElement('input'))
  harness.container.querySelector('input')!.focus()
  const n = native()
  await runWindowMenuCommand('zoomIn', n.target)
  expect(n.contents.setZoomLevel).toHaveBeenCalledWith(0.5)
})

it('binds HTML zoom to the displayed iframe and refuses unrelated and hidden sources', async () => {
  await harness.render(createElement(HtmlPreviewSurface, { fileName: 'page.html', url: 'blob:current', onLink() {} }))
  const frame = harness.container.querySelector('iframe')!
  const change = (source: MessageEventSource | null) => window.dispatchEvent(new MessageEvent('message', { source, data: { type: 'gugu-preview-zoom', command: 'zoomIn' } }))
  await act(async () => { change(window); change(null) })
  expect(localStorage.getItem('gugu.file-content-zoom.html')).toBeNull()
  await act(async () => change(frame.contentWindow))
  expect(Number(localStorage.getItem('gugu.file-content-zoom.html'))).toBeCloseTo(1.2)
  await harness.render(createElement(HtmlPreviewSurface, { fileName: 'page.html', url: 'blob:next', onLink() {} }))
  const next = harness.container.querySelectorAll('iframe')[1]!
  // Loading is not permission to update the visible old document's preference.
  await act(async () => change(next.contentWindow))
  expect(Number(localStorage.getItem('gugu.file-content-zoom.html'))).toBeCloseTo(1.2)
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
})
