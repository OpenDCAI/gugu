import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { showChildAbove } from '../../../../apps/desktop/electron/child-window'

/**
 * #77 agent 浮层 / 构建角标这类小子窗:露出来时不把父窗提到别的 App 前面(electron#49393),
 * 也要真正挂成原生子窗 —— 否则父窗一被提前它就沉到父窗下面(macOS 上只有 showInactive 过的子窗才挂得上)。
 */

const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const onPlatform = (platform: string) => Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
afterEach(() => {
  Object.defineProperty(process, 'platform', descriptor)
})

function windows(focused: boolean) {
  const parent = Object.assign(new EventEmitter(), {
    focused,
    isFocused() { return this.focused },
    getMediaSourceId: () => 'window:77:0',
  })
  const child = Object.assign(new EventEmitter(), {
    visible: false,
    destroyed: false,
    isVisible() { return this.visible },
    isDestroyed() { return this.destroyed },
    showInactive: vi.fn(function () { child.visible = true }),
    moveAbove: vi.fn(function () { child.visible = true }),
    setParentWindow: vi.fn(),
  })
  return { parent, child, show: () => showChildAbove(child as unknown as BrowserWindow, parent as unknown as BrowserWindow) }
}

it('macOS, parent in front: shows as a real child right away', () => {
  onPlatform('darwin')
  const { parent, child, show } = windows(true)
  show()
  expect(child.setParentWindow).toHaveBeenCalledWith(parent)
  expect(child.showInactive).toHaveBeenCalledOnce()
  expect(child.moveAbove).not.toHaveBeenCalled()
})

it('macOS, parent not in front: shows above it without raising it, and becomes a real child once the parent is focused', () => {
  onPlatform('darwin')
  const { parent, child, show } = windows(false)
  show()
  expect(child.moveAbove).toHaveBeenCalledWith('window:77:0')
  expect(child.setParentWindow).toHaveBeenCalledWith(parent)
  expect(child.showInactive).not.toHaveBeenCalled()
  parent.focused = true
  parent.emit('focus')
  expect(child.showInactive).toHaveBeenCalledOnce()
})

it('macOS: a hidden child is not shown when the parent is focused; showing again does not stack listeners; closing releases them', () => {
  onPlatform('darwin')
  const { parent, child, show } = windows(false)
  show()
  show()
  expect(parent.listenerCount('focus')).toBe(1)
  child.visible = false
  parent.emit('focus')
  expect(child.showInactive).not.toHaveBeenCalled()
  child.emit('closed')
  expect(parent.listenerCount('focus')).toBe(0)
})

it.each(['win32', 'linux'])('%s: showInactive as before', (platform) => {
  onPlatform(platform)
  const { child, show } = windows(false)
  show()
  expect(child.showInactive).toHaveBeenCalledOnce()
  expect(child.moveAbove).not.toHaveBeenCalled()
})
