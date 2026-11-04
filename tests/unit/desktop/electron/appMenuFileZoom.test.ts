/**
 * #1625 应用菜单的缩放三项改走文件缩放:Electron 建好的 MenuItem 的 submenu 只读(mac 启动即崩
 * `Cannot assign to read only property 'submenu'`),这里的桩把 submenu 做成只读、对象冻结,照样复现那次赋值。
 */
import type { MenuItemConstructorOptions } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fileZoomScript } from '../../../../apps/desktop/src/session/shared/preview/file-zoom'

type FakeItem = { role?: string; label: string; accelerator?: string; click?: (...args: unknown[]) => void; readonly submenu?: FakeMenu }
type FakeMenu = { items: FakeItem[] }

const NATIVE_LABELS: Record<string, string> = {
  appMenu: 'Gugu', about: 'About Gugu', services: 'Services', hide: 'Hide Gugu', hideOthers: 'Hide Others', unhide: 'Show All', quit: 'Quit Gugu',
  fileMenu: 'File', editMenu: 'Edit', viewMenu: 'View', windowMenu: 'Window', reload: 'Reload', forceReload: 'Force Reload',
  toggleDevTools: 'Toggle Developer Tools', resetZoom: 'Actual Size', zoomIn: 'Zoom In', zoomOut: 'Zoom Out', togglefullscreen: 'Toggle Full Screen',
}
const DEFAULT_VIEW = ['reload', 'forceReload', 'toggleDevTools', 'separator', 'resetZoom', 'zoomIn', 'zoomOut', 'separator', 'togglefullscreen']
const fakeItems = new WeakSet<object>()

/** 与 Electron 一样:role 展开成带标签的子菜单;建好的项 submenu 只读、整个冻结。 */
function buildFromTemplate(template: Array<MenuItemConstructorOptions | FakeItem>): FakeMenu {
  return {
    items: template.map((entry) => {
      if (fakeItems.has(entry)) return entry as FakeItem
      const options = entry as MenuItemConstructorOptions
      const children = Array.isArray(options.submenu) ? options.submenu
        : options.role === 'viewMenu' ? DEFAULT_VIEW.map((role) => role === 'separator' ? { type: 'separator' as const } : { role: role as MenuItemConstructorOptions['role'] })
          : undefined
      const submenu = children ? buildFromTemplate(children) : undefined
      const item = { role: options.role, label: options.label ?? NATIVE_LABELS[options.role ?? ''] ?? options.type ?? '', accelerator: options.accelerator as string | undefined, click: options.click as FakeItem['click'] }
      Object.defineProperty(item, 'submenu', { value: submenu, enumerable: true, writable: false })
      fakeItems.add(Object.freeze(item))
      return item
    }),
  }
}

const setApplicationMenu = vi.fn<(menu: FakeMenu) => void>()
class FakeBrowserWindow {
  webContents = { executeJavaScript: vi.fn(async (_script: string) => false), getZoomLevel: vi.fn(() => 0), setZoomLevel: vi.fn() }
  isFullScreen() { return false }
  setFullScreen() {}
}

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: FakeBrowserWindow,
  Menu: { buildFromTemplate: (template: never) => buildFromTemplate(template), setApplicationMenu: (menu: FakeMenu) => setApplicationMenu(menu) },
}))

const { applyApplicationMenu } = await import('../../../../apps/desktop/electron/app-menu')

const apply = (platform: NodeJS.Platform, locked: boolean) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  applyApplicationMenu({ locked, settingsLabel: '设置…', openSettings: () => {} })
  return setApplicationMenu.mock.lastCall![0]
}
const view = (menu: FakeMenu) => menu.items.find((item) => item.role === 'viewMenu')!.submenu!.items
const zoomItem = (menu: FakeMenu, label: string) => view(menu).find((item) => item.label === label)!

describe('application menu file zoom (#1625)', () => {
  beforeEach(() => { setApplicationMenu.mockClear(); vi.restoreAllMocks() })

  it('rewrites the template instead of assigning to a built read-only submenu', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      for (const locked of [false, true]) expect(() => apply(platform, locked)).not.toThrow()
    }
  })

  it('zoom roles become plain items with native labels and accelerators; everything else is the built item', () => {
    const native = buildFromTemplate([{ role: 'viewMenu' }])
    const menu = apply('darwin', false)
    expect(menu.items.map((item) => item.role)).toEqual(['appMenu', 'fileMenu', 'editMenu', 'viewMenu', 'windowMenu'])
    expect(view(menu).map((item) => item.role ?? item.label)).toEqual(['reload', 'forceReload', 'toggleDevTools', 'separator', 'Actual Size', 'Zoom In', 'Zoom Out', 'separator', 'togglefullscreen'])
    expect(view(menu).map((item) => item.label)).toEqual(view(native).map((item) => item.label))
    expect(['Actual Size', 'Zoom In', 'Zoom Out'].map((label) => zoomItem(menu, label).accelerator)).toEqual(['CmdOrCtrl+0', 'CmdOrCtrl+Plus', 'CmdOrCtrl+-'])
    expect(menu.items[0].submenu!.items.map((item) => item.label)).toContain('设置…')
  })

  it('a zoom click asks the focused file viewer first, then falls back to window zoom', async () => {
    const window = new FakeBrowserWindow()
    zoomItem(apply('darwin', true), 'Zoom In').click!({}, window, {})
    await vi.waitFor(() => expect(window.webContents.setZoomLevel).toHaveBeenCalledWith(0.5))
    expect(window.webContents.executeJavaScript).toHaveBeenCalledWith(fileZoomScript('zoomIn'))

    const handled = new FakeBrowserWindow()
    handled.webContents.executeJavaScript.mockResolvedValue(true)
    zoomItem(apply('win32', false), 'Actual Size').click!({}, handled, {})
    await vi.waitFor(() => expect(handled.webContents.executeJavaScript).toHaveBeenCalledWith(fileZoomScript('resetZoom')))
    expect(handled.webContents.setZoomLevel).not.toHaveBeenCalled()
  })
})
