/**
 * 咕咕 server 的 `electron` 替身(product spec)。
 *
 * server 跑的是**桌面同一份主进程代码**(main.ts),只是没有窗口。它在无头任务宿主那份替身
 * (session/headless/electron-shim.ts)之上补齐主进程顶层会碰到的那一圈:
 *  - `ipcMain`:桌面给渲染进程注册的处理器在 server 上没有人调;这里只记下来(❌ 抛错 —— 无头任务宿主
 *    那份抛错是为了逼会话页走 getHostIpc,而 main.ts 顶层注册的是**给窗口**的处理器,server 没有窗口)。
 *  - `app`:单实例锁、命令行开关、协议注册这些「桌面壳」动作在 server 上是空操作。
 *  - `Tray`:没有托盘。
 */
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import * as headless from '../session/headless/electron-shim'
import { isOwnProcessAlive, SERVER_PROCESS_MARK } from './process-alive'

type Handler = (...args: unknown[]) => unknown

/** 记下 main.ts 注册的处理器。server 没有渲染进程,它们只供测试 / 以后的 AHP 适配层取用。 */
class ServerIpcMain {
  readonly handlers = new Map<string, Handler>()
  readonly listeners = new Map<string, Set<Handler>>()
  handle(channel: string, handler: Handler): void {
    this.handlers.set(channel, handler)
  }
  handleOnce(channel: string, handler: Handler): void {
    this.handlers.set(channel, handler)
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel)
  }
  on(channel: string, listener: Handler): this {
    let set = this.listeners.get(channel)
    if (!set) this.listeners.set(channel, (set = new Set()))
    set.add(listener)
    return this
  }
  once(channel: string, listener: Handler): this {
    return this.on(channel, listener)
  }
  off(channel: string, listener: Handler): this {
    this.listeners.get(channel)?.delete(listener)
    return this
  }
  removeListener(channel: string, listener: Handler): this {
    return this.off(channel, listener)
  }
  removeAllListeners(channel?: string): this {
    if (channel) this.listeners.delete(channel)
    else this.listeners.clear()
    return this
  }
}

export const ipcMain = new ServerIpcMain()

const headlessApp = headless.app as unknown as Record<string, unknown> & NodeJS.EventEmitter

let lockFd: number | null = null

/**
 * 同一个数据目录只允许一个 server。锁文件里写 pid,进程已死的旧锁直接接管 ——
 * 被 kill -9 之后不能让下一次启动永远起不来(见 CLAUDE.md 里那次 mkdir 目录锁的事故)。
 */
function requestSingleInstanceLock(): boolean {
  const lockPath = path.join(headless.app.getPath('userData'), 'server.lock')
  const tryAcquire = (): boolean => {
    try {
      lockFd = fs.openSync(lockPath, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      return false
    }
    try {
      fs.writeSync(lockFd, String(process.pid))
    } catch {
      // #6264 磁盘满:锁文件已建成,进程号写不进。锁照样算拿到,❌ 抛出去让账号进程秒退、无限重启。
    }
    return true
  }
  if (tryAcquire()) return true
  let holder = 0
  try {
    holder = Number(fs.readFileSync(lockPath, 'utf8').trim())
  } catch {
    holder = 0
  }
  // #6264 只认「活着且真是咕咕 server 进程」的持有者:进程号被复用时这把锁不能永远没人敢接。
  // (守护进程被 kill -9 后留下的孤儿账号进程会自己退出,见 server-parent-watch.ts。)
  if (isOwnProcessAlive(holder, SERVER_PROCESS_MARK)) return false
  fs.rmSync(lockPath, { force: true })
  return tryAcquire()
}

function releaseSingleInstanceLock(): void {
  if (lockFd === null) return
  fs.closeSync(lockFd)
  lockFd = null
  fs.rmSync(path.join(headless.app.getPath('userData'), 'server.lock'), { force: true })
}
process.on('exit', releaseSingleInstanceLock)

const serverAppExtras = {
  requestSingleInstanceLock,
  releaseSingleInstanceLock,
  hasSingleInstanceLock: (): boolean => lockFd !== null,
  setPath: (_name: string, _value: string): void => {},
  setName: (_name: string): void => {},
  setAppLogsPath: (target?: string): void => (headlessApp.setAppLogsPath as (t?: string) => void)(target),
  commandLine: {
    appendSwitch: (_name: string, _value?: string): void => {},
    appendArgument: (_value: string): void => {},
    hasSwitch: (_name: string): boolean => false,
    getSwitchValue: (_name: string): string => '',
  },
  setAsDefaultProtocolClient: (): boolean => false,
  removeAsDefaultProtocolClient: (): boolean => false,
  isDefaultProtocolClient: (): boolean => false,
  setAboutPanelOptions: (_options: unknown): void => {},
  setAppUserModelId: (_id: string): void => {},
  setBadgeCount: (_count?: number): boolean => false,
  getPreferredSystemLanguages: (): string[] => {
    const lang = process.env.LANG?.split('.')[0]?.replace('_', '-')
    return lang ? [lang] : []
  },
  getLocale: (): string => process.env.LANG?.split('.')[0]?.replace('_', '-') ?? 'en-US',
  getSystemLocale: (): string => process.env.LANG?.split('.')[0]?.replace('_', '-') ?? 'en-US',
  dock: undefined,
  relaunch: (): void => {},
  exit: (code = 0): void => process.exit(code),
  getGPUFeatureStatus: (): Record<string, string> => ({}),
  isInApplicationsFolder: (): boolean => false,
  showAboutPanel: (): void => {},
}

export const app = new Proxy(headlessApp, {
  get(target, key, receiver) {
    if (key in serverAppExtras) return serverAppExtras[key as keyof typeof serverAppExtras]
    const value = Reflect.get(target, key, receiver)
    return typeof value === 'function' ? value.bind(target) : value
  },
}) as unknown as typeof headless.app & typeof serverAppExtras

/** 没有桌面会话:睡眠/唤醒/锁屏事件一律不发;空闲时间按 0 报(服务器永远「有人在」)。 */
class ServerPowerMonitor extends EventEmitter {
  getSystemIdleTime(): number {
    return 0
  }
  getSystemIdleState(_threshold: number): 'active' {
    return 'active'
  }
  isOnBatteryPower(): boolean {
    return false
  }
  get onBatteryPower(): boolean {
    return false
  }
}
export const powerMonitor = new ServerPowerMonitor()

export const powerSaveBlocker = {
  start: (_type: string): number => 0,
  stop: (_id: number): void => {},
  isStarted: (_id: number): boolean => false,
}

export const screen = Object.assign(new EventEmitter(), {
  getPrimaryDisplay: () => ({ id: 0, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }),
  getAllDisplays: () => [],
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  getDisplayNearestPoint: () => ({ id: 0, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }),
})

export const systemPreferences = Object.assign(new EventEmitter(), {
  getMediaAccessStatus: (_type: string): string => 'not-determined',
  askForMediaAccess: async (_type: string): Promise<boolean> => false,
  isTrustedAccessibilityClient: (_prompt: boolean): boolean => false,
  getUserDefault: (_key: string, _type: string): undefined => undefined,
  isDarkMode: (): boolean => false,
})

export const globalShortcut = {
  register: (_accelerator: string, _callback: () => void): boolean => false,
  unregister: (_accelerator: string): void => {},
  unregisterAll: (): void => {},
  isRegistered: (_accelerator: string): boolean => false,
}

export const crashReporter = {
  start: (_options: unknown): void => {},
  addExtraParameter: (_key: string, _value: string): void => {},
}

export class Tray {
  constructor(_icon?: unknown) {}
  setToolTip(_text: string): void {}
  setTitle(_text: string): void {}
  setImage(_image: unknown): void {}
  setContextMenu(_menu: unknown): void {}
  on(_event: string, _listener: Handler): this {
    return this
  }
  destroy(): void {}
  isDestroyed(): boolean {
    return false
  }
}

export const {
  shell,
  clipboard,
  dialog,
  Menu,
  Notification,
  nativeTheme,
  nativeImage,
  safeStorage,
  session,
  webContents,
  BrowserWindow,
  protocol,
  net,
  MessageChannelMain,
  autoUpdater,
  ClipboardItem,
} = headless

const shim = {
  ...headless.default,
  app,
  ipcMain,
  Tray,
  powerMonitor,
  powerSaveBlocker,
  screen,
  systemPreferences,
  globalShortcut,
  crashReporter,
}

export default shim
