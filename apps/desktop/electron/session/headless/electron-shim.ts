/**
 * 无头任务宿主(headless task host)的 `electron` 替身模块。
 * 宿主复用 session/main 的原代码,构建时用 Vite 别名把 `electron` 指到这里;
 * 进程仍以 ELECTRON_RUN_AS_NODE=1 跑 Electron 二进制,原生模块因此保持 Electron 的 ABI。
 * ipcMain / MessageChannelMain 故意抛错:无头模式的 IPC 必须走注入的 getHostIpc() 抽象。
 */
import { spawn } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readSharedUserDataPointer } from './shared-user-data'

let cachedUserData: string | null = null
/** 上一次解析走的是哪条分支 —— 供启动时打一行,「为什么还是两份数据」才查得出来。 */
let userDataOrigin = 'unresolved'

/**
 * @@@5080 无头宿主的数据目录,三级:
 *   ① `GUGU_TASK_HOST_USER_DATA` —— 显式指定最大,e2e / 隔离实例靠它。
 *   ② 桌面壳留下的指针 —— **同一台机器上两个宿主看同一份会话**(owner 要的「只是换个视窗」)。
 *   ③ `~/.gugu-task-host` —— 这台机器上没装过桌面壳时的独立目录,老行为。
 *
 * ⚠️ ❌ 不去推算 Electron 的默认 userData:那个值取自 `productName`(中文「咕咕」)、打包后可能被改、
 * 还能被 `--user-data-dir` 覆盖。推算错的样子是**静默的** —— 指到另一个空目录,页面一切正常,
 * 只是「还是两份数据」,与没改逐字节相同。所以只读桌面壳写下来的真值。
 */
function userDataDir(): string {
  if (cachedUserData === null) {
    const configured = process.env.GUGU_TASK_HOST_USER_DATA?.trim()
    if (configured) {
      cachedUserData = configured
      userDataOrigin = 'GUGU_TASK_HOST_USER_DATA'
    } else {
      const shared = readSharedUserDataPointer()
      if (shared) {
        cachedUserData = shared
        userDataOrigin = 'desktop-pointer'
      } else {
        cachedUserData = path.join(os.homedir(), '.gugu-task-host')
        userDataOrigin = 'standalone-default'
      }
    }
    fs.mkdirSync(cachedUserData, { recursive: true })
  }
  return cachedUserData
}

/** 解析结果 + 走的哪条分支。启动时打出来,❌ 别让「和桌面版共不共库」变成一件要靠猜的事。 */
export function resolvedUserData(): { path: string; origin: string } {
  return { path: userDataDir(), origin: userDataOrigin }
}

type AppMetric = {
  pid: number
  type: string
  cpu: { percentCPUUsage: number; idleWakeupsPerSecond: number }
  memory: { workingSetSize: number; peakWorkingSetSize: number }
}

class HeadlessApp extends EventEmitter {
  readonly isPackaged = false
  private logsPath: string | null = null
  // file-logger 只在 app.setAppLogsPath 存在时才初始化文件落点;替身缺它 → 无头宿主的结构化日志
  // 静默丢失(2026-09-04 排"反复重连"时发现:连接建立/关闭一条都没落)。默认 <userData>/logs。
  setAppLogsPath(target?: string): void {
    const resolved = target ? path.resolve(target) : path.join(userDataDir(), 'logs')
    fs.mkdirSync(resolved, { recursive: true })
    this.logsPath = resolved
  }
  getPath(name: string): string {
    const root = userDataDir()
    const known: Record<string, string> = {
      logs: this.logsPath ?? path.join(root, 'logs'),
      appData: path.dirname(root),
      temp: os.tmpdir(),
      home: os.homedir()
    }
    return known[name] ?? root
  }
  getVersion = (): string => process.env.GUGU_TASK_HOST_VERSION ?? '0.0.0-headless'
  getName = (): string => 'gugu-task-host'
  getAppPath = (): string => process.env.GUGU_TASK_HOST_APP_PATH ?? process.cwd()
  getAppMetrics(): AppMetric[] {
    const rss = Math.round(process.memoryUsage().rss / 1024)
    const cpu = { percentCPUUsage: 0, idleWakeupsPerSecond: 0 }
    const memory = { workingSetSize: rss, peakWorkingSetSize: rss }
    return [{ pid: process.pid, type: 'Browser', cpu, memory }]
  }
  focus = (_options?: unknown): void => {}
  isReady = (): boolean => true
  whenReady = (): Promise<void> => Promise.resolve()
  quit(): void {
    this.emit('will-quit')
    process.exit(0)
  }
}

export const app = new HeadlessApp()

let cachedKey: Buffer | null = null
let warnedAboutKeyFile = false

function secretKey(): Buffer {
  if (cachedKey !== null) return cachedKey
  const keyPath = path.join(userDataDir(), 'task-host-secret.key')
  if (!warnedAboutKeyFile) {
    warnedAboutKeyFile = true
    process.stderr.write(
      [

      '[无头任务宿主] 注意:凭据没有进系统钥匙串,而是用本地密钥文件加密的(AES-256-GCM)。\n' +
        `密钥文件:${keyPath}\n` +
        '拿到这个文件的人就能解开所有已保存的凭据,请按凭据本身的等级保护它。'
      ].join(' ') + '\n'
    )
  }
  if (fs.existsSync(keyPath)) {
    cachedKey = fs.readFileSync(keyPath)
  } else {
    cachedKey = randomBytes(32)
    fs.writeFileSync(keyPath, cachedKey, { mode: 0o600 })
  }
  return cachedKey
}

/** 密文布局:12 字节 iv | 16 字节 auth tag | 密文本体 */
export const safeStorage = {
  isEncryptionAvailable: (): boolean => true,
  getSelectedStorageBackend: (): string => 'gugu_session_host_file_key',
  encryptString(plainText: string): Buffer {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', secretKey(), iv)
    const body = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), body])
  },
  decryptString(encrypted: Buffer): string {
    const decipher = createDecipheriv('aes-256-gcm', secretKey(), encrypted.subarray(0, 12))
    decipher.setAuthTag(encrypted.subarray(12, 28))
    return Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString(
      'utf8'
    )
  }
}

function openWithPlatformOpener(target: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? (['open', [target]] as const)
      : process.platform === 'win32'
        ? (['cmd', ['/c', 'start', '', target]] as const)
        : (['xdg-open', [target]] as const)
  const child = spawn(command, [...args], { detached: true, stdio: 'ignore' })
  // 打不开(如无 xdg-open)只记日志:未监听的 'error' 事件会把整个宿主进程打死。
  child.on('error', (error) =>
    process.stderr.write(`[headless] opener failed ${command}: ${String(error)}\n`)
  )
  child.unref()
}

export const shell = {
  async openExternal(url: string): Promise<void> {
    openWithPlatformOpener(url)
  },
  async openPath(target: string): Promise<string> {
    openWithPlatformOpener(target)
    return ''
  },
  showItemInFolder: (target: string): void => openWithPlatformOpener(path.dirname(target))
}

type HeadlessNativeImage = {
  toPNG: () => Buffer
  toJPEG: () => Buffer
  isEmpty: () => boolean
  getSize: () => { width: number; height: number }
  toDataURL: () => string
  resize: (options: { width?: number; height?: number; quality?: string }) => HeadlessNativeImage
}

function imageFromBuffer(buffer: Buffer): HeadlessNativeImage {
  return {
    toPNG: () => Buffer.from(buffer),
    toJPEG: () => Buffer.from(buffer),
    isEmpty: () => buffer.length === 0,
    getSize: () => ({ width: 0, height: 0 }),
    toDataURL: () => '',
    // No image decoder here: a resized image is empty. What re-encodes an App's icon (extension-icon.ts) then gets no
    // bytes and the App keeps the generic mark — the App's own bytes are never passed through as if this process wrote them.
    resize: () => imageFromBuffer(Buffer.alloc(0))
  }
}

export const nativeImage = {
  createFromBuffer: (buffer: Buffer): HeadlessNativeImage => imageFromBuffer(buffer),
  createEmpty: (): HeadlessNativeImage => imageFromBuffer(Buffer.alloc(0))
}

let clipboardText = ''

export const clipboard = {
  writeText: async (text: string): Promise<void> => {
    clipboardText = text
  },
  readText: (): string => clipboardText,
  read: async (): Promise<never[]> => [],
  readImage: (): HeadlessNativeImage => nativeImage.createEmpty(),
  availableFormats: (): string[] => []
}

class HeadlessNativeTheme extends EventEmitter {
  readonly shouldUseDarkColors = false
  readonly shouldUseHighContrastColors = false
  themeSource: 'system' | 'light' | 'dark' = 'system'
}

export const nativeTheme = new HeadlessNativeTheme()

type HeadlessNotificationOptions = { title?: string; body?: string; silent?: boolean }

export class Notification {
  static isSupported = (): boolean => false
  readonly options: HeadlessNotificationOptions
  constructor(options: HeadlessNotificationOptions = {}) {
    this.options = options
  }
  show(): void {}
  close(): void {}
  on(_event: string, _listener: (...args: unknown[]) => void): this {
    return this
  }
}

type OpenDialogResult = { canceled: boolean; filePaths: string[] }
type SaveDialogResult = { canceled: boolean; filePath: string | undefined }
type MessageBoxResult = { response: number; checkboxChecked: boolean }

export const dialog = {
  showOpenDialog: async (): Promise<OpenDialogResult> => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async (): Promise<SaveDialogResult> => ({ canceled: true, filePath: undefined }),
  showMessageBox: async (): Promise<MessageBoxResult> => ({ response: 0, checkboxChecked: false }),
  showErrorBox: (_title: string, _content: string): void => {}
}

type HeadlessMenu = { popup: () => void; closePopup: () => void; items: never[] }

export class Menu {
  static setApplicationMenu = (_menu: unknown): void => {}
  static getApplicationMenu = (): null => null
  static buildFromTemplate = (_template: unknown): HeadlessMenu => ({
    popup: () => {},
    closePopup: () => {},
    items: []
  })
}

function createSessionStub() {
  return {
    protocol: {
      isProtocolHandled: (_scheme: string): boolean => false,
      handle: (_scheme: string, _handler: unknown): void => {},
      unhandle: (_scheme: string): void => {}
    },
    clearCache: async (): Promise<void> => {},
    // 无头宿主没有 Chromium 的代理配置:它的代理只能是环境变量,本来就在 process.env 里(systemProxyEnv.ts)。
    resolveProxy: async (_url: string): Promise<string> => 'DIRECT',
    clearStorageData: async (_options?: unknown): Promise<void> => {},
    clearData: async (_options?: unknown): Promise<void> => {},
    setUserAgent: (_userAgent: string): void => {},
    getUserAgent: (): string => 'gugu-task-host',
    setPermissionRequestHandler: (_handler: unknown): void => {},
    setPermissionCheckHandler: (_handler: unknown): void => {},
    webRequest: {
      onBeforeSendHeaders: (_filterOrListener?: unknown, _listener?: unknown): void => {},
      onHeadersReceived: (_filterOrListener?: unknown, _listener?: unknown): void => {}
    },
    getAllExtensions: (): never[] => [],
    loadExtension: async (_path: string, _options?: unknown): Promise<never> => {
      throw new Error('extensions are unavailable in the headless session host')
    },
    removeExtension: (_id: string): void => {}
  }
}

type HeadlessSession = ReturnType<typeof createSessionStub>

const partitionedSessions = new Map<string, HeadlessSession>()

export const session = {
  defaultSession: createSessionStub(),
  fromPartition(partition: string): HeadlessSession {
    let existing = partitionedSessions.get(partition)
    if (existing === undefined) {
      existing = createSessionStub()
      partitionedSessions.set(partition, existing)
    }
    return existing
  }
}

export const webContents = {
  fromId: (_id: number): undefined => undefined,
  getAllWebContents: (): never[] => [],
  getFocusedWebContents: (): null => null
}

export class BrowserWindow {
  constructor(_options?: unknown) {
    throw new Error('BrowserWindow is unavailable in the headless session host')
  }
  static getAllWindows = (): never[] => []
  static getFocusedWindow = (): null => null
  static fromWebContents = (_contents: unknown): null => null
}

export const protocol = {
  registerSchemesAsPrivileged: (_schemes: unknown): void => {},
  handle: (_scheme: string, _handler: unknown): void => {},
  unhandle: (_scheme: string): void => {},
  isProtocolHandled: (_scheme: string): boolean => false
}

export const net = {
  fetch: (...args: Parameters<typeof globalThis.fetch>): Promise<Response> =>
    globalThis.fetch(...args),
  request: (_options: unknown): never => {
    throw new Error('net.request is unavailable in the headless session host — use net.fetch()')
  }
}

function ipcMainUnavailable(): never {
  throw new Error('[headless] electron.ipcMain reached — route through getHostIpc()')
}

export const ipcMain = {
  handle: ipcMainUnavailable,
  on: ipcMainUnavailable,
  once: ipcMainUnavailable,
  off: ipcMainUnavailable,
  removeHandler: ipcMainUnavailable,
  removeListener: ipcMainUnavailable,
  emit: ipcMainUnavailable
}

export class MessageChannelMain {
  constructor() {
    throw new Error(
      '[headless] electron.MessageChannelMain reached — use getHostIpc().createMessageChannel()'
    )
  }
}

// electron-updater 在模块加载时就 new MacUpdater → 取 electron.autoUpdater 并 .on('error')。
// 无头宿主没有更新这回事:给一个不会触发任何事件的空更新器。
class HeadlessAutoUpdater extends EventEmitter {
  setFeedURL(): void {}
  getFeedURL(): string {
    return ''
  }
  checkForUpdates(): void {}
  quitAndInstall(): void {}
}
export const autoUpdater = new HeadlessAutoUpdater()

// Electron 44 的 clipboard.write 走 W3C ClipboardItem;无头下剪贴板只是内存桩,这里只要形状。
export class ClipboardItem {
  readonly types: string[]
  constructor(private readonly items: Record<string, unknown>) {
    this.types = Object.keys(items)
  }
  async getType(type: string): Promise<unknown> {
    return this.items[type]
  }
}

const shim = {
  app,
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
  ipcMain,
  MessageChannelMain,
  autoUpdater,
  ClipboardItem
}

export type HeadlessElectronShim = typeof shim

export default shim
