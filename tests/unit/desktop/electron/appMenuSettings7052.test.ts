/**
 * #7052 应用菜单(app-menu.ts):mac「咕咕」那一栏照 Electron 44 默认 appMenu 逐项,只多一项「设置…」⌘,;
 * 锁与不锁只差「视图」那一栏。菜单真的弹出来、点下去开设置,是 electron 运行时行为,在开发实例上读回验过。
 */
import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {},
  Menu: {},
}))

const { applicationMenuTemplate } = await import('../../../../apps/desktop/electron/app-menu')

const build = (platform: NodeJS.Platform, locked: boolean, openSettings = () => {}) =>
  applicationMenuTemplate(platform, { locked, settingsLabel: '设置…', openSettings })

const submenuOf = (item: MenuItemConstructorOptions) => item.submenu as MenuItemConstructorOptions[]
const shape = (items: MenuItemConstructorOptions[]) => items.map((item) => item.role ?? item.label ?? item.type)

describe('mac 应用名那一栏', () => {
  it('关于下面是「设置…」⌘,,其余照默认 appMenu', () => {
    for (const locked of [true, false]) {
      const appMenu = build('darwin', locked)[0]
      expect(appMenu.role).toBe('appMenu')
      expect(shape(submenuOf(appMenu))).toEqual([
        'about', 'separator', '设置…', 'separator', 'services', 'separator', 'hide', 'hideOthers', 'unhide', 'separator', 'quit',
      ])
      expect(submenuOf(appMenu)[2].accelerator).toBe('CmdOrCtrl+,')
    }
  })

  it('点「设置…」= 叫打开设置', () => {
    const openSettings = vi.fn()
    const settings = submenuOf(build('darwin', false, openSettings)[0])[2]
    ;(settings.click as () => void)()
    expect(openSettings).toHaveBeenCalledTimes(1)
  })
})

describe('各栏', () => {
  it('不锁:默认那几栏,「视图」带重载与开发者工具', () => {
    expect(shape(build('darwin', false))).toEqual(['appMenu', 'fileMenu', 'editMenu', 'viewMenu', 'windowMenu'])
    expect(build('darwin', false)[3].submenu).toBeUndefined()
  })

  it('锁了:「视图」只剩缩放与全屏', () => {
    const view = build('darwin', true)[3]
    expect(view.role).toBe('viewMenu')
    expect(shape(submenuOf(view))).not.toContain('reload')
    expect(shape(submenuOf(view))).not.toContain('toggleDevTools')
  })

  it('Windows / Linux 没有应用名那一栏', () => {
    for (const platform of ['win32', 'linux'] as const) {
      for (const locked of [true, false]) expect(shape(build(platform, locked))[0]).toBe('fileMenu')
    }
  })
})
