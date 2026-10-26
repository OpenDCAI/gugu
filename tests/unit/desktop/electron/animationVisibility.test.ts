import { EventEmitter } from 'node:events'
import { JSDOM } from 'jsdom'
import type { BrowserWindow, WebContents } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { isAnimationWindowVisible } from '@gugu/session-shared/animation-visibility'
import { forwardWindowSeen } from '../../../../apps/desktop/electron/animation-visibility'

const log = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('../../../../apps/desktop/electron/lib/logger', () => ({ createLogger: () => log }))

const cleanup: Array<() => void> = []
function fixture() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, runScripts: 'outside-only' })
  const contents = Object.assign(new EventEmitter(), {
    destroyed: false,
    isDestroyed() { return this.destroyed },
    executeJavaScript: vi.fn(async (source: string) => dom.window.eval(source) as unknown),
  })
  const host = Object.assign(new EventEmitter(), {
    visible: true,
    minimized: false,
    isDestroyed: () => false,
    isVisible() { return this.visible },
    isMinimized() { return this.minimized },
    webContents: contents,
  })
  const value = { dom, host, contents, window: host as unknown as BrowserWindow, target: contents as unknown as WebContents }
  cleanup.push(() => {
    contents.destroyed = true
    contents.emit('destroyed')
    dom.window.close()
  })
  return value
}

afterEach(() => {
  cleanup.splice(0).forEach((stop) => stop())
  vi.clearAllMocks()
})

it('sends the native signal to each window and its layers without pausing a visible auxiliary window', () => {
  const main = fixture(), aux = fixture(), layer = fixture()
  for (const { dom } of [main, aux, layer]) expect(isAnimationWindowVisible(dom.window.document)).toBe(true)
  forwardWindowSeen(main.window)
  forwardWindowSeen(aux.window)
  forwardWindowSeen(main.window, layer.target)
  main.host.minimized = true
  main.host.visible = false
  main.host.emit('minimize')
  expect([main, aux, layer].map(({ dom }) => isAnimationWindowVisible(dom.window.document))).toEqual([false, true, false])
  expect(main.dom.window.document.hidden).toBe(false)
  aux.host.visible = false
  aux.host.emit('hide')
  expect(isAnimationWindowVisible(aux.dom.window.document)).toBe(false)
  aux.host.visible = true
  aux.host.emit('show')
  expect(isAnimationWindowVisible(aux.dom.window.document)).toBe(true)
  main.host.minimized = false
  main.host.visible = true
  main.host.emit('restore')
  expect([main, aux, layer].map(({ dom }) => isAnimationWindowVisible(dom.window.document))).toEqual([true, true, true])
})

it('synchronizes an initially hidden window after document load and releases native listeners when its contents dies', () => {
  const { dom, host, contents, window } = fixture()
  host.visible = false
  forwardWindowSeen(window)
  // The first event preceded renderer installation. The load boundary must
  // report the actual native state instead of assuming a new document is shown.
  isAnimationWindowVisible(dom.window.document)
  contents.emit('did-finish-load')
  expect(isAnimationWindowVisible(dom.window.document)).toBe(false)
  contents.destroyed = true
  contents.emit('destroyed')
  const delivered = contents.executeJavaScript.mock.calls.length
  host.visible = true
  host.emit('show')
  expect(contents.executeJavaScript).toHaveBeenCalledTimes(delivered)
  expect(host.listenerCount('show')).toBe(0)
})

it('reports a failed delivery while the target is still alive', async () => {
  const { contents, window } = fixture()
  contents.executeJavaScript.mockRejectedValueOnce(new Error('delivery failed'))
  forwardWindowSeen(window)
  await Promise.resolve()
  await Promise.resolve()
  expect(log.error).toHaveBeenCalledOnce()
})
