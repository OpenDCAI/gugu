/**
 * #7199 电脑控制的小条窗口:屏幕底部中间一枚「<谁> 正在操作「<App>」 · 停止」(状态机在 computer-control.ts)。
 *
 * - 不抢焦点(Mac 上是不激活的 panel,showInactive),置顶到全屏之上,每个桌面都在;
 * - 不进截图(setContentProtection):agent 截屏时看不到它,也就点不到它;它是咕咕自己的窗口,电脑控制本来也拒操作咕咕;
 * - 按钮不经 preload:点了就跳到 gugu-computer-bar:stop / :resume,主进程在 will-navigate 里接住、拦下。
 *
 * 样子照会话页浏览器页签的那枚小条(agent-browser-state.tsx 的 AgentBrowserBadge):圆角胶囊、细边、小圆点、幽灵按钮。
 * 颜色取自 apps/desktop/src/styles/tokens.css 的 --card / --fg / --muted-fg / --primary / --border(这页是独立小窗,读不到那份 CSS)。
 */
import { BrowserWindow, screen } from 'electron'
import type { ComputerControlView } from './computer-control'

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
const HEIGHT = 56
const BOTTOM = 28

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
:root { --tint: 268; --card: oklch(0.995 0.002 var(--tint)); --fg: oklch(0.205 0.008 var(--tint)); --muted-fg: oklch(0.556 0.012 var(--tint)); --primary: oklch(0.150 0.008 var(--tint)); --border: color-mix(in oklab, var(--fg) 10%, transparent); --hover: color-mix(in oklab, var(--fg) 8%, transparent); }
@media (prefers-color-scheme: dark) { :root { --card: oklch(0.228 0.016 var(--tint)); --fg: oklch(0.922 0.006 var(--tint)); --muted-fg: oklch(0.639 0.012 var(--tint)); --primary: oklch(0.985 0.004 var(--tint)); } }
html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; -webkit-user-select: none; user-select: none; cursor: default; }
body { display: flex; align-items: center; justify-content: center; font: 12px/1.4 -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", "Microsoft YaHei", sans-serif; }
.bar { display: flex; align-items: center; gap: 8px; max-width: 440px; padding: 4px 4px 4px 12px; border: 1px solid var(--border); border-radius: 999px; background: var(--card); color: var(--fg); box-shadow: 0 4px 16px rgba(0,0,0,.18); }
.dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--muted-fg); }
.bar[data-state=driving] .dot { background: var(--primary); animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .35 } }
.text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
button { flex: none; height: 24px; padding: 0 10px; border: 0; border-radius: 999px; background: transparent; color: var(--fg); font: inherit; cursor: pointer; }
button:hover { background: var(--hover); }
</style></head><body><div class="bar" role="status" data-state="driving"><span class="dot" aria-hidden="true"></span><span class="text"></span><button type="button"></button></div>
<script>
const bar = document.querySelector('.bar'), text = document.querySelector('.text'), button = document.querySelector('button')
let action = 'stop'
window.render = (view) => { bar.dataset.state = view.state; text.textContent = view.text; button.textContent = view.button; action = view.action }
button.addEventListener('click', () => { location.href = 'gugu-computer-bar:' + action })
</script></body></html>`

export function createComputerControlWindow(input: {
  strings(): ComputerBarStrings
  onStop(): void
  onResume(): void
  log?: { warn(fields: Record<string, unknown>, msg: string): void }
}): ComputerControlView {
  let win: BrowserWindow | null = null
  let loaded: Promise<void> | null = null

  const place = (w: BrowserWindow) => {
    const area = screen.getPrimaryDisplay().workArea
    w.setBounds({ x: Math.round(area.x + (area.width - WIDTH) / 2), y: Math.round(area.y + area.height - HEIGHT - BOTTOM), width: WIDTH, height: HEIGHT })
  }

  const ensure = (): { w: BrowserWindow; ready: Promise<void> } => {
    if (win && !win.isDestroyed() && loaded) return { w: win, ready: loaded }
    const w = new BrowserWindow({
      width: WIDTH,
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
      alwaysOnTop: true,
      ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false },
    })
    w.setAlwaysOnTop(true, 'screen-saver')
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
    loaded = w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`).catch((error: unknown) => {
      input.log?.warn({ err: String(error) }, 'computer control bar failed to load')
    })
    return { w, ready: loaded }
  }

  return {
    show(view) {
      const s = input.strings()
      const name = view.callerName || s.someone
      const app = view.app ? view.app.name || s.someApp : undefined
      const payload = view.state === 'driving'
        ? { state: 'driving', text: s.driving(name, app), button: s.stop, action: 'stop' }
        : { state: 'paused', text: s.paused(name, app), button: s.resume, action: 'resume' }
      const { w, ready } = ensure()
      void ready.then(() => {
        if (w.isDestroyed()) return
        void w.webContents.executeJavaScript(`window.render(${JSON.stringify(payload)})`).catch(() => undefined)
        place(w)
        if (!w.isVisible()) w.showInactive()
      })
    },
    hide() {
      if (win && !win.isDestroyed()) win.hide()
    },
  }
}
