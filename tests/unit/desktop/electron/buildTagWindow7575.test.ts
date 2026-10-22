import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { expect, it, vi } from 'vitest'
import { createBuildTagAuxWindow } from '../../../../apps/desktop/electron/build-tag-window'

vi.mock('../../../../apps/desktop/electron/devtools-lock', () => ({ hardenWebPreferences: <T>(preferences: T) => preferences }))
vi.mock('electron', async () => ({ app: new (await import('node:events')).EventEmitter() }))

function windows() {
  const parent = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    visible: true,
    isVisible() { return this.visible },
    isMinimized: () => false,
    focused: true,
    isFocused() { return this.focused },
    getContentBounds: () => ({ x: 100, y: 50, width: 1200, height: 800 }),
    getMediaSourceId: () => 'window:7575:0',
  })
  const child = Object.assign(new EventEmitter(), {
    webContents: new EventEmitter(),
    isDestroyed: () => false,
    visible: false,
    isVisible() { return this.visible },
    setBounds: vi.fn(),
    hide: vi.fn(function () { child.visible = false }),
    showInactive: vi.fn(function () { child.visible = true }),
    moveAbove: vi.fn(function () { child.visible = true }),
    setParentWindow: vi.fn(),
  })
  const window = createBuildTagAuxWindow(parent as unknown as BrowserWindow)
  window.adopt(child as unknown as BrowserWindow)
  return { parent, child, window }
}

it('keeps an independently sized native badge in the bottom-right corner without reserving app space', () => {
  const { parent, child, window } = windows()
  expect(window.options('#ffffff')).toMatchObject({
    parent,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { enablePreferredSizeMode: true, nodeIntegration: false, contextIsolation: true },
  })
  child.webContents.emit('preferred-size-changed', {}, { width: 180, height: 19 })
  expect(child.setBounds).toHaveBeenLastCalledWith({ x: 1118, y: 829, width: 180, height: 19 })
  child.webContents.emit('preferred-size-changed', {}, { width: 360, height: 240 })
  expect(child.setBounds).toHaveBeenLastCalledWith({ x: 938, y: 608, width: 360, height: 240 })
  // #77 挂成真正的子窗(showInactive),❌ moveAbove 顶替:父窗一被提前它就沉到下面。
  expect(child.showInactive).toHaveBeenCalledOnce()
  expect(child.moveAbove).not.toHaveBeenCalled()
})

it('follows parent visibility and releases its window listeners when closed', () => {
  const { parent, child } = windows()
  child.webContents.emit('preferred-size-changed', {}, { width: 180, height: 19 })
  expect(child.visible).toBe(true)
  parent.visible = false
  parent.emit('hide')
  expect(child.visible).toBe(false)
  parent.visible = true
  parent.emit('show')
  expect(child.visible).toBe(true)
  child.emit('closed')
  expect(parent.listenerCount('resize')).toBe(0)
  expect(parent.listenerCount('hide')).toBe(0)
})
