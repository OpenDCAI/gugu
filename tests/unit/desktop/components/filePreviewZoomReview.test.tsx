// @vitest-environment jsdom
// #1625 review: reused preview panels, CSP-blocked HTML, Monaco, PhotoSwipe and the main-process probe.
import { createElement, act } from 'react'
import type PhotoSwipe from 'photoswipe'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { MessageFilePreviewPanel } from '../../../../apps/desktop/src/components/chat/MessageFilePreviewPanel'
import { HtmlPreviewSurface } from '../../../../apps/desktop/src/components/preview/HtmlPreviewSurface'
import { bindEditorFileZoom, readFileZoom, writeFileZoom } from '../../../../apps/desktop/src/components/preview/file-content-zoom'
import { wireReadingZoom } from '../../../../apps/desktop/src/components/preview/image-reading-zoom'
import { fileZoomScript, FILE_ZOOM_ATTRIBUTE } from '../../../../apps/desktop/src/session/shared/preview/file-zoom'
import { PREVIEW_RESTORED_MESSAGE_TYPE } from '../../../../apps/desktop/src/session/shared/preview/preview-link-script'
import { runWindowMenuCommand, type WindowMenuCommandTarget } from '../../../../apps/desktop/electron/window-menu-commands'

let harness: ReturnType<typeof createReactHarness>
const originalVisibility = HTMLElement.prototype.checkVisibility
beforeEach(() => {
  harness = createReactHarness(); localStorage.clear(); HTMLElement.prototype.checkVisibility = () => true
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
})
afterEach(() => { harness.cleanup(); localStorage.clear(); HTMLElement.prototype.checkVisibility = originalVisibility; vi.unstubAllGlobals() })

const runScript = (source: string) => Function('document', 'CustomEvent', `return ${source}`)(document, CustomEvent)
const native = () => {
  let level = 0
  const contents = { executeJavaScript: vi.fn(async (source: string) => runScript(source)), getZoomLevel: () => level, setZoomLevel: vi.fn((value: number) => { level = value }) }
  return { contents, target: { contents, window: {} } as unknown as WindowMenuCommandTarget }
}
const panel = (kind: 'text' | 'unsupported' | 'video') => createElement(MessageFilePreviewPanel, {
  kind, content: kind === 'text' ? 'A readable file' : null, videoUrl: 'blob:video', file: { fileName: kind === 'text' ? 'notes.txt' : 'clip.mp4', sizeBytes: 15, mimeType: 'text/plain' }, loading: false, onClose() {},
})
const pinch = (element: Element) => element.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -100, bubbles: true, cancelable: true }))

it('fileZoomScript only reports handled for a focused, visible, bound viewer', () => {
  const viewer = document.createElement('div')
  document.body.appendChild(viewer)
  const seen = vi.fn((event: Event) => { (event as CustomEvent).detail.handled = true })
  viewer.addEventListener('gugu:file-content-zoom', seen)
  viewer.tabIndex = -1; viewer.focus()
  expect(runScript(fileZoomScript('zoomIn'))).toBe(false)
  viewer.setAttribute(FILE_ZOOM_ATTRIBUTE, '')
  expect(runScript(fileZoomScript('zoomIn'))).toBe(true)
  expect((seen.mock.calls[0][0] as CustomEvent).detail.command).toBe('zoomIn')
  HTMLElement.prototype.checkVisibility = () => false
  expect(runScript(fileZoomScript('zoomOut'))).toBe(false)
  viewer.remove()
})

it('a reused preview panel rebinds when it switches to a text file of the same zoom kind, and unbinds when it leaves', async () => {
  await harness.render(panel('unsupported'))
  await harness.render(panel('text'))
  const viewport = harness.container.querySelector<HTMLElement>('[data-file-selection]')!
  viewport.focus()
  const n = native()
  await act(async () => runWindowMenuCommand('zoomIn', n.target))
  expect(Number((viewport.firstElementChild as HTMLElement).style.zoom)).toBeCloseTo(1.2)
  expect(n.contents.setZoomLevel).not.toHaveBeenCalled()
  await act(async () => { pinch(viewport) })
  expect(readFileZoom('text-code')).toBeGreaterThan(1.2)

  await harness.render(panel('video'))
  const video = harness.container.querySelector<HTMLElement>('[data-file-selection]')!
  expect(video.hasAttribute(FILE_ZOOM_ATTRIBUTE)).toBe(false)
  video.tabIndex = -1; video.focus()
  const keydown = new KeyboardEvent('keydown', { key: '=', metaKey: true, bubbles: true, cancelable: true })
  video.dispatchEvent(keydown)
  expect(keydown.defaultPrevented).toBe(false)
  await runWindowMenuCommand('zoomIn', n.target)
  expect(n.contents.setZoomLevel).toHaveBeenCalledWith(0.5)
})

it('an HTML page whose CSP blocked the injected script leaves Cmd+ to the window; a scripted page takes it', async () => {
  await harness.render(createElement(HtmlPreviewSurface, { fileName: 'page.html', url: 'blob:csp', onLink() {} }))
  const root = harness.container.querySelector<HTMLElement>(`[${FILE_ZOOM_ATTRIBUTE}]`)!
  const frame = harness.container.querySelector('iframe')!
  root.focus()
  const n = native()
  await act(async () => runWindowMenuCommand('zoomIn', n.target))
  expect(n.contents.setZoomLevel).toHaveBeenCalledWith(0.5)
  expect(localStorage.getItem('gugu.file-content-zoom.html')).toBeNull()

  await act(async () => { window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: PREVIEW_RESTORED_MESSAGE_TYPE } })) })
  await act(async () => runWindowMenuCommand('zoomIn', n.target))
  expect(Number(localStorage.getItem('gugu.file-content-zoom.html'))).toBeCloseTo(1.2)
  expect(n.contents.setZoomLevel).toHaveBeenCalledTimes(1)
})

it('Monaco follows the text/code preference and takes its pinch instead of its own global wheel zoom', async () => {
  writeFileZoom('text-code', 1.5)
  const container = document.createElement('div')
  const inner = container.appendChild(document.createElement('div'))
  document.body.appendChild(container)
  const editor = { updateOptions: vi.fn() }
  const innerWheel = vi.fn()
  inner.addEventListener('wheel', innerWheel)
  const off = bindEditorFileZoom(container, editor, 13)
  expect(editor.updateOptions).toHaveBeenLastCalledWith({ fontSize: 19.5 })

  const wheel = new WheelEvent('wheel', { ctrlKey: true, deltaY: -100, bubbles: true, cancelable: true })
  inner.dispatchEvent(wheel)
  expect(wheel.defaultPrevented).toBe(true)
  expect(innerWheel).not.toHaveBeenCalled()
  expect(readFileZoom('text-code')).toBeGreaterThan(1.5)
  expect(editor.updateOptions).toHaveBeenLastCalledWith({ fontSize: 13 * readFileZoom('text-code') })

  inner.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true }))
  expect(innerWheel).toHaveBeenCalledTimes(1)

  inner.tabIndex = -1; inner.focus()
  expect(runScript(fileZoomScript('resetZoom'))).toBe(true)
  expect(editor.updateOptions).toHaveBeenLastCalledWith({ fontSize: 13 })

  off()
  editor.updateOptions.mockClear()
  writeFileZoom('text-code', 2)
  expect(editor.updateOptions).not.toHaveBeenCalled()
  expect(container.hasAttribute(FILE_ZOOM_ATTRIBUTE)).toBe(false)
  container.remove()
})

it('PhotoSwipe applies the image preference, keeps a larger one when capped, and zooms out from what is shown', () => {
  const handlers = new Map<string, Array<(event: { slide: unknown }) => void>>()
  const slide = {
    zoomLevels: { initial: 0.5, max: 1 },
    currZoomLevel: 0.5,
    zoomTo: vi.fn((level: number) => { slide.currZoomLevel = level; emit('zoomPanUpdate') }),
  }
  const element = document.body.appendChild(document.createElement('div'))
  const pswp = { currSlide: slide, element, on: (name: string, handler: (event: { slide: unknown }) => void) => handlers.set(name, [...handlers.get(name) ?? [], handler]) }
  const emit = (name: string) => handlers.get(name)?.forEach(handler => handler({ slide }))
  writeFileZoom('image', 3)
  wireReadingZoom(pswp as unknown as PhotoSwipe)
  emit('afterInit')
  expect(slide.currZoomLevel).toBe(1)
  expect(readFileZoom('image')).toBe(3)

  // A pan, or the user holding this small image at its cap, does not lower the shared preference.
  emit('zoomPanUpdate')
  expect(readFileZoom('image')).toBe(3)

  element.tabIndex = -1; element.focus()
  expect(runScript(fileZoomScript('zoomOut'))).toBe(true)
  expect(readFileZoom('image')).toBeCloseTo(2 / 1.2)
  expect(slide.currZoomLevel).toBeCloseTo(0.5 * 2 / 1.2)

  // A user zoom below the cap is remembered.
  slide.currZoomLevel = 0.6
  emit('zoomPanUpdate')
  expect(readFileZoom('image')).toBeCloseTo(1.2)
  emit('destroy')
  element.remove()
})

it('a scripted HTML page keeps Cmd+ after re-renders, also when it never scrolls and its URL ends in "?"', async () => {
  const surface = () => createElement(HtmlPreviewSurface, { fileName: 'page.html', url: 'blob:static?', onLink() {} })
  await harness.render(surface())
  const root = harness.container.querySelector<HTMLElement>(`[${FILE_ZOOM_ATTRIBUTE}]`)!
  const frame = harness.container.querySelector('iframe')!
  // A page that never scrolls still answers the restore posted on load.
  await act(async () => { window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: PREVIEW_RESTORED_MESSAGE_TYPE } })) })
  // The parent re-renders (new onLink, zoom change) without the page reloading.
  await harness.render(surface())
  root.focus()
  const n = native()
  await act(async () => runWindowMenuCommand('zoomIn', n.target))
  await act(async () => runWindowMenuCommand('zoomIn', n.target))
  expect(Number(localStorage.getItem('gugu.file-content-zoom.html'))).toBeCloseTo(1.44)
  expect(n.contents.setZoomLevel).not.toHaveBeenCalled()
})
