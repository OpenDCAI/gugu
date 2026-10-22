import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { app } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { hideChild, showChildAbove } from '../../../../apps/desktop/electron/child-window'

/**
 * #77 agent 浮层 / 构建角标这类小子窗:只用标准做法(showInactive)挂成真正的原生子窗,父窗被提前时不沉下去;
 * macOS 上 showInactive 会把整个 App 提到别的 App 前面(electron#49393)⇒ 只在父窗就是前台窗口时露出,不是就等人回来。
 */

vi.mock('electron', async () => ({ app: new (await import('node:events')).EventEmitter() }))

/** 等着露出的子窗挂在父窗 / App 上的监听都放掉了。 */
function released(parent: EventEmitter, child: EventEmitter) {
  expect(parent.listenerCount('focus')).toBe(0)
  expect(parent.listenerCount('sheet-end')).toBe(0)
  expect(app.listenerCount('did-become-active')).toBe(0)
  expect(child.listenerCount('closed')).toBe(0)
}

const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const onPlatform = (platform: string) => Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
afterEach(() => {
  Object.defineProperty(process, 'platform', descriptor)
})

function windows(focused: boolean) {
  const parent = Object.assign(new EventEmitter(), {
    focused,
    destroyed: false,
    isFocused() { return this.focused },
    isDestroyed() { return this.destroyed },
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
    hide: vi.fn(function () { child.visible = false }),
  })
  let wanted = true
  return {
    parent,
    child,
    setWanted: (value: boolean) => { wanted = value },
    show: () => showChildAbove(child as unknown as BrowserWindow, parent as unknown as BrowserWindow, () => wanted),
    hide: () => hideChild(child as unknown as BrowserWindow),
    comeBack: () => { parent.focused = true; parent.emit('focus') },
  }
}

it('macOS, the person is looking at the app window: shows it as a real child right away', () => {
  onPlatform('darwin')
  const { parent, child, show } = windows(true)
  show()
  expect(child.setParentWindow).toHaveBeenCalledWith(parent)
  expect(child.showInactive).toHaveBeenCalledOnce()
  expect(child.moveAbove).not.toHaveBeenCalled()
})

it('macOS, the app is in the background: shows nothing (showInactive would raise it above other apps) until the person comes back', () => {
  onPlatform('darwin')
  const { parent, child, show, comeBack } = windows(false)
  show()
  expect(child.showInactive).not.toHaveBeenCalled()
  expect(child.moveAbove).not.toHaveBeenCalled()
  parent.emit('focus') // became main but not key: still not in front
  expect(child.showInactive).not.toHaveBeenCalled()
  comeBack()
  expect(child.showInactive).toHaveBeenCalledOnce()
  released(parent, child)
})

it('macOS: the app becoming active with this window in front also shows it', () => {
  onPlatform('darwin')
  const { parent, child, show } = windows(false)
  show()
  parent.focused = true
  app.emit('did-become-active')
  expect(child.showInactive).toHaveBeenCalledOnce()
  released(parent, child)
})

it('macOS: a dialog sheet on the parent held the focus; when it closes the child shows (the parent reports no new focus)', () => {
  onPlatform('darwin')
  const { parent, child, show } = windows(false)
  show()
  parent.focused = true
  parent.emit('sheet-end')
  expect(child.showInactive).toHaveBeenCalledOnce()
  released(parent, child)
})

it('macOS: asked again once the parent is in front: shows at once and drops the wait', () => {
  onPlatform('darwin')
  const { parent, child, show } = windows(false)
  show()
  parent.focused = true
  show()
  expect(child.showInactive).toHaveBeenCalledOnce()
  released(parent, child)
})

it('macOS: not wanted any more by the time the person comes back (tab switched away) — stays hidden', () => {
  onPlatform('darwin')
  const { parent, child, show, setWanted, comeBack } = windows(false)
  show()
  setWanted(false)
  comeBack()
  expect(child.showInactive).not.toHaveBeenCalled()
  released(parent, child)
})

it('macOS: hiding while waiting cancels the wait; asking again does not stack listeners; closing releases them', () => {
  onPlatform('darwin')
  const { parent, child, show, hide, comeBack } = windows(false)
  show()
  show()
  expect(parent.listenerCount('focus')).toBe(1)
  hide()
  expect(child.hide).toHaveBeenCalledOnce()
  comeBack()
  expect(child.showInactive).not.toHaveBeenCalled()
  parent.focused = false
  show()
  child.emit('closed')
  released(parent, child)
})

it('hiding always hides (a minimised parent orders the child out but it would come back on restore)', () => {
  onPlatform('darwin')
  const { child, hide } = windows(true)
  hide()
  expect(child.hide).toHaveBeenCalledOnce()
})

it.each(['win32', 'linux'])('%s: showInactive as before', (platform) => {
  onPlatform(platform)
  const { child, show } = windows(false)
  show()
  expect(child.showInactive).toHaveBeenCalledOnce()
  expect(child.moveAbove).not.toHaveBeenCalled()
})
