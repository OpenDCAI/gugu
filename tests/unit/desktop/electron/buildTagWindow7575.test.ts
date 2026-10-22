import { EventEmitter } from 'node:events'
import type { BrowserWindow, WebContents } from 'electron'
import { expect, it, vi } from 'vitest'
import { openBuildTagLayer } from '../../../../apps/desktop/electron/build-tag-window'

vi.mock('../../../../apps/desktop/electron/devtools-lock', () => ({ hardenWebPreferences: <T>(preferences: T) => preferences }))
vi.mock('electron', () => ({
  WebContentsView: class {
    webContents: unknown
    webPreferences: unknown
    bounds: unknown = null
    visible = true
    background = ''
    constructor(options: { webContents: unknown; webPreferences: unknown }) {
      this.webContents = options.webContents
      this.webPreferences = options.webPreferences
    }
    setBounds(bounds: unknown) { this.bounds = bounds }
    setVisible(visible: boolean) { this.visible = visible }
    setBackgroundColor(color: string) { this.background = color }
  },
}))

type FakeView = { bounds: unknown; visible: boolean; background: string; webContents: unknown; webPreferences: unknown }

function fakeContents() {
  const contents = Object.assign(new EventEmitter(), {
    destroyed: false,
    isDestroyed: () => contents.destroyed,
    close: () => {
      contents.destroyed = true
      contents.emit('destroyed')
    },
  })
  return contents
}

function layer() {
  const children: FakeView[] = []
  const parent = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    getContentSize: () => [1200, 800],
    contentView: {
      children,
      addChildView(view: FakeView) {
        const at = children.indexOf(view)
        if (at !== -1) children.splice(at, 1)
        children.push(view)
      },
      removeChildView(view: FakeView) {
        const at = children.indexOf(view)
        if (at !== -1) children.splice(at, 1)
      },
    },
  })
  const webContents = fakeContents()
  openBuildTagLayer(parent as unknown as BrowserWindow, { webContents: webContents as unknown as WebContents, webPreferences: { enablePreferredSizeMode: true } })
  return { parent, webContents, view: children[0] }
}

it('is a transparent layer in the window, sized to its text, in the bottom-right corner, without reserving app space', () => {
  const { webContents, view } = layer()
  expect(view.webPreferences).toEqual({ enablePreferredSizeMode: true })
  expect(view.background).toBe('#00000000')
  expect(view.visible).toBe(false)
  webContents.emit('preferred-size-changed', {}, { width: 180, height: 19 })
  expect(view.bounds).toEqual({ x: 1018, y: 779, width: 180, height: 19 })
  expect(view.visible).toBe(true)
  webContents.emit('preferred-size-changed', {}, { width: 360, height: 240 })
  expect(view.bounds).toEqual({ x: 838, y: 558, width: 360, height: 240 })
  // 界面放手时把内容清空(大小 0):收起。
  webContents.emit('preferred-size-changed', {}, { width: 0, height: 0 })
  expect(view.visible).toBe(false)
})

it('one badge per window: a new claim replaces the old layer (the renderer must never window.close it)', () => {
  const { parent, webContents } = layer()
  const next = fakeContents()
  openBuildTagLayer(parent as unknown as BrowserWindow, { webContents: next as unknown as WebContents })
  expect(webContents.destroyed).toBe(true)
  expect(parent.contentView.children).toHaveLength(1)
  expect(parent.contentView.children[0].webContents).toBe(next)
})

it('follows the window size and leaves the window when its content closes', () => {
  const { parent, webContents, view } = layer()
  webContents.emit('preferred-size-changed', {}, { width: 180, height: 19 })
  parent.getContentSize = () => [800, 600]
  parent.emit('resize')
  expect(view.bounds).toEqual({ x: 618, y: 579, width: 180, height: 19 })
  webContents.close()
  expect(parent.contentView.children).toHaveLength(0)
  expect(parent.listenerCount('resize')).toBe(0)
})
