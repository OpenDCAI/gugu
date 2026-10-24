/**
 * 电脑控制的附着标签:从实际目标窗口顶边长出,跟随移动/缩放(状态机在 computer-control.ts)。
 *
 * - 不抢焦点(Mac 上是不激活的 panel,showInactive),层级紧贴目标窗口,不会压过盖住目标的其他窗口;
 * - 请求系统截图保护(setContentProtection);它是咕咕自己的窗口,电脑控制也拒绝操作咕咕自身;
 * - 按钮不经 preload:点了就跳到 gugu-computer-bar:stop / :resume,主进程在 will-navigate 里接住、拦下。
 *
 * 紧凑的不对称标签贴住窗口顶边;顶边外侧没空间时向内悬挂。
 * 颜色取自 apps/desktop/src/styles/tokens.css 的 --card / --fg / --muted-fg / --primary / --border(这页是独立小窗,读不到那份 CSS)。
 */
import { BrowserWindow, screen } from 'electron'
import type { ComputerControlView } from './computer-control'
import type { CuaToolResult } from './native/cua-client'
import { COMPUTER_HEAD_HEIGHT, COMPUTER_HEAD_WIDTH, computerBarBounds, resolveComputerWindow } from './computer-control-placement'
import { COMPUTER_CONTROL_PAGE } from './computer-control-page'

export interface ComputerBarStrings {
  /** app 缺省 = 没指定 App(查看这台电脑)。 */
  driving(name: string, app?: string): string
  paused(name: string, app?: string): string
  /** 认不出名字的 App 写成这个。 */
  someApp: string
  stop: string
  resume: string
  someone: string
}

const WIDTH = 460
const HEIGHT = COMPUTER_HEAD_HEIGHT
const BOTTOM = 28


export function createComputerControlWindow(input: {
  readWindows(pid: number, signal: AbortSignal): Promise<CuaToolResult>
  strings(): ComputerBarStrings
  onStop(): void
  onResume(): void
  log?: { warn(fields: Record<string, unknown>, msg: string): void }
}): ComputerControlView {
  let win: BrowserWindow | null = null
  let loaded: Promise<void> | null = null
  type View = Parameters<ComputerControlView['show']>[0]
  let current: { view: View; abort: AbortController } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const desktopBounds = () => {
    const area = screen.getPrimaryDisplay().workArea
    return { x: Math.round(area.x + (area.width - WIDTH) / 2), y: Math.round(area.y + area.height - HEIGHT - BOTTOM), width: WIDTH, height: HEIGHT }
  }

  const ensure = (): { w: BrowserWindow; ready: Promise<void> } => {
    if (win && !win.isDestroyed() && loaded) return { w: win, ready: loaded }
    const w = new BrowserWindow({
      width: COMPUTER_HEAD_WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: false,
      ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false },
    })
    // NSPanel starts at the floating level even when Electron's cached
    // isAlwaysOnTop() says false. Explicitly set the native level once.
    w.setAlwaysOnTop(false)
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    w.setContentProtection(true)
    w.webContents.on('will-navigate', (event, url) => {
      event.preventDefault()
      if (url === 'gugu-computer-bar:stop') input.onStop()
      else if (url === 'gugu-computer-bar:resume') input.onResume()
    })
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    w.on('closed', () => {
      if (win === w) {
        win = null
        loaded = null
      }
    })
    win = w
    loaded = w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(COMPUTER_CONTROL_PAGE)}`)
    return { w, ready: loaded }
  }

  const cancel = () => {
    current?.abort.abort()
    current = null
    if (timer) clearTimeout(timer)
    timer = null
  }

  const refresh = async (intent: NonNullable<typeof current>) => {
    try {
      const target = intent.view.app
      let bounds = desktopBounds()
      let mediaSourceId: string | null = null
      let attachment: 'above' | 'inside' | 'floating' = 'floating'
      if (target) {
        const result = await input.readWindows(target.pid, intent.abort.signal)
        if (current !== intent) return
        const matched = result.isError ? null : resolveComputerWindow(result.structuredContent, target)
        const native = matched?.bounds
        // Windows reports physical window pixels; Electron places windows in DIP.
        const rect = native && (process.platform === 'win32' ? screen.screenToDipRect(null, native) : native)
        const placed = rect && computerBarBounds(rect, screen.getDisplayMatching(rect).workArea)
        if (!placed) {
          win?.hide()
          return
        }
        bounds = placed
        attachment = placed.y < rect!.y ? 'above' : 'inside'
        mediaSourceId = `window:${matched!.windowId}:0`
      }
      if (current !== intent) return
      const { w, ready } = ensure()
      await ready
      if (current !== intent || w.isDestroyed()) return
      const view = intent.view
      const s = input.strings()
      const agentName = view.callerName?.trim() || s.someone
      const taskTitle = view.taskTitle?.trim() === agentName ? undefined : view.taskTitle?.trim()
      const name = taskTitle ? `${agentName} · ${taskTitle}` : agentName
      const app = view.app ? view.app.name || s.someApp : undefined
      const payload = view.state === 'driving'
        ? { state: 'driving', text: s.driving(name, app), button: s.stop, action: 'stop' }
        : { state: 'paused', text: s.paused(name, app), button: s.resume, action: 'resume' }
      await w.webContents.executeJavaScript(`window.render(${JSON.stringify({ ...payload, agentName, taskTitle, attachment })})`)
      if (current !== intent || w.isDestroyed()) return
      w.setBounds(bounds)
      if (w.isAlwaysOnTop() !== !target) w.setAlwaysOnTop(!target, 'screen-saver')
      if (!w.isVisible()) w.showInactive()
      if (mediaSourceId) w.moveAbove(mediaSourceId)
    } catch (error) {
      if (current !== intent) return
      win?.hide()
      input.log?.warn({ err: String(error) }, 'computer control indicator could not follow its window')
    } finally {
      if (current === intent) {
        timer = setTimeout(() => { timer = null; void refresh(intent) }, 250)
        timer.unref?.()
      }
    }
  }

  return {
    show(view) {
      if (current && current.view.app?.pid === view.app?.pid && current.view.app?.windowId === view.app?.windowId) {
        current.view = view
        return
      }
      cancel()
      win?.hide()
      current = { view, abort: new AbortController() }
      void refresh(current)
    },
    hide() {
      cancel()
      if (win && !win.isDestroyed()) win.hide()
    },
  }
}
