/**
 * #7199 第二步在主进程里的那一份:授权(本机)、各动作族、被调用方的收发(DeviceActionHost)、设置页的 IPC。
 * 一个进程只有一份 —— 设备 RPC 频道断了重订(处理器按频道重建)也还是同一份,在跑的调用、待重推的结果不丢。
 */
import os from 'node:os'
import path from 'node:path'
import type { IpcMain } from 'electron'
import enSettings from '@/i18n/locales/en-US/settings'
import zhSettings from '@/i18n/locales/zh-CN/settings'
import {
  DEVICE_ACTION_RESULT_ACK_RPC_TYPE,
  DEVICE_ACTION_RPC_TYPE,
  deviceScopeError,
  type DeviceActionsCapability,
} from '@gugu/core/shared/deviceActions'
import { createDeviceActionHost, type DeviceActionHost } from '@gugu/core/cloud/deviceActionHost'
import type { DeviceRpcHandlers } from '@gugu/core/cloud/deviceRpcResponder'
import type { DeviceRpcResponse } from '@gugu/core/cloud/deviceRpcProtocol'
import {
  DEVICE_ACTIONS_CHANNELS,
  type DeviceActionsConnectResult,
  type DeviceActionsState,
} from '../../src/lib/deviceActionsIpc'
import type { ActionFamily, FamilyDeps, Outcome, SelfApp } from './catalog'
import { createComputerControl, type ComputerControl, type ComputerControlView } from './computer-control'
import { createAllFamilies } from './families'
import { peekWindow } from './families/computer'
import { createDeviceActionGrantsStore, defaultDeviceActionGrantsFile } from './grants-store'
import { execFileAsync, runJxa } from './mac-scripts'
import { createCuaClient, type CuaClient } from './native/cua-client'
import { createMacHelperClient, type MacHelperClient } from './native/mac-helper-client'
import { createDeviceActionsProvider } from './provider'

type Log = { info(fields: Record<string, unknown>, msg: string): void; warn(fields: Record<string, unknown>, msg: string): void }

/** 主进程注入的、只有 Electron 才有的能力。 */
export type ElectronDeviceDeps = Pick<FamilyDeps, 'clipboardRead' | 'clipboardWrite' | 'clipboardReadImage' | 'notify' | 'openExternal' | 'trashItem' | 'captureScreen' | 'shrinkImage' | 'sampleImage'>

export interface DeviceActionsRuntime {
  capability(): DeviceActionsCapability | null
  /** 挂进这台设备的设备 RPC 处理器(主账号那条频道)。 */
  rpcHandlers(): DeviceRpcHandlers
  /** 本机自己调本机(agent 跑在这台电脑上):不经频道(频道 self:false,自己发的收不到),直接交给同一个 host。 */
  callLocal(type: string, payload: unknown): Promise<DeviceRpcResponse<unknown>>
  /** 本机自调时,host 推的事件也交给这里(调用方的 onEvent)。 */
  setLocalEventSink(sink: ((payload: unknown) => void) | null): void
  /**
   * 咕咕自己读一次(#7199 会议提醒读日历):照样过授权(那一组没连上 / 系统权限没给 = 不读,回原因),
   * 不经命令频道、不进「最近调用」(那是给人看 agent 动过什么的)。只给只读的动作用。
   */
  readLocal(action: string, args: Record<string, unknown>): Promise<Outcome>
  /** #7317 一张窗口的只读画面,给「电脑」页签(见 families/computer 的 peekWindow)。 */
  peekWindow(target: { pid: number; window_id: number }, options: { maxDimension: number; signal?: AbortSignal; viewer?: string; cursorSession?: string }): Promise<Outcome>
  registerIpc(ipcMain: IpcMain, getWindows: () => Array<{ isDestroyed(): boolean; webContents: { send(channel: string): void } }>): void
  /** 授权变了,或开关在 App 上的那一组随 App 开关了(之后要重新登记这台电脑的动作)。 */
  onGrantsChanged(listener: () => void): () => void
  /** 那个 App 装上 / 卸掉 / 启用 / 停用了(`appSwitch`):重新登记、刷新设置页;关了就停掉它的原生程序。 */
  switchChanged(): void
  /** 电脑控制小条上的「停止」「让它继续」(没传 computerControlView 时为 null)。 */
  computerControl: ComputerControl | null
  dispose(): void
}

/**
 * 拦下调用时告诉调用方的分组名 = 设置页上的那个名字。中英都给:调用方转述给人时,人看哪种语言的界面都对得上。
 * 名字只此一份(settings 文案表),❌ 主进程另写一份。
 */
function groupTitle(id: string): string {
  const key = id.replace('.', '_')
  const zh = (zhSettings.devices.deviceActions.group as Record<string, string>)[key]
  const en = (enSettings.devices.deviceActions.group as Record<string, string>)[key]
  return zh && en ? `${zh} / ${en}` : id
}

/**
 * 原生组件在哪:Mac 打包后在 Resources/mac-native、开发时在仓库根的 mac-native/<arch>(scripts/build-mac-native.mjs);
 * Windows 是 win-native(scripts/build-win-native.mjs)。别的平台没有。
 */
export function nativeComponentsDir(input: { platform?: NodeJS.Platform; isPackaged: boolean; resourcesPath: string; appPath: string }): string | null {
  const platform = input.platform ?? process.platform
  const dir = platform === 'darwin' ? 'mac-native' : platform === 'win32' ? 'win-native' : null
  if (!dir) return null
  return input.isPackaged ? path.join(input.resourcesPath, dir) : path.join(input.appPath, dir, process.arch)
}

export function createDeviceActionsRuntime(input: {
  userData: string
  deviceId(): Promise<string>
  deps: ElectronDeviceDeps
  /** 原生组件目录(见 nativeComponentsDir);没有时为 null。 */
  nativeDir: string | null
  isPackaged: boolean
  appVersion: string
  /** 咕咕 server(无界面,云电脑):不登记任何动作 —— 它不是谁的电脑,没有人能在它上面点「连接」。 */
  serverMode: boolean
  openSystemSettings(url: string): Promise<void>
  /** 咕咕自己(电脑控制不许 agent 操作它)。 */
  selfApp?(): SelfApp
  /** 电脑控制的「正在操作 · 停止」小条(main 里的置顶小窗);没有就不显示、也就没有接管。 */
  computerControlView?: ComputerControlView
  /** 告诉 cua-driver 宿主是谁(只是它日志里的一个标签)。 */
  hostBundleId?: string
  /**
   * 开关在一个 App 上的那一组(#7317:电脑控制 ↔ Computer Use,behavior tab-extensions「Computer Use 是电脑控制的开关」):
   * App 开着这一组就连上了;关着这台电脑就没有它。设置页不再列它(❌ 两个开关),由那个 App 的页面办系统授权。
   */
  appSwitch?: { group: string; app: string; on(): boolean }
  log: Log
  /** 测试注入。 */
  families?: ActionFamily[]
  platform?: NodeJS.Platform
}): DeviceActionsRuntime {
  const store = createDeviceActionGrantsStore(defaultDeviceActionGrantsFile(input.userData))
  const missing = input.isPackaged
    ? '这台电脑上的咕咕缺原生组件（安装包不完整），请重新安装咕咕'
    : `开发环境还没编原生组件:在仓库根运行 node scripts/${(input.platform ?? process.platform) === 'win32' ? 'build-win-native' : 'build-mac-native'}.mjs`
  const platform = input.platform ?? process.platform
  let helper: MacHelperClient | null = null
  let cua: CuaClient | null = null
  const nativeBinary = (name: string) => (input.nativeDir ? path.join(input.nativeDir, name) : null)
  const makeHelper = () => (helper ??= createMacHelperClient({ binary: nativeBinary('gugu-mac-helper'), missingMessage: missing, log: input.log }))
  const makeCua = () => (cua ??= createCuaClient({
    binary: nativeBinary(platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'),
    missingMessage: missing,
    clientVersion: input.appVersion,
    home: path.join(input.userData, 'cua-driver'),
    platform,
    sampleImage: input.deps.sampleImage,
    ...(input.hostBundleId ? { hostBundleId: input.hostBundleId } : {}),
    log: input.log,
  }))
  const computerControl: ComputerControl | null = input.computerControlView
    ? createComputerControl({ view: input.computerControlView })
    : null
  const deps: FamilyDeps = {
    ...input.deps,
    platform,
    nativeDir: input.nativeDir,
    now: () => new Date(),
    homedir: () => os.homedir(),
    jxa: runJxa,
    exec: execFileAsync,
    macHelper: makeHelper,
    cua: makeCua,
    ...(input.selfApp ? { selfApp: input.selfApp } : {}),
    ...(computerControl ? { computerControl } : {}),
  }
  const families = input.serverMode ? [] : (input.families ?? createAllFamilies(input.nativeDir))
  const appSwitch = input.appSwitch ?? null
  const offMessage = appSwitch
    ? `${appSwitch.app} is not installed or is switched off on this computer, so no agent can operate its apps. To use it, install and switch on ${appSwitch.app} in 咕咕 → Apps on that computer.`
    : ''
  const actions = createDeviceActionsProvider({
    store, families, deps, groupTitle,
    ...(appSwitch ? { managedBy: (group: string) => (group === appSwitch.group ? { on: appSwitch.on(), offMessage } : null) } : {}),
  })
  /** The App switch flipped: whoever re-registers this computer's actions, and the settings pages, hear it. */
  const switchListeners = new Set<() => void>()

  let localSink: ((payload: unknown) => void) | null = null
  const host: DeviceActionHost = createDeviceActionHost({
    provider: actions.provider,
    publishEvent: (payload) => localSink?.(payload),
    log: input.log,
  })

  // 各分组的 App 图标(日历、提醒事项……)由原生助手一次画好(NSWorkspace → PNG)。
  // ❌ Electron 的 app.getFileIcon(size: 'large'):Electron 44 + macOS 26 上取 .app 的大图标会让整个咕咕 SIGTRAP 闪退(2026-10-15 实测)。
  // 拿不到(没有原生组件、不是 Mac)就用通用图标;每个路径只取一次。
  const icons = new Map<string, string | undefined>()
  const loadIcons = async () => {
    if (deps.platform !== 'darwin' || !input.nativeDir) return
    const wanted = [...new Set(actions.groups().flatMap((g) => (g.iconApp && !icons.has(g.iconApp) ? [g.iconApp] : [])))]
    if (wanted.length === 0) return
    for (const appPath of wanted) icons.set(appPath, undefined)
    try {
      const out = (await deps.macHelper().call('icons.files', { paths: wanted, size: 96 }, { timeoutMs: 10_000 })) as { icons?: Array<{ path: string; mimeType: string; data: string }> }
      for (const icon of out.icons ?? []) icons.set(icon.path, `data:${icon.mimeType};base64,${icon.data}`)
    } catch (error) {
      input.log.warn({ err: String(error) }, 'device actions: app icons unavailable, using generic icons')
    }
  }

  const titleOf = (name: string) => {
    for (const group of actions.groups()) {
      const hit = actions.actionsOf(group.id).find((a) => a.name === name)
      if (hit) return { title: hit.title, titleEn: hit.titleEn }
    }
    return { title: name, titleEn: name }
  }

  const state = async (): Promise<DeviceActionsState> => {
    await loadIcons()
    const grants = store.read()
    const denied = new Set(grants.deniedActions)
    const view = (g: ReturnType<typeof actions.groups>[number]) => ({
      id: g.id,
      ...(g.section ? { section: g.section } : {}),
      connected: g.id === appSwitch?.group ? appSwitch.on() : grants.groups[g.id] === true,
      ...(grants.connectedAt[g.id] ? { connectedAt: grants.connectedAt[g.id] } : {}),
      blocked: actions.blocked(g.id),
      ...(g.settingsUrl ? { settingsUrl: g.settingsUrl } : {}),
      ...(g.iconApp && icons.get(g.iconApp) ? { icon: icons.get(g.iconApp) } : {}),
      actions: actions.actionsOf(g.id).map((a) => ({
        name: a.name,
        title: a.title,
        titleEn: a.titleEn,
        description: a.description,
        risk: a.risk,
        confirm: a.confirm,
        enabled: !denied.has(a.name),
        ...(actions.unsupportedReason(a.name) ? { unsupported: actions.unsupportedReason(a.name)! } : {}),
      })),
    })
    const switched = appSwitch ? actions.groups().find((g) => g.id === appSwitch.group) : undefined
    return {
      supported: actions.groups().length > 0,
      platform: deps.platform,
      denyAll: grants.denyAll,
      // The group switched by an App is that App's page's to show: one switch, ❌ a second 「连接」 here.
      groups: actions.groups().filter((g) => g !== switched).map(view),
      ...(switched && appSwitch ? { managed: [{ ...view(switched), app: appSwitch.app }] } : {}),
      recent: store.recent().map((r) => ({
        callId: r.callId,
        action: r.action,
        ...titleOf(r.action),
        ...(r.caller?.name ? { callerName: r.caller.name } : {}),
        startedAt: r.startedAt,
        ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
        ...(r.ok !== undefined ? { ok: r.ok } : {}),
        ...(r.code ? { code: r.code } : {}),
        ...(r.message ? { message: r.message } : {}),
      })),
    }
  }

  return {
    computerControl,
    capability: () => actions.capability(),
    rpcHandlers: () => ({
      // Remote requests never reach the provider, confirmation or action-result cache.
      [DEVICE_ACTION_RPC_TYPE]: async () => ({ error: deviceScopeError(await input.deviceId()) }),
      [DEVICE_ACTION_RESULT_ACK_RPC_TYPE]: async () => ({ error: deviceScopeError(await input.deviceId()) }),
    }),
    async callLocal(type, payload) {
      if (type === DEVICE_ACTION_RPC_TYPE) return host.handleCall(payload)
      if (type === DEVICE_ACTION_RESULT_ACK_RPC_TYPE) return host.handleResultAck(payload)
      return { error: { code: 'unknown_method', message: `unknown device RPC type: ${type}` } }
    },
    setLocalEventSink(sink) {
      localSink = sink
    },
    async readLocal(action, args) {
      const permit = await actions.provider.permit(action)
      if (!permit.ok) return permit
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30_000)
      try {
        return await actions.provider.run(action, args, { callId: `gugu-local-${Date.now()}`, signal: controller.signal, note: () => undefined })
      } finally {
        clearTimeout(timer)
      }
    },
    peekWindow(target, options) {
      return peekWindow((action) => actions.provider.permit(action), makeCua(), target, options, {
        ...(input.selfApp ? { self: input.selfApp } : {}),
        ...(computerControl ? { stoppedFor: (pid: number) => computerControl.stoppedFor(pid) } : {}),
      })
    },
    registerIpc(ipcMain, getWindows) {
      ipcMain.handle(DEVICE_ACTIONS_CHANNELS.state, () => state())
      ipcMain.handle(DEVICE_ACTIONS_CHANNELS.connect, async (_event, group: unknown): Promise<DeviceActionsConnectResult> => {
        if (typeof group !== 'string') return { ok: false, code: 'unknown_group', message: 'group must be a string' }
        const result = await actions.connect(group)
        input.log.info({ group, ok: result.ok, ...(result.ok ? {} : { code: result.code }) }, 'device action group connect')
        // spec system-permissions: macOS no longer asks → go straight to 咕咕's page in System Settings, ❌ leave a button
        // for the person to find it. (Where it can still ask, its own box is already up; this page is behind it.)
        if (!result.ok && result.code === 'os_permission' && result.settingsUrl) {
          const opened = await input.openSystemSettings(result.settingsUrl).then(() => true, (error: unknown) => {
            input.log.warn({ group, err: String(error) }, 'device action group connect: could not open System Settings')
            return false
          })
          return opened ? { ...result, message: `${result.message}(已打开系统设置里对应的那一页)`, openedSettings: true as const } : result
        }
        return result
      })
      ipcMain.handle(DEVICE_ACTIONS_CHANNELS.disconnect, (_event, group: unknown) => {
        if (typeof group !== 'string') return false
        actions.disconnect(group)
        input.log.info({ group }, 'device action group disconnected')
        return true
      })
      ipcMain.handle(DEVICE_ACTIONS_CHANNELS.setActionEnabled, (_event, raw: unknown) => {
        const { action, enabled } = (raw ?? {}) as { action?: unknown; enabled?: unknown }
        if (typeof action !== 'string' || typeof enabled !== 'boolean') return false
        store.setActionEnabled(action, enabled)
        input.log.info({ action, enabled }, 'device action toggled')
        return true
      })
      ipcMain.handle(DEVICE_ACTIONS_CHANNELS.setDenyAll, (_event, on: unknown) => {
        if (typeof on !== 'boolean') return false
        store.setDenyAll(on)
        input.log.info({ denyAll: on }, 'device actions deny-all')
        return true
      })
      ipcMain.handle(DEVICE_ACTIONS_CHANNELS.resetOverrides, () => {
        store.resetActionOverrides()
        return true
      })
      ipcMain.handle(DEVICE_ACTIONS_CHANNELS.openSystemSettings, async (_event, url: unknown) => {
        if (typeof url !== 'string' || !/^(x-apple\.systempreferences:|ms-settings:)/.test(url)) return false
        await input.openSystemSettings(url)
        return true
      })
      const changed = () => {
        for (const win of getWindows()) {
          if (!win.isDestroyed()) win.webContents.send(DEVICE_ACTIONS_CHANNELS.changed)
        }
      }
      store.onChange(changed)
      switchListeners.add(changed)
    },
    onGrantsChanged: (listener) => {
      const off = store.onChange((kind) => { if (kind === 'grants') listener() })
      switchListeners.add(listener)
      return () => {
        off()
        switchListeners.delete(listener)
      }
    },
    switchChanged() {
      if (!appSwitch) return
      const on = appSwitch.on()
      input.log.info({ group: appSwitch.group, app: appSwitch.app, on }, 'device action group switched by its App')
      // Off: nothing of it keeps running — cua-driver stops now, ❌ waits out its idle time.
      if (!on) cua?.stop(`${appSwitch.app} 停用了,电脑控制已关闭`)
      for (const listener of [...switchListeners]) {
        try {
          listener()
        } catch (error) {
          input.log.warn({ err: String(error) }, 'device actions: a listener of the App switch failed')
        }
      }
    },
    dispose() {
      host.dispose()
      helper?.dispose()
      computerControl?.dispose()
      cua?.dispose()
    },
  }
}
