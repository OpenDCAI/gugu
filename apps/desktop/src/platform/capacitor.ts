import type { PermissionState } from '@capacitor/core'
import { BackgroundMode } from '@anuradev/capacitor-background-mode'
import { BarcodeFormat, BarcodeScanner } from '@capacitor-mlkit/barcode-scanning'
import { App } from '@capacitor/app'
import { LocalNotifications } from '@capacitor/local-notifications'
import { AndroidSettings, IOSSettings, NativeSettings } from 'capacitor-native-settings'
import { hostCatalog } from '../../shared/host-localization'
import type { SupportedLocale } from '@/i18n'
import type { AppPlatform, SystemPermission, SystemPermissionState } from './types'
import { createUnsupportedPlatform } from './unsupported'
import { checkForUpdates, downloadUpdate, installUpdate, updateState } from './capacitorAppUpdate'
import { openInApps, saveToDevice, shareToApps, subscribeIncomingShares } from './capacitorShare'
import { PlatformError } from './errors'

const base = createUnsupportedPlatform('capacitor', 'Capacitor')
let resolvedLocale: SupportedLocale = 'zh-CN'

// @@@scan (#537-A) - native QR scan via ML Kit's startScan, which uses the *bundled* barcode model
function buildCancelOverlay(onCancel: () => void): HTMLElement {
  const labels = hostCatalog(resolvedLocale).barcodeScan
  const overlay = document.createElement('div')
  overlay.className = 'gugu-scan-overlay'
  const frame = document.createElement('div')
  frame.className = 'gugu-scan-frame'
  const hint = document.createElement('div')
  hint.className = 'gugu-scan-hint'
  hint.textContent = labels.hint
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'gugu-scan-cancel'
  cancel.textContent = labels.cancel
  cancel.addEventListener('click', onCancel)
  overlay.append(frame, hint, cancel)
  return overlay
}

/**
 * product spec:插件给的四档 → 「点这一行该做什么」的三档。
 * Capacitor 只在系统不会再弹框时才给 `denied`(@capacitor/android Bridge.java:
 * shouldShowRequestPermissionRationale 为假才记 DENIED),所以 denied = blocked;
 * `prompt-with-rationale` 是「拒过一次、系统还肯再弹」,仍归 prompt。
 * 安卓 12 及以下的通知没有运行时授权框,插件按「系统里开没开」直接回 granted / denied,同样落进这三档。
 */
export function toSystemPermissionState(state: PermissionState | 'limited'): SystemPermissionState {
  if (state === 'granted' || state === 'limited') return 'granted'
  if (state === 'denied') return 'blocked'
  return 'prompt'
}

/**
 * 电池优化那一行的真值:插件报的是「系统还在优化咕咕吗」,而对咕咕来说**被优化 = 会被掐**,
 * 所以两边正好反过来 —— 没在优化名单里才算 granted。
 * 它永远不会是 blocked:系统那个确认框可以反复弹,这次拒了下次还点得动。
 */
async function checkBatteryOptimization(): Promise<SystemPermissionState> {
  return (await BackgroundMode.checkBatteryOptimizations()).enabled ? 'prompt' : 'granted'
}

async function checkSystemPermission(permission: SystemPermission): Promise<SystemPermissionState> {
  if (permission === 'notifications') {
    return toSystemPermissionState((await LocalNotifications.checkPermissions()).display)
  }
  if (permission === 'batteryOptimization') return checkBatteryOptimization()
  return toSystemPermissionState((await BarcodeScanner.checkPermissions()).camera)
}

/** 每项权限直达的系统设置页:通知有「咕咕的通知」专页;相机只能到「咕咕的应用详情」,再点「权限」。 */
const SYSTEM_SETTINGS_PAGE: Partial<Record<SystemPermission, AndroidSettings>> = {
  notifications: AndroidSettings.AppNotification,
  camera: AndroidSettings.ApplicationDetails,
  batteryOptimization: AndroidSettings.BatteryOptimization,
}

/**
 * 「后台守着」—— 安卓的前台服务(product spec)。
 *
 * 实测(安卓 16 模拟器,咕咕连 devdb):App 一按 HOME,5 秒之后页面里每 5 秒一次的请求
 * 全部在 5～24 毫秒内失败 —— 不是超时,是被系统当场拒掉;再过约 55 秒连页面里的定时器都不跳了,
 * 静默 5 分半直到切回前台。⇒ 后台期间咕咕根本出不了网,不是「它没去重连」。
 * 前台服务是系统给的唯一交换条件:挂一条用户看得见的常驻通知,换一条不被掐的连接;
 * 顺带 disableWebViewOptimization 让页面在后台仍被当成「可见」,定时器才不会被 Chromium 节流掉。
 *
 * 这里只认一句话(常驻通知上显示的那句)与 null(关掉),状态由调用方持有 ——
 * ❌ 这一层不去猜什么时候该开,那是「谁在看管哪几台机器」才知道的事。
 */
/**
 * ⚠️ 这里是**想要的状态**与**已经生效的状态**两格,中间隔一条串行队列。看着比「直接调插件」绕,
 * 但那个直觉写法实测会把服务关掉:
 *
 * React 的 effect 重挂是「先跑清理、再跑 setup」,两步在同一拍里同步发生,于是同一毫秒内先后
 * 发出 `setBackgroundWatch(null)` 与 `setBackgroundWatch(label)`。两条都是异步派发给原生层,
 * **谁后落地不保证**。2026-09-16 实测(logcat 00:45:07.979 disable / .984 enable):disable 后落地,
 * 前台服务被关掉且没有任何地方显形 —— 一分钟后安卓就把整个进程冻了
 * (`freezing … app.gugu.chat`),那一轮提醒彻底没到。
 *
 * 队列一上,这对「关了又开」在**发出之前**就自相抵消:两次调用先把 desired 写成最终值,
 * 队列跑起来时发现 desired 与 applied 相同 ⇒ 一个原生调用都不发。
 */
type BackgroundWatchNotice = { label: string; text: string | undefined }
let appliedBackgroundWatch: BackgroundWatchNotice | null = null
let desiredBackgroundWatch: BackgroundWatchNotice | null = null
let backgroundWatchQueue: Promise<unknown> = Promise.resolve()

const sameNotice = (a: BackgroundWatchNotice | null, b: BackgroundWatchNotice | null) =>
  a === b || (a !== null && b !== null && a.label === b.label && a.text === b.text)

function backgroundWatchSettings({ label, text }: BackgroundWatchNotice) {
  return {
    title: label,
    // 正文必须自己给:不给的话插件会填它自带的默认句 "App will start faster" ——
    // 一句英文、还讲的是它作者关心的事(2026-09-16 在模拟器通知栏里实际看到)。
    // 这一行回答「它凭什么常驻在我通知栏里」,所以说的是给用户的好处,不是机制。
    // 调用方没给就是看管机器那一句(这条通知原本的用途);#7199 只有「手机当设备」在用时,调用方给它自己的一句。
    text: text ?? hostCatalog(resolvedLocale).backgroundWatch.text,
    // 小图标也自己给:不给就是插件的默认图形,跟咕咕别的通知不是一家。
    icon: 'ic_stat_gugu',
    // 着色同理 —— 插件默认是它自己的绿(157f1f),与咕咕的 colorAccent 差一截,
    // 两条咕咕通知并排时一眼看得出不是一家。这里写 App 清单里那个值(res/values/colors.xml)。
    color: '07C160',
    // 常驻通知不写时间:它不是「刚刚发生的一件事」,挂上时间戳只会让人以为刚响过。
    showWhen: false,
    // 不响不震:这条通知是「我还守着」的凭证,不是提醒本身 —— 提醒只走那一个通道(系统横幅)。
    silent: true,
    // 点它回到咕咕。
    resume: true,
    // 后台时告诉 WebView「你还看得见」,否则 Chromium 会把页面里的定时器冻掉。
    disableWebViewOptimization: true,
  }
}

async function applyBackgroundWatch(): Promise<void> {
  const notice = desiredBackgroundWatch
  if (sameNotice(notice, appliedBackgroundWatch)) return
  if (notice === null) {
    await BackgroundMode.disable()
    appliedBackgroundWatch = null
    return
  }
  // 已经开着就只改字,❌ 不要 disable 再 enable —— 那会让常驻通知闪一下,还会断开一次连接。
  if (appliedBackgroundWatch === null) await BackgroundMode.enable(backgroundWatchSettings(notice))
  else await BackgroundMode.updateNotification(backgroundWatchSettings(notice))
  appliedBackgroundWatch = notice
}

function setBackgroundWatch(label: string | null, text?: string): Promise<void> {
  desiredBackgroundWatch = label === null ? null : { label, text }
  const next = backgroundWatchQueue.then(applyBackgroundWatch, applyBackgroundWatch)
  // 队列自己吞掉失败,免得一次失败把后面所有的开关都连坐;调用方拿到的那条仍然会抛。
  backgroundWatchQueue = next.catch(() => undefined)
  return next
}

/**
 * 两条渠道只差响不响 —— 桌面「提示音」开关的手机那一半。安卓 8+ 的声音挂在渠道上、不挂在单条通知上,
 * 而插件建渠道时不给声音就用系统默认声音,没有「静音」这个选项;所以静音那条只能用「低」重要性:
 * 不响、不弹横幅、只进通知栏。渠道建好之后重要性归用户在系统里改,咕咕不再覆盖。
 */
const ALERT_CHANNEL_ID = 'gugu-alerts'
const QUIET_CHANNEL_ID = 'gugu-alerts-quiet'
let channelsReady: Promise<void> | null = null

function ensureNotificationChannels(): Promise<void> {
  if (!channelsReady) {
    const labels = hostCatalog(resolvedLocale).notificationChannels
    channelsReady = Promise.all([
      LocalNotifications.createChannel({ id: ALERT_CHANNEL_ID, name: labels.alerts, importance: 4, vibration: true }),
      LocalNotifications.createChannel({ id: QUIET_CHANNEL_ID, name: labels.quiet, importance: 2 }),
    ]).then(() => undefined, (error: unknown) => {
      channelsReady = null
      throw error
    })
  }
  return channelsReady
}

// 安卓通知 id 是 32 位 int;每条用一个新的,免得后一条把前一条顶掉。
let notificationSeq = Math.floor(Date.now() / 1000) % 1_000_000_000

export const capacitorPlatform: AppPlatform = {
  ...base,
  capabilities: { ...base.capabilities, barcodeScan: true, notifications: true, backgroundWatch: true, appUpdates: true, shareToApps: true, externalFileOpen: true },
  // @@@android-app-update 应用内更新:与桌面同一套接口、同一个状态形状,界面不分宿主(见 capacitorAppUpdate.ts)。
  checkForUpdates,
  updateState,
  downloadUpdate,
  installUpdate,
  systemPermissions: ['notifications', 'camera', 'batteryOptimization'],
  async syncResolvedLocale(locale) {
    resolvedLocale = locale
  },
  subscribeAppForeground(listener, onError) {
    let active = true
    let handle: { remove: () => Promise<void> } | null = null
    void App.addListener('resume', () => { if (active) listener() }).then((registered) => {
      handle = registered
      if (!active) void registered.remove().catch(onError)
    }, onError)
    return () => {
      if (!active) return
      active = false
      if (handle) void handle.remove().catch(onError)
    }
  },
  subscribeOpenedLinks(listener) {
    let active = true
    let handle: { remove: () => Promise<void> } | null = null
    // Android BridgeActivity.load sends the initial intent through onNewIntent too. AppPlugin retains
    // appUrlOpen until subscription: this one stream carries cold and hot URLs, including before login.
    void App.addListener('appUrlOpen', (event) => { if (active) listener(event.url) }).then(
      (registered) => {
        handle = registered
        if (!active) void registered.remove().catch(() => undefined)
      },
      () => undefined,
    )
    return () => {
      if (!active) return
      active = false
      if (handle) void handle.remove().catch(() => undefined)
    }
  },
  subscribeAppActive(listener) {
    let active = true
    let handle: { remove: () => Promise<void> } | null = null
    // 先报一次当下,调用方不必自己猜初值。
    void App.getState().then((state) => { if (active) listener(state.isActive) }, () => undefined)
    void App.addListener('appStateChange', (state) => { if (active) listener(state.isActive) }).then(
      (registered) => {
        handle = registered
        if (!active) void registered.remove().catch(() => undefined)
      },
      () => undefined,
    )
    return () => {
      if (!active) return
      active = false
      if (handle) void handle.remove().catch(() => undefined)
    }
  },
  async showNotification(payload) {
    // 没权限就回「没弹」,形状同桌面 notifications:show 被系统拒时(electron/main.ts showAppNotification),
    // sendTestNotification 据此给出下一步。❌ 在这里顺手弹授权框 —— 什么时候问由 behavior 定,不由发通知的时机定。
    if (await checkSystemPermission('notifications') !== 'granted') {
      return { success: false, displayed: false, error: 'NOTIFICATIONS_NOT_GRANTED' }
    }
    await ensureNotificationChannels()
    notificationSeq = (notificationSeq + 1) % 2_147_483_647
    await LocalNotifications.schedule({
      notifications: [{
        id: notificationSeq,
        title: payload.title,
        body: payload.body ?? '',
        channelId: payload.silent ? QUIET_CHANNEL_ID : ALERT_CHANNEL_ID,
        // 安卓 8 以下没有渠道,弹不弹横幅看优先级。
        foreground: !payload.silent,
        // 立即发的也必须写 false:插件默认按「精确闹钟」处理,安卓 12+ 没有闹钟权限时会先把人甩进
        // 「闹钟与提醒」设置页 —— 一次没人要的跳转;清单里也已移除这项权限。
        isExactNotification: false,
        extra: payload.chatId ? { chatId: payload.chatId } : undefined,
      }],
    })
    return { success: true, displayed: true }
  },
  setBackgroundWatch,
  // @@@share-with-apps 系统分享两个方向,见 capacitorShare.ts。
  shareToApps,
  subscribeIncomingShares,
  openRemoteFile: openInApps,
  saveFile: saveToDevice,
  checkSystemPermission,
  async requestSystemPermission(permission) {
    if (permission === 'notifications') {
      return toSystemPermissionState((await LocalNotifications.requestPermissions()).display)
    }
    if (permission === 'batteryOptimization') {
      // 系统自己的确认框(「允许咕咕一直在后台运行?」),用户点完才 resolve。
      return (await BackgroundMode.requestDisableBatteryOptimizations()).enabled ? 'prompt' : 'granted'
    }
    return toSystemPermissionState((await BarcodeScanner.requestPermissions()).camera)
  },
  async openSystemPermissionSettings(permission) {
    // 安卓上没有这一档(文件与文件夹访问是 macOS 的事):跳不过去,调用方退回文字指路。
    const page = SYSTEM_SETTINGS_PAGE[permission]
    if (!page) return false
    // 插件在用户从设置页回来之后才 resolve —— 调用方 await 完再读一遍真值,正好是改完之后的状态。
    const { status } = await NativeSettings.open({
      optionAndroid: page,
      optionIOS: IOSSettings.App,
    })
    return status
  },
  scanQrCode: async () => {
    // fail-loud (#1122): a denied/blocked camera permission is a real error, not a user
    // cancel — throw so the caller surfaces it, instead of returning null (= cancel).
    const perm = await BarcodeScanner.requestPermissions()
    if (perm.camera !== 'granted' && perm.camera !== 'limited') {
      throw new PlatformError('BARCODE_SCAN_CAMERA_PERMISSION_DENIED')
    }

    let overlay: HTMLElement | undefined
    const teardown = async () => {
      document.body.classList.remove('barcode-scanner-active')
      overlay?.remove()
      // removeAllListeners (not a captured handle) so a cancel that races listener-init still cleans up.
      await BarcodeScanner.removeAllListeners().catch(() => {})
      await BarcodeScanner.stopScan().catch(() => {})
    }

    return new Promise<string | null>((resolve, reject) => {
      let settled = false
      const finish = (value: string | null) => {
        if (settled) return
        settled = true
        void teardown().then(() => resolve(value))
      }
      // fail-loud (#1122): listener-init / startScan failures (missing ML Kit model, plugin or
      // device errors) are real errors — reject so the caller toasts, instead of silently
      // resolving null (which the caller reads as "user cancelled"). The cancel path
      // (buildCancelOverlay → finish(null)) is unchanged.
      const fail = (err: unknown) => {
        if (settled) return
        settled = true
        const error = err instanceof PlatformError
          ? err
          : new PlatformError('BARCODE_SCAN_FAILED', { cause: err })
        void teardown().then(() => reject(error))
      }
      overlay = buildCancelOverlay(() => finish(null))
      document.body.classList.add('barcode-scanner-active')
      document.body.appendChild(overlay)
      BarcodeScanner.addListener('barcodesScanned', (event) => {
        const value = event.barcodes?.[0]?.rawValue
        if (value) finish(value)
      }).then(() => {
        // If the user cancelled before init finished, don't open the camera — teardown already ran.
        if (settled) return
        return BarcodeScanner.startScan({ formats: [BarcodeFormat.QrCode] })
      }).catch((err: unknown) => fail(err))
    })
  },
}
