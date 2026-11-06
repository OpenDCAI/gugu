// @vitest-environment jsdom
import { createElement, act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { MessageFilePreviewPanel } from '../../../../apps/desktop/src/components/chat/MessageFilePreviewPanel'
import { HtmlPreviewSurface } from '../../../../apps/desktop/src/components/preview/HtmlPreviewSurface'
import { ImageRenderer } from '../../../../apps/desktop/src/session/renderer/lib/editor/image-renderer'
import { DocumentPreviewContent } from '../../../../apps/desktop/src/components/chat/DocumentPreviewContent'
import { runWindowMenuCommand, type WindowMenuCommandTarget } from '../../../../apps/desktop/electron/window-menu-commands'
import { bindAppPageZoom } from '../../../../apps/desktop/src/components/preview/file-content-zoom'
import { ZoomMenuRow } from '../../../../apps/desktop/src/components/preview/ZoomMenuRow'

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

it('zooms the actual workspace image using its fitted geometry and retains the image preference', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
  const draw = async (path: string) => {
    await harness.render(createElement(ImageRenderer, { file: { path, content: `data:image/png,${path}` } }))
    const image = harness.container.querySelector('img')!
    Object.defineProperties(image, { naturalWidth: { configurable: true, value: 2000 }, naturalHeight: { configurable: true, value: 1000 } })
    await act(async () => image.dispatchEvent(new Event('load')))
    return image
  }
  const image = await draw('first.png')
  const viewport = harness.container.firstElementChild as HTMLElement
  viewport.tabIndex = -1; viewport.focus()
  const before = parseFloat(image.style.width)
  const n = native()
  await act(async () => runWindowMenuCommand('zoomIn', n.target))
  expect(parseFloat(image.style.width)).toBeGreaterThan(before)
  expect(n.contents.setZoomLevel).not.toHaveBeenCalled()
  expect(parseFloat((await draw('second.png')).style.width)).toBeCloseTo(before * 1.2)
})

// Installed only under apps/desktop: the bare name does not resolve from tests/, so a mock under it misses the product import.
const PDFJS = '../../../../apps/desktop/node_modules/pdfjs-dist/legacy/build/pdf.mjs'

it('zooms PDF from keys with no lasting control (zoom B): the ratio floats up over the view and the toolbar stays unscaled', async () => {
  // Rendering is deliberately pending: zoom ownership must already work before the PDF library answers.
  vi.doMock(PDFJS, () => ({ GlobalWorkerOptions: {}, getDocument: () => ({ promise: new Promise(() => {}), destroy() {} }) }))
  await harness.render(createElement(DocumentPreviewContent, { kind: 'pdf', content: new ArrayBuffer(0), title: 'report.pdf' }))
  const viewport = harness.container.querySelector<HTMLElement>('.document-preview-pdf-viewport')!
  viewport.tabIndex = -1; viewport.focus()
  const n = native()
  await act(async () => runWindowMenuCommand('zoomIn', n.target))
  expect(document.body.querySelector('[role="status"]')!.textContent).toBe('120%')
  expect(harness.container.querySelector('.document-preview-toolbar')!.textContent).not.toContain('%')
  expect((harness.container.querySelector('.document-preview-toolbar') as HTMLElement).style.zoom).toBe('')
  expect(n.contents.setZoomLevel).not.toHaveBeenCalled()
  vi.doUnmock(PDFJS)
})

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

it('zooms a Word document from keys like every readable view, remembered for Word documents', async () => {
  vi.doMock('docx-preview', () => ({ renderAsync: () => new Promise(() => {}) }))
  await harness.render(createElement(DocumentPreviewContent, { kind: 'docx', content: new ArrayBuffer(0), title: 'doc.docx' }))
  const root = harness.container.querySelector<HTMLElement>('[data-testid="docx-preview"]')!
  root.tabIndex = -1; root.focus()
  const n = native()
  await act(async () => runWindowMenuCommand('zoomIn', n.target))
  expect(Number(harness.container.querySelector<HTMLElement>('.document-preview-docx-body')!.style.zoom)).toBeCloseTo(1.2)
  expect(Number(localStorage.getItem('gugu.file-content-zoom.docx'))).toBeCloseTo(1.2)
  expect(n.contents.setZoomLevel).not.toHaveBeenCalled()
  vi.doUnmock('docx-preview')
})

it('zooms an App page as a whole from the window keys while it has focus, remembered per App; the window stays at its scale', async () => {
  const box = document.createElement('div')
  const page = Object.assign(document.createElement('div'), { tabIndex: 0, setZoomFactor: vi.fn() })
  box.append(page); document.body.append(box)
  const off = bindAppPageZoom(box, page, 'office')
  page.dispatchEvent(new Event('dom-ready'))
  expect(page.setZoomFactor).toHaveBeenLastCalledWith(1)
  page.focus()
  const n = native()
  await act(async () => runWindowMenuCommand('zoomIn', n.target))
  expect(page.setZoomFactor).toHaveBeenLastCalledWith(1.2)
  expect(Number(localStorage.getItem('gugu.file-content-zoom.app:office'))).toBeCloseTo(1.2)
  expect(n.contents.setZoomLevel).not.toHaveBeenCalled()
  // Another App keeps its own size; a page loaded anew is zoomed again.
  expect(localStorage.getItem('gugu.file-content-zoom.app:kanban')).toBeNull()
  page.setZoomFactor.mockClear()
  page.dispatchEvent(new Event('dom-ready'))
  expect(page.setZoomFactor).toHaveBeenLastCalledWith(1.2)
  off(); box.remove()
})

it('the ⋯ menu row steps the same preference as the keys and resets it from its ratio', async () => {
  await harness.render(createElement(ZoomMenuRow, { kind: 'markdown' }))
  const [out, ratio, into] = Array.from(harness.container.querySelectorAll('button'))
  expect(ratio!.textContent).toBe('100%')
  await act(async () => into!.click())
  expect(ratio!.textContent).toBe('120%')
  expect(Number(localStorage.getItem('gugu.file-content-zoom.markdown'))).toBeCloseTo(1.2)
  await act(async () => out!.click())
  expect(Number(localStorage.getItem('gugu.file-content-zoom.markdown'))).toBeCloseTo(1)
  await act(async () => { into!.click(); ratio!.click() })
  expect(ratio!.textContent).toBe('100%')
})
