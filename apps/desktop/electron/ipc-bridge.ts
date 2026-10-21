import { ipcMain, type BrowserWindow } from 'electron'
import {
  RENDERER_COMMAND_DOMAINS,
  rendererCommandChannel,
  rendererCommandReadyChannel,
  rendererCommandResultChannel,
  type RendererCommandDomain,
} from '../src/lib/rendererCommandProtocol'
import {
  EXTENSION_INSTALL_CONSENT_METHOD,
  INSTALL_CONSENT_HUMAN_WINDOW_MS,
} from '../src/session/shared/extensions/host-actions'

let _window: BrowserWindow | null = null

interface PendingRendererCommand {
  accept: (result: unknown) => void
  reject: (error: Error) => void
}

interface RendererReadyWaiter {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const RENDERER_COMMAND_TIMEOUT_MS = 30_000

/**
 * 少数几个方法等的是**人**,不是渲染进程,所以它们要一口自己的钟。
 *
 * 这口钟必须**严格长于**渲染端那口 —— 两口一样长(都是 30 秒)时它们会赛跑,而先到的是这口:
 * agent 于是收到异常 `IPC timeout: …`,渲染端建模好的 `outcome: 'timeout'` 永远送不出去。
 * 更糟的是弹窗还挂在屏幕上,人再点也白点:主进程这头的 promise 已经拒了,装不会发生。#4135 实测。
 *
 * ❌ 别改成「统一调大 RENDERER_COMMAND_TIMEOUT_MS」:那会让**所有**渲染端调用的失败信号一起变钝,
 * 而它们等的是进程、不是人,30 秒不回就是真出事了。
 */
const HUMAN_DECISION_TIMEOUT_MS = new Map<string, number>([
  [EXTENSION_INSTALL_CONSENT_METHOD, INSTALL_CONSENT_HUMAN_WINDOW_MS + 30_000],
])

const pendingByDomain = new Map<RendererCommandDomain, Map<string, PendingRendererCommand>>(
  RENDERER_COMMAND_DOMAINS.map((domain) => [domain, new Map()]),
)
const readyDomains = new Set<RendererCommandDomain>()
const readyWaitersByDomain = new Map<RendererCommandDomain, Set<RendererReadyWaiter>>(
  RENDERER_COMMAND_DOMAINS.map((domain) => [domain, new Set()]),
)

interface RendererRpcErrorResult {
  __rendererRpcError: true
  error: string
}

function isRendererRpcErrorResult(result: unknown): result is RendererRpcErrorResult {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { __rendererRpcError?: unknown }).__rendererRpcError === true
  )
}

/** The actual application host registered by main.ts; never infer it from window enumeration order. */
export function getMainWindow(): BrowserWindow | null {
  return _window && !_window.isDestroyed() ? _window : null
}

export function setMainWindow(win: BrowserWindow): void {
  if (_window && _window !== win) {
    rejectReadyWaiters(new Error('Renderer window changed before command channel became ready'))
  }
  _window = win
  resetRendererCommandReadiness('Renderer window changed before command response')
  win.webContents.on(
    'did-start-navigation',
    (_event, _url, _isInPlace, isMainFrame) => {
      if (isMainFrame && _window?.webContents === win.webContents) {
        resetRendererCommandReadiness('Renderer navigated before command response')
      }
    },
  )
  win.on('enter-full-screen', notifyFullScreenChange)
  win.on('leave-full-screen', notifyFullScreenChange)
  win.on('focus', () => {
    notifyFocusChange()
    notifyRendererForeground()
  })
  win.on('blur', notifyFocusChange)
  win.once('closed', () => {
    if (_window !== win) return
    _window = null
    resetRendererCommandReadiness('Renderer closed before command response')
    rejectReadyWaiters(new Error('Renderer closed before command channel became ready'))
  })
}

function rejectPendingCommands(reason: string): void {
  for (const pending of pendingByDomain.values()) {
    for (const request of pending.values()) request.reject(new Error(reason))
    pending.clear()
  }
}

function resetRendererCommandReadiness(reason: string): void {
  readyDomains.clear()
  rejectPendingCommands(reason)
}

function rejectReadyWaiters(error: Error): void {
  for (const waiters of readyWaitersByDomain.values()) {
    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    waiters.clear()
  }
}

function waitForRendererCommandReady(domain: RendererCommandDomain): Promise<void> {
  if (!_window || _window.isDestroyed()) return Promise.reject(new Error('Renderer not ready'))
  if (readyDomains.has(domain)) {
    return Promise.resolve()
  }

  const waiters = readyWaitersByDomain.get(domain)!
  return new Promise((resolve, reject) => {
    const waiter: RendererReadyWaiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        waiters.delete(waiter)
        reject(new Error(`Renderer readiness timeout: ${rendererCommandChannel(domain)}`))
      }, RENDERER_COMMAND_TIMEOUT_MS),
    }
    waiters.add(waiter)
  })
}

function markRendererCommandReady(domain: RendererCommandDomain): void {
  readyDomains.add(domain)
  const waiters = readyWaitersByDomain.get(domain)!
  for (const waiter of waiters) {
    clearTimeout(waiter.timer)
    waiter.resolve()
  }
  waiters.clear()
}

function makeInvoker(
  domain: RendererCommandDomain,
) {
  const pending = pendingByDomain.get(domain)!
  const channel = rendererCommandChannel(domain)
  return async (method: string, params: unknown): Promise<unknown> => {
    await waitForRendererCommandReady(domain)
    return new Promise((resolve, reject) => {
      if (!_window || _window.isDestroyed()) {
        reject(new Error('Renderer not ready'))
        return
      }
      const reqId = Math.random().toString(36).slice(2) + Date.now().toString(36)
      const timer = setTimeout(() => {
        if (pending.has(reqId)) {
          pending.delete(reqId)
          reject(new Error(`IPC timeout: ${channel}/${method}`))
        }
      }, HUMAN_DECISION_TIMEOUT_MS.get(method) ?? RENDERER_COMMAND_TIMEOUT_MS)
      pending.set(reqId, {
        accept: (result) => {
          clearTimeout(timer)
          if (isRendererRpcErrorResult(result)) {
            reject(new Error(result.error))
            return
          }
          resolve(result)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      _window!.webContents.send(channel, { reqId, method, params })
    })
  }
}

const rawInvokeRendererAuth = makeInvoker('auth')

// A response timeout is already the transport's bounded failure signal. Replaying the same command
// without a readiness transition or a rebuilt transport only hides that signal from the host; the
// runtime loop owns any later logical retry after it has observed this failure.
export function invokeRendererAuth(method: string, params: unknown): Promise<unknown> {
  return rawInvokeRendererAuth(method, params)
}

/**
 * Whether the host window is in fullscreen. Read here rather than reported by
 * the renderer: it is a window fact, and a second reporter for one truth just
 * means one of them is stale.
 */
export function isHostWindowFullScreen(): boolean {
  if (!_window || _window.isDestroyed()) return false
  return _window.isFullScreen()
}

const fullScreenListeners = new Set<() => void>()

/**
 * Notifies when the host window enters or leaves fullscreen, so consumers that
 * hand this fact onward can re-publish it. Without this, `isHostWindowFullScreen`
 * would only ever be right at the moment somebody happened to ask.
 */
export function onHostWindowFullScreenChange(listener: () => void): () => void {
  fullScreenListeners.add(listener)
  return () => fullScreenListeners.delete(listener)
}

function notifyFullScreenChange(): void {
  for (const listener of fullScreenListeners) listener()
}

/**
 * Whether the host window is in the foreground. Read here for the same reason
 * fullscreen is: a window fact with one source, so nothing can go stale behind
 * a second reporter.
 *
 * ❌ 不用 `app.isFocused()`——那是「本 app 有任一窗口在前台」,而扩展问的是它所在的
 * 这扇窗。多窗口出现的第一天,前者就会对着一扇背景窗口回答「在前台」。
 */
export function isHostWindowFocused(): boolean {
  if (!_window || _window.isDestroyed()) return false
  return _window.isFocused()
}

const focusListeners = new Set<() => void>()

/** Renderer lifecycle signal used by the auth coordinator after macOS sleep/wake. */
export function notifyRendererForeground(): void {
  if (!_window || _window.isDestroyed()) return
  _window.webContents.send('app:foreground')
}

/** Notifies when the host window gains or loses the foreground. */
export function onHostWindowFocusChange(listener: () => void): () => void {
  focusListeners.add(listener)
  return () => focusListeners.delete(listener)
}

function notifyFocusChange(): void {
  for (const listener of focusListeners) listener()
}

const rawInvokeRendererExtensions = makeInvoker('extensions')

/**
 * Sends one extension host action to the renderer that embeds the surface.
 *
 * `embedderId` is checked rather than used to address: this channel can only
 * reach the window it was set up for, so a surface embedded anywhere else is
 * refused instead of having its action delivered to a renderer that draws a
 * *different* tab strip. ❌ 不做「反正大概率是主窗口」的假设——那会在多窗口出现的
 * 第一天悄悄改错 tab。Refs #2374.
 */
export function invokeRendererExtensions(
  method: string,
  params: unknown,
  embedderId: number,
): Promise<unknown> {
  if (!_window || _window.isDestroyed()) {
    return Promise.reject(new Error('Renderer not ready'))
  }
  if (_window.webContents.id !== embedderId) {
    return Promise.reject(
      new Error('This surface is embedded in a window that has no App command channel'),
    )
  }
  return rawInvokeRendererExtensions(method, params)
}

export function setupRendererCommandIpcHandlers(): void {
  for (const domain of RENDERER_COMMAND_DOMAINS) {
    ipcMain.on(rendererCommandReadyChannel(domain), (event) => {
      if (!_window || event.sender !== _window.webContents) return
      markRendererCommandReady(domain)
    })
    ipcMain.on(
      rendererCommandResultChannel(domain),
      (event, { reqId, result }: { reqId: string; result: unknown }) => {
        if (!_window || event.sender !== _window.webContents) return
        const pending = pendingByDomain.get(domain)!
        const request = pending.get(reqId)
        if (request) {
          pending.delete(reqId)
          request.accept(result)
        }
      },
    )
  }
}
