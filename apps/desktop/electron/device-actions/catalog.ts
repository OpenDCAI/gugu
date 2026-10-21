/**
 * #7199 这台电脑能被调用的动作 —— 「动作族」的合同:一个动作族 = 一组授权分组
 * (设置里一行一个「连接 / 断开」)+ 它们名下的动作。每个族一个文件(families/*.ts),只管自己:动作做什么、参数怎么查、
 * 连接时怎么碰系统授权。授权、去重、进度、确认的收发规矩都在 provider.ts / deviceActionHost,族里 ❌ 再写一遍。
 */
import type {
  DeviceActionConfirmPolicy,
  DeviceActionErrorCode,
  DeviceActionRisk,
} from '@gugu/core/shared/deviceActions'
import type { DeviceActionOutcome, DeviceActionRunContext } from '@gugu/core/cloud/deviceActionHost'
import type { CuaClient } from './native/cua-client'
import type { MacHelperClient } from './native/mac-helper-client'
import type { ExecResult, runJxa } from './mac-scripts'

export type Args = Record<string, unknown>
export type Outcome = DeviceActionOutcome

/** 设置里的一行(一个授权分组)。 */
export interface ActionGroupDef {
  id: string
  /** 哪些平台有这一组。 */
  platforms: readonly NodeJS.Platform[]
  /** 文件那四个根同属「文件」一段(界面按它分段;动作的 group 写 `files`)。 */
  section?: 'files'
  /** 用哪个 App 的图标(macOS 上取那个 App 自己的图标,如 /System/Applications/Calendar.app)。 */
  iconApp?: string
  /** 系统权限没给时,去系统设置的哪一页(x-apple.systempreferences:… / ms-settings:…)。 */
  settingsUrl?: string
  /** 系统权限没给时给人看的一句「去哪打开」。 */
  osPermission?: string
  /** 要靠咕咕带的原生程序(原生助手 / cua-driver);它不在(开发环境没编译)时这一组整组不可用、并说清为什么。 */
  needs?: 'macHelper' | 'cua'
  /**
   * 「连接」时先真碰一下这一组要的系统能力 —— 第一次会弹系统的授权框 —— 碰通了才记成连上。
   * 没有 probe 的组(剪贴板、系统信息……)一点就连上。
   */
  probe?(ctx: FamilyContext): Promise<Outcome>
}

export interface ActionDef {
  /** 动作名(calendar.events.create …),三端同名同义。 */
  name: string
  /** 授权分组 id;文件类写 `files`(四个根连上任何一个就算,具体路径在动作里按根判)。 */
  group: string
  /** 给人看的名字(设置页、最近调用)。 */
  title: string
  titleEn: string
  /** 给 agent 看的说明:做什么、参数怎么填、回什么(英文)。 */
  description: string
  risk: DeviceActionRisk
  confirm: DeviceActionConfirmPolicy
  input_schema: Record<string, unknown>
  /** 缺省 = 所在分组的平台。 */
  platforms?: readonly NodeJS.Platform[]
  /** 开工前的参数检查:不对回一句话(→ invalid_args)。 */
  validate?(args: Args): string | null
  /** confirm = always 时问用户的那句。 */
  question?(args: Args): string
  /**
   * confirm = always,但问句要先查出要删 / 要发的那一条叫什么(「要删除日程「周会」吗?」),光看参数说不出来:
   * provider 不在开工前拦,由动作自己在没带 confirmed: true 时回 needs_confirmation —— **必须**这样做,测试要盖住。
   */
  confirmsItself?: true
  /** 不要系统授权也能做成(读授权状态这类):它做成了 ≠ 系统授权回来了,❌ 据此清掉「系统没给权限」。 */
  succeedsWithoutPermission?: true
  /**
   * 这台电脑做不了它时说为什么(缺咕咕没带的组件、缺用户该装的工具……);回 null = 做得了。
   * 做不了的照样登记(动作表在各平台保持完整),但标 unsupported、调不了 —— ❌ 登记一个一调就失败的动作冒充能用。
   */
  unsupportedReason?(deps: FamilyDeps): string | null
  run(args: Args, ctx: ActionRunContext): Promise<Outcome>
}

export interface ActionFamily {
  groups: readonly ActionGroupDef[]
  actions: readonly ActionDef[]
}

/** 动作族能用的外部能力:真实现由 runtime 注入,单测替换。 */
export interface FamilyDeps {
  platform: NodeJS.Platform
  /** 咕咕带的原生组件目录(Mac:gugu-mac-helper、cua-driver、cua-tools.json;Windows:cua-driver.exe、cua-tools.json);没有时为 null。 */
  nativeDir: string | null
  now(): Date
  homedir(): string
  clipboardRead(): Promise<string> | string
  clipboardWrite(text: string): Promise<void> | void
  /** 剪贴板里的图片(PNG base64);没有回 null。 */
  clipboardReadImage?(): Promise<{ mimeType: string; data: string; width: number; height: number } | null>
  notify(title: string, body: string): void
  openExternal(url: string): Promise<void>
  /** 移到废纸篓 / 回收站(Electron shell.trashItem)。 */
  trashItem(path: string): Promise<void>
  /** 把一张图缩到长边 maxEdge、转 JPEG(Electron nativeImage);结果里的大图过设备频道前用它压。 */
  shrinkImage?(image: { mimeType: string; data: string }, options: { maxEdge: number; quality: number }): Promise<{ mimeType: string; data: string; width: number; height: number }>
  sampleImage?(base64: string): Uint8Array
  /** 截整块屏幕(Electron desktopCapturer;macOS 要「屏幕录制」权限)。 */
  captureScreen?(options: { maxEdge: number }): Promise<{ mimeType: string; data: string; width: number; height: number; displays: number }>
  jxa: typeof runJxa
  exec(file: string, args: readonly string[], options?: { signal?: AbortSignal; timeoutMs?: number; input?: string; cwd?: string; env?: Record<string, string>; maxBuffer?: number }): Promise<ExecResult>
  macHelper(): MacHelperClient
  cua(): CuaClient
  /** 咕咕自己(电脑控制不许 agent 操作它):主进程 pid、bundle id 与 App 名。 */
  selfApp?(): SelfApp
  /** 电脑控制的「正在操作 · 停止」小条与人接管(computer-control.ts)。 */
  computerControl?: ComputerControlHooks
}

/** 咕咕自己:电脑控制不许 agent 操作它。 */
export interface SelfApp {
  /** 咕咕自己的进程(窗口都归主进程)。 */
  pids: ReadonlySet<number>
  /** 咕咕的 bundle id 与 App 名(小写)。 */
  names: ReadonlySet<string>
}

/** 电脑控制每个动作开始前调一次(computer-control.ts)。 */
export interface ComputerControlHooks {
  /**
   * 人停了这个 App(pid),或停了整个电脑控制 → 回 { refused: 给 agent 的话 };
   * 否则登记「正在操作」,回这一下的中止信号(人按停止时触发,reason 是给 agent 的话)和收尾 end()(成败都调)。
   */
  begin(call: { callerName?: string; pid?: number; appName?: string }): { refused: string } | { signal: AbortSignal; end(): void }
}

export interface FamilyContext {
  deps: FamilyDeps
  /** 这一刻连上了的组。 */
  granted(): ReadonlySet<string>
  signal: AbortSignal
  note(text: string): void
}

export type ActionRunContext = FamilyContext & DeviceActionRunContext

export const ok = (data: unknown): Outcome => ({ ok: true, data })
export const fail = (code: DeviceActionErrorCode, message: string): Outcome => ({ ok: false, code, message })
export const bad = (message: string): Outcome => fail('invalid_args', message)
export const str = (args: Args, key: string): string => (typeof args[key] === 'string' ? (args[key] as string).trim() : '')
export const num = (args: Args, key: string): number | undefined =>
  typeof args[key] === 'number' && Number.isFinite(args[key]) ? (args[key] as number) : undefined
export const bool = (args: Args, key: string): boolean | undefined => (typeof args[key] === 'boolean' ? (args[key] as boolean) : undefined)
export const isDate = (value: string) => value.length > 0 && Number.isFinite(Date.parse(value))
export const clampInt = (value: number | undefined, fallback: number, min: number, max: number) =>
  value === undefined ? fallback : Math.min(Math.max(min, Math.round(value)), max)

/** 结果里要给 agent「看」的图:放进 data.pictures,调用方把它们变成图片块(❌ base64 文本进上下文)。 */
export interface ActionPicture {
  label: string
  mimeType: string
  data: string
}

/** 本地时间的写法(给 agent 看的说明里共用)。 */
export const TIME_HINT = 'ISO 8601. Without an offset it is read as this device\'s local time (see `timezone` in device_actions).'

export const MAC_PRIVACY = (pane: string) => `x-apple.systempreferences:com.apple.preference.security?${pane}`

/**
 * 「连接」时请原生助手要一项系统授权(第一次弹 macOS 的授权框),要到了才算连上。
 * kind:calendar / reminders / contacts / location / accessibility / screen(见 native/mac-helper Permissions.swift)。
 */
export async function requestHelperPermission(ctx: FamilyContext, kind: string, label: string): Promise<Outcome> {
  const r = await ctx.deps.macHelper().call<{ status: string; settingsUrl?: string }>('permissions.request', { kind }, { signal: ctx.signal, timeoutMs: 120_000 })
  if (r.status === 'granted') return ok(null)
  const failed = fail('os_permission', r.status === 'not_determined'
    ? `macOS 还没回话：请在这台电脑上的系统弹窗里允许咕咕使用「${label}」，再点一次「连接」`
    : `macOS 没允许咕咕使用「${label}」：去 系统设置 → 隐私与安全性 → ${label} 里打开咕咕，再点一次「连接」`)
  // 缺的是哪一项,设置里就去哪一页(#7317 实测:缺屏幕录制,「连接」却总把人带去辅助功能)。
  return r.settingsUrl ? Object.assign(failed, { settingsUrl: r.settingsUrl }) : failed
}

/** 原生助手回的结果里带的 pictures(截图、导出的图)原样交给调用方。 */
export function picturesOf(value: unknown): ActionPicture[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { pictures?: unknown }).pictures)) return []
  return ((value as { pictures: unknown[] }).pictures).filter((p): p is ActionPicture =>
    !!p && typeof p === 'object' && typeof (p as ActionPicture).data === 'string' && typeof (p as ActionPicture).mimeType === 'string')
}
