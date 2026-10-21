import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, globalShortcut, ipcMain, screen, type BrowserWindowConstructorOptions, type Rectangle } from 'electron'
import { QUICK_CHAT_CHANNELS, QUICK_CHAT_WINDOW_NAME, quickChatAccelerator, type QuickChatState } from '../src/lib/quickChatIpc'
import type { SpecialAuxWindow } from './aux-window'
import { hardenWebPreferences } from './devtools-lock'

/**
 * #7199「快速聊天」的主进程这一半:全局快捷键切换一扇置顶小窗的显隐。
 *
 * 小窗是主窗渲染层 `window.open` 开的同源子窗(lib/quickChatIpc.ts 的名字),这里只管外观、显隐与位置:
 * - 520×680,最小 420×480,最宽 720;无边框、置顶(floating)、不进任务栏、不能最大化 / 全屏;关闭钮与拖动条是界面自己画的。
 * - 再按一次快捷键、按 Esc、点到别处(失焦)= 收起;被人拖过 / 拉过大小 = 钉住,失焦不收(收起后下次再出来又不钉)。
 * - 关窗 = 收起(❌ 销毁:里面画的是主窗那边的界面,销毁就得重开);主窗重载 / 换页时由 aux-window.ts 真关掉,渲染层重开。
 * - 位置记在 userData/quick-chat.json,下次在原处出来(夹在那块屏幕里,四周留 12px);第一次在鼠标所在那块屏幕居中。
 * - 快捷键被别的应用占了:register 返回 false,如实报「没注册上」,❌ 假装生效。开关也记在 quick-chat.json。
 */

const WIDTH = 520
const HEIGHT = 680
const MARGIN = 12

type Saved = { enabled?: boolean; bounds?: Rectangle }

export function quickChatWindowOptions(backgroundColor: string): BrowserWindowConstructorOptions {
  return {
    width: WIDTH,
    height: HEIGHT,
    minWidth: 420,
    minHeight: 480,
    maxWidth: 720,
    show: false,
    frame: false,
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    backgroundColor,
    webPreferences: hardenWebPreferences({
      // 与主窗同进程才拿得到 window.open 的句柄(aux-window.ts 同一条)。
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    }),
  }
}

function clampToDisplay(bounds: Rectangle): Rectangle {
  const area = screen.getDisplayMatching(bounds).workArea
  const width = Math.min(bounds.width, area.width - MARGIN * 2)
  const height = Math.min(bounds.height, area.height - MARGIN * 2)
  const x = Math.min(Math.max(bounds.x, area.x + MARGIN), area.x + area.width - MARGIN - width)
  const y = Math.min(Math.max(bounds.y, area.y + MARGIN), area.y + area.height - MARGIN - height)
  return { x, y, width, height }
}

function centeredOnCursorDisplay(): Rectangle {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  return clampToDisplay({ x: Math.round(area.x + (area.width - WIDTH) / 2), y: Math.round(area.y + (area.height - HEIGHT) / 2), width: WIDTH, height: HEIGHT })
}

export type QuickChat = { auxWindow: SpecialAuxWindow; hide: () => void }

/**
 * 装上快速聊天(一个进程一次)。`mainWindow` 取此刻的主窗(小窗由它的渲染层开、显隐要告诉它);
 * `focusMain` 把主窗叫到前面;`supported = false`(server 模式)= 不注册快捷键,状态如实说做不了。
 */
export function installQuickChat({ mainWindow, focusMain, supported }: { mainWindow: () => BrowserWindow | null; focusMain: () => void; supported: boolean }): QuickChat {
  const file = join(app.getPath('userData'), 'quick-chat.json')
  const read = (): Saved => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Saved
    } catch {
      return {}
    }
  }
  const write = (patch: Saved) => {
    try {
      writeFileSync(file, JSON.stringify({ ...read(), ...patch }))
    } catch {
      // 记不住就照默认;下次再记。
    }
  }
  const accelerator = quickChatAccelerator(process.platform)
  let enabled = supported && read().enabled !== false
  let registered = false
  let win: BrowserWindow | null = null
  let pendingShow = false
  let pinned = false
  let placing = false

  const tellMain = (channel: string, payload?: unknown) => {
    const main = mainWindow()
    if (main && !main.isDestroyed()) main.webContents.send(channel, payload)
  }
  const state = (): QuickChatState => ({ supported, enabled, accelerator, registered })

  const show = () => {
    if (!win || win.isDestroyed()) return
    const saved = read().bounds
    placing = true
    win.setBounds(saved ? clampToDisplay(saved) : centeredOnCursorDisplay())
    placing = false
    pinned = false
    // mac:主窗被 ⌘H 藏着时也要把这扇叫到最前(steal focus)。
    if (process.platform === 'darwin') app.focus({ steal: true })
    win.setAlwaysOnTop(true, 'floating')
    win.show()
    win.focus()
    tellMain(QUICK_CHAT_CHANNELS.visibility, true)
  }
  const hide = () => {
    if (!win || win.isDestroyed() || !win.isVisible()) return
    win.hide()
    tellMain(QUICK_CHAT_CHANNELS.visibility, false)
  }
  const toggle = () => {
    if (win && !win.isDestroyed()) {
      if (win.isVisible() && win.isFocused()) hide()
      else show()
      return
    }
    // 还没开(没登录、主窗刚重载):请主窗开一扇,开好就摆出来;主窗都没有就把主窗叫出来(登录 / 开通在那儿)。
    const main = mainWindow()
    if (!main || main.isDestroyed()) return
    pendingShow = true
    tellMain(QUICK_CHAT_CHANNELS.open)
    setTimeout(() => {
      if (pendingShow && (!win || win.isDestroyed())) {
        pendingShow = false
        focusMain()
      }
    }, 1500)
  }

  const register = () => {
    if (registered) globalShortcut.unregister(accelerator)
    registered = false
    if (!enabled) return
    try {
      registered = globalShortcut.register(accelerator, toggle)
    } catch {
      registered = false
    }
  }

  if (supported) {
    register()
    app.on('will-quit', () => {
      if (registered) globalShortcut.unregister(accelerator)
    })
  }

  ipcMain.handle(QUICK_CHAT_CHANNELS.state, () => state())
  ipcMain.handle(QUICK_CHAT_CHANNELS.setEnabled, (_event, next: unknown) => {
    if (!supported) return state()
    enabled = next === true
    write({ enabled })
    register()
    if (!enabled) hide()
    tellMain(QUICK_CHAT_CHANNELS.changed)
    return state()
  })
  ipcMain.handle(QUICK_CHAT_CHANNELS.hide, () => hide())
  ipcMain.handle(QUICK_CHAT_CHANNELS.openMain, () => {
    hide()
    focusMain()
  })

  const adopt = (child: BrowserWindow) => {
    win = child
    // 关窗 = 收起;真关(主窗重载)走 destroy,不经过这里。
    child.on('close', (event) => {
      event.preventDefault()
      hide()
    })
    child.on('closed', () => {
      if (win === child) win = null
    })
    child.on('blur', () => {
      if (!pinned) hide()
    })
    const remember = () => {
      if (placing || child.isDestroyed()) return
      pinned = true
      write({ bounds: child.getBounds() })
    }
    child.on('moved', remember)
    child.on('resized', remember)
    child.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault()
        hide()
      }
    })
    if (pendingShow) {
      pendingShow = false
      show()
    }
  }

  return { auxWindow: { name: QUICK_CHAT_WINDOW_NAME, options: quickChatWindowOptions, adopt }, hide }
}
