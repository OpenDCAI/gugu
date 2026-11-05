import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, globalShortcut, ipcMain, screen, type BrowserWindowConstructorOptions, type Rectangle } from 'electron'
import { QUICK_CHAT_CHANNELS, QUICK_CHAT_WINDOW_NAME, quickChatAccelerator, type QuickChatState } from '../src/lib/quickChatIpc'
import type { SpecialAuxWindow } from './aux-window'
import { hardenWebPreferences } from './devtools-lock'
import { createLogger } from './lib/logger'
import { createQuickChatShortcutOwner, quickChatOwnerPort } from './quick-chat-shortcut-owner'

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
 * 拖动一扇窗时,`moved` / `resized` 每秒能来几十次。每一个都往磁盘写一次位置,等于把
 * 主进程的事件循环按住做几十次文件系统往返(拖动时整个 app 都跟着卡)。
 *
 * 所以:拖动期间只留最新的那份位置,这么多毫秒最多写一次。
 */
const REMEMBER_BOUNDS_DELAY_MS = 300

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
  // 这份文件只有这一个模块读写,所以内存里留一份就是它此刻的样子。
  // 读回来一次,之后不必每次写之前都再读一遍磁盘。
  let savedState: Saved = read()
  const write = (patch: Saved) => {
    savedState = { ...savedState, ...patch }
    try {
      writeFileSync(file, JSON.stringify(savedState))
    } catch {
      // 记不住就照默认;下次再记。
    }
  }
  const accelerator = quickChatAccelerator(process.platform)
  let enabled = supported && savedState.enabled !== false
  let registered = false
  let win: BrowserWindow | null = null
  let pendingShow = false
  let pendingTimer: ReturnType<typeof setTimeout> | null = null
  let quitting = false
  const log = createLogger('quick-chat')
  const cancelPending = () => {
    pendingShow = false
    if (pendingTimer) clearTimeout(pendingTimer)
    pendingTimer = null
  }
  let pinned = false
  let placing = false

  // 拖动期间攒下来的最新位置;过一会儿才写下去。
  let pendingBounds: Rectangle | null = null
  let rememberTimer: ReturnType<typeof setTimeout> | null = null

  /** 把攒下的位置写下去(没攒下就什么都不做)。 */
  const flushRememberBounds = () => {
    if (rememberTimer) {
      clearTimeout(rememberTimer)
      rememberTimer = null
    }
    if (!pendingBounds) return
    const bounds = pendingBounds
    pendingBounds = null
    write({ bounds })
  }

  /**
   * 记下最新位置,过一会儿再写下去。
   *
   * 拖动时 `moved` / `resized` 每秒能来几十次,每一个都直接写盘,等于把主进程的事件循环
   * 按住做几十次文件系统往返(拖动时整个 app 都跟着卡)。
   *
   * 所以拖动期间只留最新的那个位置,每 `REMEMBER_BOUNDS_DELAY_MS` 最多写一次:
   * - 拖得很久也不会一个字都不写(每隔一会儿落一次盘,崩了也不至于丢位置);
   * - 拖完之后,最后一个位置一定会在 300ms 内落盘(定时器在,不是靠「拖到结束」触发)。
   */
  const scheduleRememberBounds = (child: BrowserWindow) => {
    if (child.isDestroyed()) return
    pendingBounds = child.getBounds()
    // 已经在等落盘了:这一轮里后来的位置只更新 pendingBounds,不推迟落盘时间。
    if (rememberTimer) return
    rememberTimer = setTimeout(flushRememberBounds, REMEMBER_BOUNDS_DELAY_MS)
  }

  const tellMain = (channel: string, payload?: unknown) => {
    const main = mainWindow()
    if (main && !main.isDestroyed()) main.webContents.send(channel, payload)
  }
  const state = (): QuickChatState => ({ supported, enabled, accelerator, registered })

  const show = () => {
    if (!win || win.isDestroyed()) return
    // 位置可能还攒着没落盘:先写下去,免得下次出来时用的是拖动前的旧位置。
    flushRememberBounds()
    const saved = savedState.bounds
    placing = true
    win.setBounds(saved ? clampToDisplay(saved) : centeredOnCursorDisplay())
    placing = false
    pinned = false
    // mac:主窗被 ⌘H 藏着时也要把这扇叫到最前(steal focus)。
    if (process.platform === 'darwin') app.focus({ steal: true })
    win.setAlwaysOnTop(true, 'floating')
    win.show()
    win.focus()
  }
  const hide = () => {
    // 收起之前把位置落盘:用户拖到一半失焦收起是很常见的操作,下次出来该在拖到的地方。
    flushRememberBounds()
    if (!win || win.isDestroyed() || !win.isVisible()) return
    win.hide()
  }
  const toggle = () => {
    // A callback already queued by the OS must not outlive its registration.
    if (!enabled || !registered || !owner.owns()) return
    if (win && !win.isDestroyed()) {
      if (win.isVisible() && win.isFocused()) hide()
      else show()
      return
    }
    // A background instance without a ready auxiliary window must not steal
    // focus, either now or when its renderer eventually creates that window.
    const main = mainWindow()
    if (!main || main.isDestroyed() || !main.isFocused()) return
    cancelPending()
    pendingShow = true
    tellMain(QUICK_CHAT_CHANNELS.open)
    // Expire the request; never turn a missing auxiliary window into a delayed
    // focusMain(). Explicit "open main" IPC below remains a user action.
    pendingTimer = setTimeout(cancelPending, 1500)
  }

  const register = (owned: boolean) => {
    if (registered) globalShortcut.unregister(accelerator)
    registered = false
    if (!owned) cancelPending()
    if (owned && enabled && !quitting) {
      try { registered = globalShortcut.register(accelerator, toggle) } catch { /* Report actual registration state. */ }
    }
    tellMain(QUICK_CHAT_CHANNELS.changed)
  }
  const owner = createQuickChatShortcutOwner({
    port: quickChatOwnerPort(accelerator),
    onChange: register,
    onError: (error) => log.warn({ err: error }, 'Quick Chat shortcut ownership unavailable'),
  })
  const updateEligibility = () => {
    const main = mainWindow()
    const mainFocused = !!main && !main.isDestroyed() && main.isFocused()
    if (!mainFocused) cancelPending()
    const appFocused = mainFocused || !!win && !win.isDestroyed() && win.isFocused() || BrowserWindow.getFocusedWindow() !== null
    owner.setForeground(appFocused)
    owner.setEnabled(!quitting && enabled && (!!win && !win.isDestroyed() || appFocused))
  }

  if (supported) {
    updateEligibility()
    app.on('browser-window-focus', updateEligibility)
    app.on('browser-window-blur', (_event, window) => {
      if (window === mainWindow()) cancelPending()
      updateEligibility()
    })
    app.on('will-quit', () => {
      quitting = true
      cancelPending()
      owner.dispose()
      flushRememberBounds()
    })
  }

  ipcMain.handle(QUICK_CHAT_CHANNELS.state, () => state())
  ipcMain.handle(QUICK_CHAT_CHANNELS.setEnabled, (_event, next: unknown) => {
    if (!supported) return state()
    enabled = next === true
    write({ enabled })
    if (!enabled) { cancelPending(); hide() }
    updateEligibility()
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
    // Native visibility can change independently of the shortcut (e.g. App activation).
    // Keep the portal's inert state in step with the window itself.
    child.on('show', () => tellMain(QUICK_CHAT_CHANNELS.visibility, true))
    child.on('hide', () => tellMain(QUICK_CHAT_CHANNELS.visibility, false))
    // 关窗 = 收起;真关(主窗重载)走 destroy,不经过这里。
    child.on('close', (event) => {
      event.preventDefault()
      hide()
    })
    child.on('closed', () => {
      // 真关(主窗重载)时位置还没落盘的话,现在就写下去。
      flushRememberBounds()
      if (win === child) {
        win = null
        updateEligibility()
        tellMain(QUICK_CHAT_CHANNELS.visibility, false)
      }
    })
    child.on('blur', () => {
      if (!pinned) hide()
    })
    const remember = () => {
      if (placing || child.isDestroyed()) return
      pinned = true
      scheduleRememberBounds(child)
    }
    child.on('moved', remember)
    child.on('resized', remember)
    child.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault()
        hide()
      }
    })
    updateEligibility()
    if (pendingShow && owner.owns() && registered) {
      cancelPending()
      show()
    } else tellMain(QUICK_CHAT_CHANNELS.visibility, child.isVisible())
  }

  return { auxWindow: { name: QUICK_CHAT_WINDOW_NAME, options: quickChatWindowOptions, adopt }, hide }
}
