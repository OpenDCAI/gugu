/**
 * 应用自更新的接线:发现新版 → 静默下载 → 下好 → 用户按下安装。
 *
 * 从 main.ts 挪出来,是为了能拿一个假的 updater 测**接线**本身:哪个失败该落到哪里,只有把事件和
 * Promise 摆在一起才看得出来(复核 113 delta 3)。状态值、文案、dmg 半自动那条路仍在 main.ts,经 deps 注入。
 *
 * 两种失败,分界就是现成的 Promise,❌ 另立一个状态去分:
 * - **下载失败**只在 `downloadUpdate()` 被拒时结清(`settleDownloadFailure`):是不是用户要的这次下载、
 *   「下好就装」作不作废,都在这里定。同一次失败 electron-updater 还会先发一条 'error' 事件 —— 那时状态还是
 *   downloading,'error' 一律不碰下载中的状态。
 * - **检查失败**(没网、feed 挂了)只走 'error' 事件 / `checkForUpdates()` 被拒,与下载、安装无关:
 *   按下「重启更新」时查 feed 失败,照样装手上那一份(product spec);下载途中某次周期检查失败,
 *   那次下载照常下完、照常按原意装或不装。
 */
import type { UpdateQuit } from './update-quit'

export interface UpdateInfoLike {
  version?: string
  files?: Array<{ url: string; sha512?: string }>
}

export type UpdateStatus =
  | 'idle'
  | 'available'
  | 'downloading'
  | 'not-available'
  | 'downloaded'
  | 'downloaded-manual'
  | 'disabled'
  | 'error'

export interface UpdateStatusPayload {
  success: boolean
  status: UpdateStatus
  updateInfo: unknown | null
  messageKey?: string
  message?: string
  /** 只给 `downloading` 用:0–100;还没有第一条进度时不带。 */
  percent?: number
}

/** electron-updater 的 autoUpdater 用到的那几样。 */
export interface UpdaterLike {
  onUpdateAvailable: (listener: (info: UpdateInfoLike) => void) => void
  onUpdateNotAvailable: (listener: (info: unknown) => void) => void
  onDownloadProgress: (listener: (progress: { percent: number }) => void) => void
  onUpdateDownloaded: (listener: () => void) => void
  onError: (listener: (error: Error) => void) => void
  checkForUpdates: () => Promise<unknown>
  downloadUpdate: () => Promise<unknown>
}

export interface UpdateFlowDeps {
  updater: UpdaterLike
  /** 这个包追不追更新(updaterPolicy.enabled)。 */
  enabled: boolean
  getStatus: () => UpdateStatus
  emit: (payload: UpdateStatusPayload) => void
  /** 下好了:界面那边的「可以装了」推送。 */
  onReady: () => void
  /** @@@2177 通道闸:这条不能当更新目标。 */
  rejectTarget: (info: unknown) => boolean
  /** @@@663 mac ad-hoc 存量包的 dmg 半自动路径:用不用、怎么起(它自己报进度与结果)。 */
  dmg: { applies: (info: UpdateInfoLike | null) => boolean; start: () => void }
  updateQuit: Pick<UpdateQuit, 'installAfterDownload' | 'downloaded' | 'downloadFailed'>
  logInfo: (message: string, detail?: Record<string, unknown>) => void
  logWarn: (message: string, detail?: Record<string, unknown>) => void
}

export interface UpdateFlow {
  /** feed 上最新查到的那一条(dmg 路径要它的 files/version)。 */
  readonly lastUpdateInfo: UpdateInfoLike | null
  markDownloading: (percent?: number) => void
  /** 用户点「更新」,或静默下载。 */
  download: () => void
  /** 用户按「重启更新」。 */
  install: () => Promise<void>
}

const versionOf = (info: UpdateInfoLike | null): string | null =>
  typeof info?.version === 'string' ? info.version : null

export function createUpdateFlow(deps: UpdateFlowDeps): UpdateFlow {
  // @@@663 update-available 时暂存,mac dmg 路径下载要用它的 files/version(autoUpdater 不吐完整 URL)
  let lastUpdateInfo: UpdateInfoLike | null = null
  // @@@5576 能静默下就静默下 —— 下完界面才出「重启更新」,装不装仍由用户点(product spec)。
  let silentDownloadActive = false
  let downloadedVersion: string | null = null

  // 「正在下」是状态源上的一个值(带 percent),❌ 另发一条进度事件:界面上「下载中」只有这一个来源。
  // 原先静默下载时进度被整段吞掉、状态停在 idle,用户点「检查更新」只得到「发现新版本」,
  // 198MB 在后台下了 7 分钟界面上什么都没有(owner 10-08 实测)。横幅照旧不为用户没要求的下载
  // 弹出来(@@@5576)—— 那由横幅自己判断,❌ 靠在这里瞒。
  function markDownloading(percent?: number): void {
    const version = versionOf(lastUpdateInfo)
    deps.emit({
      success: true,
      status: 'downloading',
      updateInfo: version === null ? null : { version },
      ...(percent === undefined ? {} : { percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0 }),
    })
  }

  function settleDownloadFailure(error: unknown): void {
    // 已经结清过(同一次下载被调了两次,两个 Promise 都会被拒):第一个说了算。
    if (deps.getStatus() !== 'downloading') return
    const message = error instanceof Error ? error.message : String(error)
    // 按过「重启更新」之后的那次下载是用户要的:照实报错(横幅出「更新失败 + 重试」),
    // 「下好就装」随之作废 —— 以后某次静默下载下好时 ❌ 突然退出去装(装不装由用户定)。
    const userAsked = deps.updateQuit.downloadFailed()
    const silentFailure = silentDownloadActive && !userAsked
    silentDownloadActive = false
    // @@@5576 静默下载失败:用户从没按过任何键,弹一个错给他是无端打扰;但也**不能就这么算了** ——
    // 退回「发现新版本 [更新]」,他点一次就走手动路径,那条路失败会明明白白报错。失败本身记 warn 留痕。
    if (silentFailure && lastUpdateInfo) {
      deps.logWarn(`silent download failed, falling back to user-initiated: ${message}`, { err: message })
      deps.emit({ success: true, status: 'available', updateInfo: lastUpdateInfo, messageKey: 'about.updateAvailable' })
      return
    }
    deps.emit({ success: false, status: 'error', updateInfo: null, message })
  }

  function download(): void {
    markDownloading()
    if (deps.dmg.applies(lastUpdateInfo)) {
      deps.dmg.start()
      return
    }
    void deps.updater.downloadUpdate().catch(settleDownloadFailure)
  }

  // ❌ 不覆盖 dmg 半自动路径:那条路下完会 shell.openPath 弹出 Finder 窗口要求拖装,静默触发它等于
  // 在用户没按任何键的时候突然弹个窗。存量 ad-hoc 老包因此维持原样(发现新版→提示→用户点了才下)。
  // 返回 true 表示已接管本次 update-available,调用方不要再发 'available'。
  function startSilentDownload(): boolean {
    if (!deps.enabled) return false
    if (deps.dmg.applies(lastUpdateInfo)) {
      deps.logInfo('silent download skipped: dmg path needs the user to drag-install')
      return false
    }
    // 周期 check 每 30 分钟一轮,而一个两百多 MB 的包在慢网上下得比这久 —— 没有这道闸,第二轮
    // update-available 会把同一个包再下一遍。
    if (silentDownloadActive) {
      deps.logInfo('silent download already in flight; ignoring this update-available')
      return true
    }
    // 下好了但用户还没点「重启更新」:界面已经停在 ready,下一轮 check 不该再下一次同一个版本。
    const version = versionOf(lastUpdateInfo)
    if (version !== null && version === downloadedVersion) {
      deps.logInfo(`update ${version} already downloaded; waiting for the user to restart`)
      return true
    }
    silentDownloadActive = true
    deps.logInfo('downloading update in the background')
    download()
    return true
  }

  deps.updater.onDownloadProgress((progress) => markDownloading(progress.percent))

  deps.updater.onUpdateAvailable((info) => {
    if (deps.rejectTarget(info)) {
      lastUpdateInfo = null // 不留缓存:用户即便手点「更新」也无从下到这个包
      deps.emit({ success: true, status: 'not-available', updateInfo: info, messageKey: 'about.updateUpToDate' })
      return
    }
    lastUpdateInfo = info
    // @@@5576 静默路径不发 'available':发了界面就会弹「发现新版本 [更新]」,然后自己变成下载中 ——
    // 用户看见一个不用点的按钮,那不是「后台把它下好」,是把准备工作演给他看。
    if (startSilentDownload()) return
    deps.emit({ success: true, status: 'available', updateInfo: info, messageKey: 'about.updateAvailable' })
  })

  deps.updater.onUpdateNotAvailable((info) => {
    lastUpdateInfo = null // 发布被回滚(曾 available 现 not)后清缓存,防按旧 URL 下到 404(#663 review)
    deps.emit({ success: true, status: 'not-available', updateInfo: info, messageKey: 'about.updateUpToDate' })
  })

  deps.updater.onUpdateDownloaded(markDownloaded)

  function markDownloaded(): void {
    silentDownloadActive = false
    downloadedVersion = versionOf(lastUpdateInfo)
    deps.emit({
      success: true,
      status: 'downloaded',
      // @@@5837 带上版本号:状态源要说得出等着装的是**哪一版**。
      updateInfo: downloadedVersion === null ? null : { version: downloadedVersion },
      messageKey: 'about.updateDownloaded',
    })
    deps.onReady()
    deps.updateQuit.downloaded({ version: downloadedVersion })
  }

  deps.updater.onError((error) => {
    // 正在下载时来的 'error' 要么属于这次下载(它的失败由 downloadUpdate 被拒那一处结清),要么是一次
    // 周期检查失败 —— 两种都 ❌ 碰下载与安装的状态。
    if (deps.getStatus() === 'downloading') return
    deps.emit({ success: false, status: 'error', updateInfo: null, message: error.message })
  })

  // 「重启更新」装的是**按下这一刻 feed 上最新的那一版**,❌ 半小时前下好的那一份。
  // owner 10-08 实测:一天出了 5 版(59→63),周期检查 30 分钟一轮,按下时装的常常是上一轮下好的旧版,
  // 装完起来再查才发现更新的,于是一次更新要按好几次。
  // ⇒ 按下先查一次 feed(复用同一个 check → 静默下载 → update-downloaded):有更新的就先下(界面显示
  //   「下载中 N%」),下好了直接装 —— 用户已经说过要装;没有更新的、或者查不到(离线),装手上这一份。
  async function install(): Promise<void> {
    deps.updateQuit.installAfterDownload()
    try {
      await deps.updater.checkForUpdates()
    } catch (error) {
      deps.logWarn('[updater] 按下安装前查 feed 失败,装已下好的这一份', { error: String(error) })
    }
    // 查到更新的一版时,update-available → startSilentDownload 已经把状态置成 downloading;
    // 它下好时由 update-downloaded 接着装。
    if (deps.getStatus() === 'downloading') {
      deps.logInfo('[updater] 按下安装时 feed 上有更新的一版,先下它,下好就装', { staged: downloadedVersion })
      return
    }
    deps.updateQuit.downloaded({ version: downloadedVersion })
  }

  return {
    get lastUpdateInfo() {
      return lastUpdateInfo
    },
    markDownloading,
    download,
    install,
  }
}
