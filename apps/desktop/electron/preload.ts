import { contextBridge, ipcRenderer } from 'electron'
import * as ElectronNS from 'electron'
import { installProcessMetricsResponder } from './process-metrics-responder'

import {
  RENDERER_COMMAND_DOMAINS,
  rendererCommandChannel,
  rendererCommandEventName,
  rendererCommandReadyChannel,
  rendererCommandResultChannel,
  type RendererCommandDomain,
} from '../src/lib/rendererCommandProtocol'
import { UI_EVENTS } from '../src/lib/uiEvents'
import { MAIN_UI_EVENTS } from '../src/lib/mainUiEvents'
import { HOST_SYSTEM_LANGUAGES_CHANNEL } from '../shared/host-localization'
import {
  WINDOW_MATERIAL_CHANGED_CHANNEL,
  WINDOW_MATERIAL_GET_CHANNEL,
  WINDOW_THEME_PREFERENCE_CHANNEL,
  type ThemePreferenceValue,
  type WindowMaterial,
} from '../shared/window-material'

installProcessMetricsResponder(ipcRenderer, process, 'main-window')

for (const domain of RENDERER_COMMAND_DOMAINS) {
  ipcRenderer.on(
    rendererCommandChannel(domain),
    (
      _event,
      payload: { reqId: string; method: string; params: unknown },
    ) => {
      window.dispatchEvent(new CustomEvent(rendererCommandEventName(domain), { detail: payload }))
    },
  )
}

// main → renderer 的界面事件:主进程按 MAIN_UI_EVENTS 的定义发,这里按同一份定义转成 window 上同名键的 UI_EVENTS。
for (const key of Object.keys(MAIN_UI_EVENTS) as (keyof typeof MAIN_UI_EVENTS)[]) {
  ipcRenderer.on(MAIN_UI_EVENTS[key].name, (_event, payload: unknown) => {
    window.dispatchEvent(new CustomEvent(UI_EVENTS[key], { detail: payload }))
  })
}

// Main emits this after a window focus or system wake. Keep it as a narrow lifecycle
// signal; auth ownership and refresh policy remain in the renderer SessionCoordinator.
ipcRenderer.on('app:foreground', () => {
  window.dispatchEvent(new Event('gugu:app-foreground'))
})

function sendRendererCommandResult(domain: RendererCommandDomain, reqId: string, result: unknown): void {
  ipcRenderer.send(rendererCommandResultChannel(domain), { reqId, result })
}

function sendRendererCommandReady(domain: RendererCommandDomain): void {
  ipcRenderer.send(rendererCommandReadyChannel(domain))
}

// @@@sessionpage BOOT lane — the session-page renderer reaches its main-process host through a GENERIC
// `window.electronAPI` surface: `invoke`/`eventSend`/`eventOn`/`getPathForFile`/`requestWirePort`. We
// merge those five members into gugu's EXISTING `electronAPI` object (below) so both APIs coexist on one
// bridge — gugu's colon-namespaced channels (`updates:check`, `window:*`) and the session page's dot-namespaced RPC
// channels (`viewState.getAll`, `projects.getProjects`) route disjointly through the same
// `ipcRenderer.invoke`; gugu's named wrappers are untouched (additive keys, no collisions).

// The desktop package runs Electron >=30, where webUtils is the supported file-path API.
const electronWebUtils = (ElectronNS as { webUtils?: { getPathForFile(file: File): string } }).webUtils
function emdashGetPathForFile(file: File): string {
  if (!electronWebUtils) {
    throw new Error('[sessionpage] electron.webUtils is required by the desktop Electron runtime')
  }
  return electronWebUtils.getPathForFile(file)
}

// Inlined wire-port request (mirrors @gugu/session-wire/api requestWirePort, kept out of the preload build so
// preload stays lean). Bridges a MessageChannelMain port from main into the DOM: `ipcRenderer.once` grabs
// the transferred port from main's `event.sender.postMessage('<ch>:port', …, [port2])`, then re-posts it
// into the shared DOM window so the session-page app-world's `awaitWirePort` `message` listener receives it.
function emdashRequestWirePort(channel: string): Promise<void> {
  const portChannel = `${channel}:port`
  const connectChannel = `${channel}:connect`
  return new Promise<void>((resolve, reject) => {
    const listener = (event: Electron.IpcRendererEvent, value: unknown): void => {
      try {
        const port = (event as unknown as { ports?: unknown[] }).ports?.[0] ?? value
        window.postMessage({ kind: portChannel }, '*', [port] as unknown as Transferable[])
        resolve()
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
    ipcRenderer.once(portChannel, listener)
    Promise.resolve(ipcRenderer.invoke(connectChannel)).catch((error: unknown) => {
      ipcRenderer.removeListener(portChannel, listener)
      reject(error instanceof Error ? error : new Error(String(error)))
    })
  })
}

contextBridge.exposeInMainWorld('electronAPI', {
  // @@@sessionpage — generic RPC/event/wire surface the session-page renderer expects (additive).
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> => ipcRenderer.invoke(channel, ...args),
  eventSend: (channel: string, data: unknown): void => ipcRenderer.send(channel, data),
  eventOn: (channel: string, cb: (data: unknown) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, data: unknown): void => cb(data)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  },
  getPathForFile: emdashGetPathForFile,
  requestWirePort: emdashRequestWirePort,
  selectDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:select-directory'),
  selectFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:select-file'),
  checkForUpdates: (): Promise<unknown> => ipcRenderer.invoke('updates:check'),
  updateState: (): Promise<unknown> => ipcRenderer.invoke('updates:state'),
  downloadUpdate: (): Promise<unknown> => ipcRenderer.invoke('updates:download'),
  installUpdate: (): Promise<unknown> => ipcRenderer.invoke('updates:install'),
  // @@@5758 更新说明走主进程取:渲染层 origin 跨源,下载站不发 CORS 头,fetch 会被拦。
  fetchChangelog: (): Promise<unknown> => ipcRenderer.invoke('updates:changelog'),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),
  getFeedbackLogTail: (): Promise<unknown> => ipcRenderer.invoke('feedback:log-tail'),
  getAgentCreationTools: (): Promise<unknown> => ipcRenderer.invoke('agent-creation-tools:list'),
  openAgentRuntime: (agentUserId: string): Promise<unknown> => ipcRenderer.invoke('agent-runtime:open', agentUserId),
  writeClipboardText: (value: string): Promise<boolean> => ipcRenderer.invoke('clipboard:write-text', value),
  showNotification: (payload: { title: string; body?: string; chatId?: string | null; silent?: boolean }): Promise<unknown> => {
    return ipcRenderer.invoke('notifications:show', payload)
  },
  writeHumanAuthSession: (session: unknown): Promise<void> => ipcRenderer.invoke('human-auth-session:write', session),
  clearHumanAuthSession: (reason: 'signed-out' | 'lost'): Promise<void> => ipcRenderer.invoke('human-auth-session:clear', reason),
  // #5906 —— 渲染层把一条设备命令放回 pending 之后说一声(见 main.ts 的同名通道)。
  notifyDeviceCommandsChanged: (): void => ipcRenderer.send('device-runtime:commands-changed'),
  // #6396 —— 渲染层收到 agent_changed(本账号的 agent 有变动)后说一声,主进程据此刷新起名用的号(见 main.ts 同名通道)。
  notifyOwnedAgentsChanged: (): void => ipcRenderer.send('owned-agents:changed'),
  // @@@2374 — 按域名通用,❌ 不再一域一对方法。原来只有 `auth` 那一对,`extensions` 域
  // 因此在渲染层根本发不出「我准备好了」,主进程于是永远等到超时 —— 扩展的每个宿主动作
  // (改标题/角标、开浏览器 tab、报错、投进对话)都死在这里,而 platform 侧那句
  // `commandReadySender(domain)?.()` 把缺失的那一半悄悄吞了,连报错都没有。
  rendererCmdResult: (domain: RendererCommandDomain, reqId: string, result: unknown): void => {
    sendRendererCommandResult(domain, reqId, result)
  },
  rendererCmdReady: (domain: RendererCommandDomain): void => {
    sendRendererCommandReady(domain)
  },
  setBadge: (count: number): void => {
    ipcRenderer.send('set-badge', count)
  },
  // @@@5295 托盘数字角标的开关(app 设置 · 通用)。渲染层持有偏好,主进程只被告知。
  setTrayBadgeEnabled: (enabled: boolean): void => {
    ipcRenderer.send('set-tray-badge-enabled', enabled)
  },
  syncResolvedLocale: async (locale: 'zh-CN' | 'en-US'): Promise<void> => {
    await ipcRenderer.invoke('locale:sync-resolved', locale)
  },
  // @@@window-tone — 无边框窗口露出来的那块底色要跟着咕咕的主题走(见 main.ts 同名注释)。
  // 用 send 不用 invoke:它在首帧前就要发一次,不该让渲染阻塞等主进程应答。
  syncWindowTone: (tone: 'light' | 'dark'): void => {
    ipcRenderer.send('window:sync-tone', tone)
  },
  // @@@native-appearance (#7333) 偏好原样给主进程(mac 上照抄成 nativeTheme.themeSource),同步答回此刻的真实明暗 ——
  // 切回「跟随系统」时 renderer 用这个答案落主题,不先拿旧的 matchMedia 画错一帧。主进程同步失败答 null。
  syncThemePreference: (preference: ThemePreferenceValue): 'light' | 'dark' | null =>
    ipcRenderer.sendSync(WINDOW_THEME_PREFERENCE_CHANNEL, preference),
  relaunchApp: (): Promise<void> => ipcRenderer.invoke('app:relaunch'),
  onAppForeground: (callback: () => void): (() => void) => {
    const listener = () => callback()
    window.addEventListener('gugu:app-foreground', listener)
    return () => window.removeEventListener('gugu:app-foreground', listener)
  },
  // App 在不在前台(main.ts @@@app-active):先答一次当下,之后每次变化再答。
  subscribeAppActive: (callback: (active: boolean) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, active: boolean): void => callback(active)
    ipcRenderer.on('app:active-changed', listener)
    void ipcRenderer.invoke('app:is-active').then(callback)
    return () => ipcRenderer.removeListener('app:active-changed', listener)
  },
  getLocalDeviceSelfSnapshot: (): Promise<unknown> => ipcRenderer.invoke('device:get-self-snapshot'),
  // @@@4526 owner 删除自己的 agent 后释放它在本机的足迹(花名册 / runtime session / 投递注册)。
  releaseOwnedAgentLocalFootprint: (agentUserId: string): Promise<unknown> =>
    ipcRenderer.invoke('owned-agent:release-local-footprint', { agentUserId }),
  // @@@share-card-rename 改名的本机那半:花名册上的 name(会话页读它)。云端改完再调,详见 main 侧同名注释。
  renameOwnedAgentLocalFootprint: (agentUserId: string, name: string): Promise<boolean> =>
    ipcRenderer.invoke('owned-agent:rename-local-footprint', { agentUserId, name }),
})

// @@@host-system-languages — 宿主真实系统语言。同步取值:renderer 的 i18n runtime 是模块副作用,在第一帧
// 之前就要解析「跟随系统」,拿不到值就只能退回 navigator.languages,而那个列表在 Electron 里首项是 Chromium
// 界面语言(中文 macOS 实测 ['en-US','zh-Hans-CN'])→ 中文系统显示英文。
// ❌ 不给缺应答兜底:preload 只在 Electron 下加载,通道必被 main 应答,`undefined` 只可能是接线断了
// (单边改名 / handler 被移到 whenReady 之后 / handler 抛错)。兜成空数组会让 renderer 悄悄退回
// navigator 那份 —— 那正是本 bug 本体,且全套测试照样绿。fail loud,别静默降级。
// 空数组本身是合法答案(宿主确实没给出偏好语言),由 renderer 侧按 spec 回落。
function readHostSystemLanguages(): readonly string[] {
  const answer: unknown = ipcRenderer.sendSync(HOST_SYSTEM_LANGUAGES_CHANNEL)
  if (!Array.isArray(answer)) {
    throw new Error(
      `[localization] main did not answer ${HOST_SYSTEM_LANGUAGES_CHANNEL} (got ${typeof answer}); `
      + 'refusing to fall back to Chromium navigator languages',
    )
  }
  return Object.freeze([...answer] as string[])
}

contextBridge.exposeInMainWorld('guguHostLocale', {
  // 首帧种子:preload 加载时已同步取好,renderer 启动时零 IPC 等待。
  systemLanguages: readHostSystemLanguages(),
  // 宿主语言在 app 运行期变化时重新问一次 —— 首帧种子是快照,不刷新的话 renderer 的
  // languagechange 监听在桌面上会退化成一个永远算出同一个值的空动作。
  readSystemLanguages: readHostSystemLanguages,
})

// @@@822 frameless 自绘标题栏: Windows/Linux 无原生边框,窗口控制(最小化/最大化/关闭)走这里。
// Mac 用原生交通灯(titleBarStyle:hiddenInset),不经此桥。通道名与 main 的 ipcMain handlers 对齐。
contextBridge.exposeInMainWorld('desktopWindow', {
  minimize: (): void => ipcRenderer.send('window:minimize'),
  maximize: (): void => ipcRenderer.send('window:maximize'),
  close: (): void => ipcRenderer.send('window:close'),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:isMaximized'),
  // Windows 标题栏「编辑 / 视图」菜单;命令清单由 main 的 window-menu-commands.ts 把关。
  runMenuCommand: (command: string): void => ipcRenderer.send('window:menu-command', command),
  getChromeLabels: (): {
    minimize: string
    maximize: string
    restore: string
    close: string
  } => ipcRenderer.sendSync('window-chrome:get-labels'),
  onChromeLabelsChange: (callback: (labels: {
    minimize: string
    maximize: string
    restore: string
    close: string
  }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, labels: {
      minimize: string
      maximize: string
      restore: string
      close: string
    }): void => callback(labels)
    ipcRenderer.on('window-chrome:labels-changed', handler)
    return () => ipcRenderer.removeListener('window-chrome:labels-changed', handler)
  },
  // 订阅最大化状态变化(main 在 maximize/unmaximize 时推送);返回取消订阅函数。
  onMaximizedChange: (callback: (maximized: boolean) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, maximized: boolean): void => callback(maximized)
    ipcRenderer.on('window:maximized-changed', handler)
    return () => ipcRenderer.removeListener('window:maximized-changed', handler)
  },
  // @@@window-material (#7333) 窗口材质的判定在主进程(shared/window-material.ts);同步读是因为首帧前就要落属性。
  getMaterial: (): WindowMaterial => ipcRenderer.sendSync(WINDOW_MATERIAL_GET_CHANNEL),
  onMaterialChange: (callback: (material: WindowMaterial) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, material: WindowMaterial): void => callback(material)
    ipcRenderer.on(WINDOW_MATERIAL_CHANGED_CHANNEL, handler)
    return () => ipcRenderer.removeListener(WINDOW_MATERIAL_CHANGED_CHANNEL, handler)
  },
})
