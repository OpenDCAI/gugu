import type { LocalUsageRequest, LocalUsageSnapshot } from '@gugu/core/shared/usage/dailyUsage'
import type { RendererCommandDomain } from '../lib/rendererCommandProtocol'
import type { Device } from '@gugu/core/shared/types/chat'
import type { HumanAuthSession } from '@gugu/core'
import type { SupportedLocale } from '@/i18n'
import type { FileHandle } from '@gugu/core/shared/fileResolver'

interface PlatformCapabilities {
  directoryPicker: boolean
  appVersion: boolean
  appUpdates: boolean
  agentRuntime: boolean
  badge: boolean
  clipboard: boolean
  notifications: boolean
  rendererCommandBridge: boolean
  localHumanAuthSession: boolean
  barcodeScan: boolean
  sessionHost: boolean
  externalFileOpen: boolean
  appRelaunch: boolean
  /** 有本地日志文件可读 —— 只有 Electron 有。web / 移动壳上「附带日志」不该出现在界面上。 */
  logTail: boolean
  /**
   * 能让实时连接在 App 切到后台之后继续活着(安卓的前台服务)。
   * 桌面不需要这个概念(窗口关了进程还在),浏览器给不了 —— 所以这是手机壳独有的一位。
   */
  backgroundWatch: boolean
  /**
   * 能把内容交给系统分享面板(product spec)。只有安卓壳有:浏览器的 Web Share 要求在点击的那一刻调用,
   * 附件来不及下载;电脑上没有能把内容直接发进微信的系统分享。
   */
  shareToApps: boolean
}

/** 交给系统分享面板的一份内容。附件只给地址,由宿主自己取字节,交出去的是文件本身。 */
export interface ShareToAppsPayload {
  text?: string
  title?: string
  files?: Array<{ file: FileHandle; name: string; mimeType?: string }>
}

/** 没收下的原因,给界面挑一句用户看得懂的话;原文只进日志。 */
export type IncomingShareFailure = 'tooLarge' | 'refused' | 'unreadable'

/** 别的 App 分享进来的一份内容,字节已读成 File;failures = 没能收下的那几个,界面要当面说。 */
export interface IncomingShare {
  text: string | null
  files: File[]
  failures: Array<{ name: string | null; reason: IncomingShareFailure }>
}

/** 手机「权限」页列出的系统权限。只列咕咕真用到、要用户点头的(product spec)。 */
export type SystemPermission = 'notifications' | 'camera' | 'fileAccess' | 'batteryOptimization'

/**
 * 系统当下给的真值,按「点这一行该做什么」切成四档:
 *   granted    —— 已开启
 *   prompt     —— 未开启,系统还会弹授权框
 *   blocked    —— 未开启,系统不会再弹(安卓上拒过两次即永久拒绝,或在系统设置里关了),只能去系统设置改
 *   unreadable —— 系统**不让应用查**这一项(macOS 的通知授权与按文件夹的访问授权都是这样)。
 *                 如实说「查不到」,点进去直达系统设置 —— ❌ 既不编一个「已开启」,也不因此把整页藏掉。
 */
export type SystemPermissionState = 'granted' | 'prompt' | 'blocked' | 'unreadable'

/** 反馈里自愿附带的日志尾巴。文本已在主进程再脱敏过一遍(#4899)。 */
export interface FeedbackLogTail {
  text: string
  lines: number
  bytes: number
  truncated: boolean
}

export interface AppPlatform {
  kind: 'electron' | 'capacitor' | 'web'
  documentTitle: string
  capabilities: PlatformCapabilities
  /**
   * 这个宿主**读得到系统真值**的权限,顺序 = 「权限」页上的行序(product spec)。
   * 空数组 = 这台机器上一行都读不到,「权限」这一项连同整页都不出现。
   * ❌ 不要在页面或导航里再判断一次平台 —— 谁能列哪几行,只有宿主自己说了算。
   */
  systemPermissions: readonly SystemPermission[]
  syncResolvedLocale: (locale: SupportedLocale) => Promise<void>
  subscribeAppForeground: (listener: () => void, onError: (error: unknown) => void) => () => void
  /**
   * App 此刻在不在前台 —— 订阅时先用当前值回调一次,之后每次变化再回调。
   *
   * ⚠️ 为什么不能用 `document.visibilityState` 代替:「后台守着」(setBackgroundWatch)开着时,
   * 前台服务会持续告诉 WebView「你还看得见」(否则 Chromium 冻掉页面里的定时器),
   * 于是 App 明明在后台,页面仍然自称 visible。只有宿主自己知道真相。
   * 桌面同理:主窗关了 backgroundThrottling,最小化、被遮住、切到别的应用时页面照样 visible(main.ts @@@app-active)。
   * 宿主答不上来就不实现它,调用方退回 visibilityState —— 那是没有前台服务的宿主,不会被骗。
   */
  subscribeAppActive?: (listener: (active: boolean) => void) => () => void
  selectDirectory: () => Promise<string | null>
  checkForUpdates: () => Promise<unknown>
  updateState?: () => Promise<unknown> // @@@5837 问宿主更新现在什么状态(main.ts updates:state);答不上来就不实现
  downloadUpdate: () => Promise<unknown>
  installUpdate: () => Promise<unknown>
  /**
   * @@@5758 让宿主去取更新说明。渲染层的 origin(gugu-app://app)对下载站是跨源,而下载站不发
   * CORS 头 —— 渲染层自己 fetch 会被浏览器层拦掉。宿主主进程没有同源策略。
   * 宿主答不上来就**不实现它**,调用方退回渲染层 fetch(web/移动端本来就走得通)。
   */
  fetchChangelog?: () => Promise<unknown>
  getAppVersion: () => Promise<string>
  /**
   * 取本地日志尾巴,供用户在反馈里自愿附带。
   * ❌ 读不到就抛 —— 调用方必须当场告诉用户「这次带不上」,不许静默附一个空的。
   */
  readLogTail: () => Promise<FeedbackLogTail>
  openAgentRuntime: (agentUserId: string) => Promise<unknown>
  /**
   * 用系统应用打开一个附件。字节怎么拿由宿主挑:桌面要字节(交给主进程落盘再打开),安卓要签名链接(原生自己下),
   * 网页开新标签页。两样都按需取,宿主只调它要的那一样。
   */
  openRemoteFile: (file: FileHandle, filename: string) => Promise<void>
  /**
   * 「保存」:把这份字节存成一个文件。桌面与网页交给浏览器的下载(a[download]);安卓的 WebView 不接下载,交给系统的
   * 「保存到…」。saved:false = 人在系统界面里取消了(不是失败);写不进去照常抛。
   */
  saveFile: (blob: Blob, filename: string) => Promise<{ saved: boolean }>
  writeClipboardText: (value: string) => Promise<void>
  setBadge: (count: number) => void
  setTrayBadgeEnabled: (enabled: boolean) => void
  // @@@scan (#537-A) - native camera QR/barcode scan; resolves the decoded raw string a user would
  // otherwise paste, or null if cancelled. Only the capacitor adapter implements it (capability gate).
  scanQrCode: () => Promise<string | null>
  showNotification: (payload: { title: string; body?: string; chatId?: string | null; silent?: boolean }) => Promise<unknown>
  /**
   * 手机「权限」页的三个动作(product spec),由 systemPermissions 能力位把门;
   * 没有这个能力的平台抛错,❌ 静默返回一个假状态。
   * check —— 读系统当下的真值,❌ 返回咕咕自己记下的状态。
   * request —— 系统还肯弹就弹授权框,返回弹完之后的真值。
   * openSettings —— 跳到系统里咕咕对应的设置页;`false` = 这台设备跳不过去,调用方要说清去哪改。
   */
  checkSystemPermission: (permission: SystemPermission) => Promise<SystemPermissionState>
  requestSystemPermission: (permission: SystemPermission) => Promise<SystemPermissionState>
  openSystemPermissionSettings: (permission: SystemPermission) => Promise<boolean>
  /**
   * 「后台守着」的开关:传一句话 = 开着并把这句话显示在常驻通知上;传 null = 关掉。
   *
   * 为什么需要它:实测(安卓 16)App 一切到后台,系统 5 秒内就把它的网断了 —— 每一次请求都在
   * 20 毫秒内被当场拒掉,不是超时;再过约一分钟连页面里的定时器都冻住。于是 agent 干完那一刻
   * 的推送根本到不了手机。安卓给的唯一交换条件是前台服务:挂一条用户看得见的常驻通知,
   * 换一条不被掐的连接 —— 所以这个开关的参数就是那条通知上的话。
   *
   * 由 backgroundWatch 能力位把门;没有这个能力的宿主抛错,❌ 不静默 no-op
   * (静默 no-op 会让调用方以为守住了,而人收不到提醒时没有任何地方显形)。
   * 谁开谁负责关:它不记忆状态,页面卸载就该关掉。
   */
  /** label = 常驻通知的标题;text = 正文(不给 = 看管机器那一句)。 */
  setBackgroundWatch: (label: string | null, text?: string) => Promise<void>
  /** 弹出系统分享面板即 resolve;取附件失败、面板打不开都抛,调用方当面说「没能分享」。由 shareToApps 能力位把门。 */
  shareToApps: (payload: ShareToAppsPayload) => Promise<void>
  /** 别的 App 分享进来的内容;订阅前收到的那一份在订阅时补发。只有安卓壳有这个口。 */
  subscribeIncomingShares?: (listener: (share: IncomingShare) => void) => () => void
  /** 系统交给 App 打开的 https 链接(安卓 App Links);拉起 App 的那一条在第一次订阅时补发。只有安卓壳有这个口。 */
  subscribeOpenedLinks?: (listener: (url: string) => void) => () => void
  writeHumanAuthSession: (session: HumanAuthSession) => Promise<void>
  /** 登出了,还是会话永久丢了(主进程据此决定 getAuth 是答「没登录」还是抛「会话丢了」)。 */
  clearHumanAuthSession: (reason: 'signed-out' | 'lost') => Promise<void>
  /**
   * 本机刚把一条设备命令放回了 pending(失败条的「重试」)—— 告诉本机的设备 runtime 当场去取。
   * 可选:只有带本机设备 runtime 的宿主(Electron)有这个口;网页与移动端没有可通知的对象。
   */
  notifyDeviceCommandsChanged?: () => void
  /**
   * #6396 本账号的 agent 有变动(另一台设备建了 / 改名 / 删了)—— 告诉本机会话页起名那一层当场刷新「用到几号」。
   * 可选:只有在本机起会话页会话的宿主(Electron)有这个口。
   */
  notifyOwnedAgentsChanged?: () => void
  /**
   * 重启整个应用。退出登录后调用 —— 理由见 App.tsx 的调用点。
   * 由 appRelaunch capability 把门;没有这个能力的平台抛错,❌ 不静默 no-op。
   */
  relaunchApp: () => Promise<void>
  getPathForFile?: (file: File) => string
  sendRendererCommandReady: (domain: RendererCommandDomain) => void
  sendRendererCommandResult: (domain: RendererCommandDomain, reqId: string, result: unknown) => void
  // @@@local-device-self - Returns this machine's device row as soon as the desktop
  getLocalDeviceSelfSnapshot?: () => Promise<Device | null>
  /**
   * 用量页(product spec):本机按天×引擎的用量汇总(会话/运行区间/各家 CLI 日志里的 token)。
   * 只有带本地库的桌面宿主有;网页与手机只读云端,没有这个口。
   */
  getLocalUsageSnapshot?: (request: LocalUsageRequest) => Promise<LocalUsageSnapshot>
  /** Electron main-process reachable agent creation tools; unavailable on web/mobile. */
  getAgentCreationTools?: () => Promise<unknown>
  /**
   * @@@4526 释放一个已删除 agent 在本机的足迹(花名册 / runtime session / 投递注册),并立墓碑阻止
   * 它绑定的会话页会话重新开户。只有拥有本机足迹的宿主实现它;web 上没有这一半,所以是可选的。
   */
  releaseOwnedAgentLocalFootprint?: (agentUserId: string) => Promise<void>
  /**
   * @@@share-card-rename 改名的本机那半:把新名字写回花名册(会话页读它)。云端改名成功后调。
   * 与上面那条同理,只有拥有本机足迹的宿主实现它;web 上没有这一半,所以是可选的。
   */
  renameOwnedAgentLocalFootprint?: (agentUserId: string, name: string) => Promise<void>
}
