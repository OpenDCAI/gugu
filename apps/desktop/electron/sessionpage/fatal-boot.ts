// 会话页起不来 = 应用级顶级错误(owner 2026-07-24 拍板 fail-loud):错误框 + 退出,❌ 半残运行。这里管两件事:
//
// - **被导航打断的不是资源坏了。** 渲染层取会话页资源(EmdashSessionFrame 的 loadEmdashAssets)时页面被导航一次 ——
//   ⌘R、视图 → 重新加载、错误边界的「重新加载」、自动化的 reload —— 进行中的 fetch 被中止,渲染层看到的同样是
//   `TypeError: Failed to fetch`,报上来的 fatalBoot 和资源真坏了一模一样。判断只在主进程这一侧做:报的那份文档
//   要么已经被换下(发送方的帧 detached / null),要么它的主框架已经开始导航去另一份文档、还没提交。这种只记一行、
//   不进 fatal —— 新文档会自己再取一遍;资源真坏了,新文档照样再报,那时才弹。
// - **错误框不能是同步模态。** `dialog.showErrorBox`,以及 mac 上没有父窗口的 `showMessageBox`(Electron 44
//   message_box_mac.mm:没有 parent 就 `[alert runModal]`),都把主线程停在模态循环里:没人点就永远卡着,IPC、导航、
//   日志全停,`process.on('SIGTERM')` 的 JS handler 也轮不到(2026-10-12 macOS 实测)。
//   所以挂成可见主窗口上的 sheet,点了再退出;没有窗口(server、窗口还没建)
//   就只靠已经打出的 FAILED 日志,直接退出。
import type { BaseWindow, Dialog, Event, WebContents, WebContentsDidStartNavigationEventParams, WebFrameMain } from 'electron'

export const FATAL_BOOT_TITLE = '咕咕无法启动:任务页启动失败'

/** Pages whose main frame has started a navigation to another document that has not committed or settled yet. */
const leaving = new WeakSet<Pick<WebContents, 'on'>>()

/** Watch a page's main-frame navigations (the main window's): what `reportFatalBoot` asks about its sender. */
export function watchNavigations(contents: Pick<WebContents, 'on'>): void {
  contents.on('did-start-navigation', (details: Event<WebContentsDidStartNavigationEventParams>) => {
    if (details.isMainFrame && !details.isSameDocument) leaving.add(contents)
  })
  // Committed: the document now on screen is the new one. Stopped loading: committed and loaded, or the navigation
  // went nowhere (cancelled, a download) — either way nothing is on its way out any more.
  contents.on('did-navigate', () => leaving.delete(contents))
  contents.on('did-stop-loading', () => leaving.delete(contents))
}

export interface FatalBootDeps {
  /** The window the error goes on (the main window); null when there is none (server mode, not created yet). */
  window: () => BaseWindow | null
  dialog: Pick<Dialog, 'showMessageBox'>
  exit: (code: number) => void
  /** The sessionpage logger (pino's shape: fields, then the line). */
  log: { warn: (fields: object, line: string) => void; error: (fields: object, line: string) => void }
}

/** Show that the session page cannot start, on the main window, and exit once the person has seen it. */
export function fatalSessionpageBoot(err: unknown, { window, dialog, exit }: FatalBootDeps): void {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
  const win = window()
  if (!win || win.isDestroyed()) {
    exit(1)
    return
  }
  // A sheet needs a visible parent: on a hidden window it could never be dismissed (and without one it runs modal).
  if (!win.isVisible()) win.show()
  void Promise.resolve()
    .then(() => dialog.showMessageBox(win, { type: 'error', message: FATAL_BOOT_TITLE, detail }))
    // No display to show it on (headless CI): the FAILED line already said it.
    .catch(() => undefined)
    .finally(() => exit(1))
}

/**
 * A renderer reported that the session page cannot start (`sessionpage:fatal-boot`: its assets, its module, its bootstrap).
 * Read the sender on receipt —
 * Electron answers null for a frame looked at after it navigated. Returns what was done with it.
 */
export function reportFatalBoot(
  event: { sender: Pick<WebContents, 'on'>; senderFrame: Pick<WebFrameMain, 'detached'> | null },
  message: unknown,
  deps: FatalBootDeps,
): 'navigated' | 'fatal' {
  const frame = event.senderFrame
  if (!frame || frame.detached || leaving.has(event.sender)) {
    deps.log.warn({ message }, 'session page assets interrupted by a navigation — the next page loads them again')
    return 'navigated'
  }
  // The FAILED line comes first: smoke runs and CI read it, and with no window it is the whole report.
  deps.log.error({ message }, 'FAILED — session page renderer assets unavailable')
  // The renderer's own text (its error and stack) is the detail as it is: wrapped in a new Error here, the box said
  // `Error: Error: …` and carried this process's stack under the renderer's.
  fatalSessionpageBoot(String(message), deps)
  return 'fatal'
}
