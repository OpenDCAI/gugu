import { Menu, type MenuItemConstructorOptions } from 'electron'
import { lockedMenuTemplate } from './devtools-lock'

/**
 * 应用菜单 —— 咕咕自己定一份,❌ 交给 Electron 的默认菜单。
 *
 * 默认菜单里没有「设置…」:原型(Agent OS 改版)写的是「设置也能用菜单栏『咕咕 → 设置…』或 ⌘,」,
 * mac 上的应用都把它放在应用名那一栏、「关于」下面(Safari、Chrome、VS Code 一样)。所以 mac 的那一栏
 * 照 Electron 44 默认的 appMenu 逐项读回(2026-10-09:关于 / 服务 / 隐藏 / 隐藏其他 / 全部显示 / 退出)
 * 摆出来,只多插这一项;其余各栏照旧用 role,系统自己翻成当下语言。
 *
 * 锁与不锁(devtools-lock.ts)只差「视图」那一栏:锁了没有重载和开发者工具。两种都走这里,
 * 不然「设置…」只在一种包里有。
 *
 * Windows / Linux 没有应用名那一栏:设置在头像菜单里,⌘, 由渲染层的快捷键接(shortcuts.ts 的 settings)。
 */
export function applicationMenuTemplate(
  platform: NodeJS.Platform,
  { locked, settingsLabel, openSettings }: { locked: boolean; settingsLabel: string; openSettings: () => void },
): MenuItemConstructorOptions[] {
  const appMenu: MenuItemConstructorOptions = {
    role: 'appMenu',
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      // 按下 ⌘, 时 mac 先找菜单里的快捷键,渲染层那条 Mod+, 就收不到了;打开设置是幂等的,两边都接也只开一次。
      { label: settingsLabel, accelerator: 'CmdOrCtrl+,', click: () => openSettings() },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  }
  if (locked) return lockedMenuTemplate(platform, appMenu)
  return [
    ...(platform === 'darwin' ? [appMenu] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]
}

/** 装上(或换语言后重装)应用菜单。要在 app ready **之后**调 —— 菜单是原生资源,ready 前设在部分平台无效。 */
export function applyApplicationMenu(options: Parameters<typeof applicationMenuTemplate>[1]): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate(process.platform, options)))
}
