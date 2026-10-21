// @@@android-app-update — 安卓壳的应用内更新(product spec)。
//
// 它在安卓上扮演桌面主进程里那套 updater 的角色,对界面交出**同一个形状**:UpdateBanner 与
// 设置→关于 照旧只认 platform.updateState / checkForUpdates / downloadUpdate / installUpdate
// 与 updateStatus 这一个事件(下载进度也是状态值的一部分),不为安卓另画一套提示(「更新入口只有一处」)。
//
// 分工:原生插件(GuguAppUpdatePlugin.java)只搬运 —— 报出装着的版本与更新线、取清单、下包并校验、
// 把包交给系统安装器;**判据全在这里**,且与桌面共用 shared/update-policy.ts 那一份
// (本地构建不追、正式线拒收预发布、下好的包不被后来的消息盖掉)。
//
// 状态的真值是磁盘上的那个包,不是这里的变量:下好的包按 `<版本>_<sha256>.apk` 落在应用自己的
// 目录里,启动时先对一遍账(reconcileDownloads)—— 所以「已经下好、等你按一下」在重开应用、
// 界面重载、离线启动之后都找得回来。
//
// 与桌面的一处不同是有意的:**走流量时不静默下载**,先提示「发现新版本」由用户点了再下 ——
// 几十 MB、一天可能几版,替用户花流量不是「不打扰」。走 Wi-Fi 时与桌面一样静默下好再提示。
import { registerPlugin } from '@capacitor/core'
import semver from 'semver'
import {
  parseBuildDistribution,
  resolveUpdaterPolicy,
  shouldRejectUpdateTarget,
  updateStateAdvances,
  type UpdateChannel,
  type UpdaterPolicy,
} from '../../shared/update-policy'
import { UI_EVENTS } from '../lib/uiEvents'
import { rendererLogger } from '../lib/log'

/** 本地已经完整下好的一个包 —— 文件名就是这两样。 */
export interface StoredPackage {
  version: string
  sha256: string
}

/** 清单上给的更新目标。 */
export interface AndroidUpdateTarget extends StoredPackage {
  url: string
  size: number
}

/** 与 electron/main.ts 的 UpdateCheckResult 同一个形状:界面对两个宿主只认这一种。 */
export interface AppUpdateStatus {
  success: boolean
  status: 'idle' | 'available' | 'downloading' | 'not-available' | 'downloaded' | 'disabled' | 'error'
  updateInfo: { version: string } | null
  /** 只给 `downloading` 用:0–100;还没有第一条进度时不带。 */
  percent?: number
  messageKey?: string
  message?: string
}

interface DownloadProgress {
  percent: number
}

interface GuguAppUpdatePlugin {
  identity(): Promise<{ version: string; channel: string; distribution: string }>
  fetchManifest(): Promise<{ text: string }>
  networkMetered(): Promise<{ metered: boolean }>
  listDownloads(): Promise<{ downloads: StoredPackage[] }>
  deleteDownload(pkg: StoredPackage): Promise<void>
  download(target: AndroidUpdateTarget): Promise<void>
  install(pkg: StoredPackage): Promise<void>
  addListener(event: 'downloadProgress', listener: (progress: DownloadProgress) => void): Promise<unknown>
}

const SHA256 = /^[0-9a-f]{64}$/

/**
 * 读清单。正式线读的是 releases/latest.json(发版流水线汇总的那份,四个平台都在里面),
 * beta 线读 releases/android/beta/latest.json(scripts/publish-beta.cjs 写的,同一个形状)。
 * 两份都只取 `platform: 'android'` 那一项,且那一项里必须**恰好一个** .apk ——
 * 多一个就说不清该装哪个,形状不对一律报错,❌ 挑一个猜。
 */
export function parseAndroidUpdateManifest(text: string): AndroidUpdateTarget {
  const doc = JSON.parse(text) as { version?: unknown; platforms?: unknown }
  if (typeof doc?.version !== 'string' || !Array.isArray(doc.platforms)) {
    throw new Error('update manifest has no version / platforms')
  }
  const android = doc.platforms.filter((p) => (p as { platform?: unknown } | null)?.platform === 'android')
  if (android.length !== 1) throw new Error(`update manifest lists ${android.length} android entries, expected 1`)
  const files = (android[0] as { files?: unknown }).files
  const apks = Array.isArray(files)
    ? files.filter((f) => typeof (f as { name?: unknown } | null)?.name === 'string' && (f as { name: string }).name.endsWith('.apk'))
    : []
  if (apks.length !== 1) throw new Error(`update manifest lists ${apks.length} android packages, expected 1`)
  const apk = apks[0] as { url?: unknown; sha256?: unknown; size?: unknown }
  if (typeof apk.url !== 'string' || !apk.url.startsWith('https://')) throw new Error('android package url is not https')
  if (typeof apk.sha256 !== 'string' || !SHA256.test(apk.sha256)) throw new Error('android package sha256 is malformed')
  if (typeof apk.size !== 'number' || !Number.isSafeInteger(apk.size) || apk.size <= 0) {
    throw new Error('android package size is malformed')
  }
  return { version: doc.version, url: apk.url, sha256: apk.sha256, size: apk.size }
}

/**
 * 本地那些包留哪个、删哪些。
 *  - 不比装着的新 = 已经装上了或者过时了 ⇒ 删(behavior:装完之后把安装包清掉);
 *  - 比装着的新的里面只留最新那一个,它就是「下好了、等你按」的那一份 ⇒ ❌ 不许删;
 *    更旧的那些已经被它取代,留着只占地方。
 * 只看本地文件,不看清单:离线启动、清单暂时取不到,都不会让一个下好的包被误删。
 */
export function planDownloads(
  installed: string,
  downloads: readonly StoredPackage[],
): { keep: StoredPackage | null; remove: StoredPackage[] } {
  const pending = downloads
    .filter((pkg) => semver.gt(pkg.version, installed))
    .sort((a, b) => semver.rcompare(a.version, b.version))
  const keep = pending[0] ?? null
  return { keep, remove: downloads.filter((pkg) => pkg !== keep) }
}

const CHECK_INTERVAL_MS = 30 * 60 * 1000
const plugin = registerPlugin<GuguAppUpdatePlugin>('GuguAppUpdate')
const log = rendererLogger('app-update')

interface Identity {
  installed: string
  channel: UpdateChannel
  policy: UpdaterPolicy
}

let identityPromise: Promise<Identity> | null = null
let prepared: Promise<Identity> | null = null
let state: AppUpdateStatus = { success: true, status: 'idle', updateInfo: null }
/** 已经下好、等用户按的那一份。 */
let staged: StoredPackage | null = null
/** 清单上比装着的新、还没下好的那一份。 */
let offered: AndroidUpdateTarget | null = null
let downloading: Promise<void> | null = null

function identity(): Promise<Identity> {
  identityPromise ??= plugin.identity().then((id) => {
    if (id.channel !== 'stable' && id.channel !== 'beta') throw new Error(`Unknown android update channel '${id.channel}'`)
    const policy = resolveUpdaterPolicy({
      isPackaged: true,
      distribution: parseBuildDistribution(id.distribution),
      channel: id.channel,
    })
    return { installed: id.version, channel: id.channel, policy }
  })
  return identityPromise
}

/** 状态的唯一写入口:先落到值上,再推给界面;退不回去的(下好的包被后来的消息盖掉)不推。 */
function emit(next: AppUpdateStatus): void {
  if (!updateStateAdvances(state.status, next.status)) return
  state = next
  window.dispatchEvent(new CustomEvent(UI_EVENTS.updateStatus, { detail: next }))
}

function downloadedStatus(version: string): AppUpdateStatus {
  return { success: true, status: 'downloaded', updateInfo: { version }, messageKey: 'about.updateDownloaded' }
}

function downloadingStatus(version: string, percent?: number): AppUpdateStatus {
  return { success: true, status: 'downloading', updateInfo: { version }, ...(percent === undefined ? {} : { percent }) }
}

function availableStatus(version: string): AppUpdateStatus {
  return { success: true, status: 'available', updateInfo: { version }, messageKey: 'about.updateAvailable' }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function reconcileDownloads(installed: string): Promise<void> {
  const { downloads } = await plugin.listDownloads()
  const plan = planDownloads(installed, downloads)
  for (const pkg of plan.remove) await plugin.deleteDownload(pkg)
  staged = plan.keep
  if (staged) emit(downloadedStatus(staged.version))
}

/**
 * 第一次有界面来问更新状态时起步(UpdateBanner 全局常挂,应用一打开就会问):
 * 先对本地的账,再查一次线上,之后每 30 分钟查一次 —— 与桌面主进程同一个节奏。
 */
function prepare(): Promise<Identity> {
  prepared ??= identity().then(async (id) => {
    if (!id.policy.enabled) return id
    await plugin.addListener('downloadProgress', (progress) => {
      if (offered) emit(downloadingStatus(offered.version, progress.percent))
    })
    await reconcileDownloads(id.installed)
    const scheduledCheck = () => {
      void checkForUpdates().catch((error: unknown) => log.warn({ error: errorMessage(error) }, '自动检查更新失败'))
    }
    scheduledCheck()
    window.setInterval(scheduledCheck, CHECK_INTERVAL_MS)
    return id
  }).catch((error: unknown) => {
    // 起不来就是整条更新线断了:界面那边问状态的调用会吞掉这个错(横幅只是不出现),
    // 所以原因必须在这里留下,❌ 让它安静地变成「一直没有新版本」。
    log.error({ error: errorMessage(error) }, '应用内更新起不来')
    throw error
  })
  return prepared
}

function downloadOffered(silent: boolean): Promise<void> {
  const target = offered
  if (!target) return Promise.reject(new Error('没有可下载的更新 —— 先检查更新'))
  downloading ??= (async () => {
    emit(downloadingStatus(target.version))
    try {
      const id = await identity()
      await plugin.download(target)
      emit(downloadedStatus(target.version))
      await reconcileDownloads(id.installed)
    } catch (error) {
      const message = errorMessage(error)
      // 静默下载失败:用户一个键都没按过,弹错给他是无端打扰;但也❌ 就这么算了 ——
      // 退回「发现新版本 [更新]」,他点了走手动那条,那条失败会明明白白报出来。
      if (silent) {
        log.warn({ version: target.version, error: message }, '后台下载更新失败,改为提示用户')
        // 手上还有一份下好的(安卓的包下新的时不删旧的):退回它,❌ 把能装的入口换成「发现新版本」。
        emit(staged ? downloadedStatus(staged.version) : availableStatus(target.version))
        return
      }
      emit({ success: false, status: 'error', updateInfo: null, message })
      throw error
    } finally {
      downloading = null
    }
  })()
  return downloading
}

export async function checkForUpdates(): Promise<AppUpdateStatus> {
  const id = await prepare()
  if (!id.policy.enabled) {
    return { success: false, status: id.policy.status, updateInfo: null, messageKey: id.policy.messageKey }
  }
  let target: AndroidUpdateTarget
  try {
    target = parseAndroidUpdateManifest((await plugin.fetchManifest()).text)
  } catch (error) {
    const message = errorMessage(error)
    log.warn({ error: message }, '取更新清单失败')
    return { success: false, status: 'error', updateInfo: null, message }
  }
  if (shouldRejectUpdateTarget(target, id.channel) || !semver.gt(target.version, id.installed)) {
    offered = null
    const upToDate: AppUpdateStatus = {
      success: true,
      status: 'not-available',
      updateInfo: { version: target.version },
      messageKey: 'about.updateUpToDate',
    }
    emit(upToDate)
    return state.status === 'downloaded' ? state : upToDate
  }
  // 这一版已经下好在等人按:答「可以装了」,❌ 答「发现新版本」把人送回下载那一步。
  if (staged?.sha256 === target.sha256) return state
  offered = target
  if ((await plugin.networkMetered()).metered) emit(availableStatus(target.version))
  else void downloadOffered(true)
  // 正在下 / 已下好:答状态源,❌ 答「发现新版本」(那等于说还没开始)。
  return state.status === 'downloaded' || state.status === 'downloading' ? state : availableStatus(target.version)
}

export async function updateState(): Promise<AppUpdateStatus> {
  await prepare()
  return state
}

export function downloadUpdate(): Promise<void> {
  return downloadOffered(false)
}

export async function installUpdate(): Promise<void> {
  if (!staged) throw new Error('没有下好的更新可以安装')
  // 系统安装器接手:装上时本进程被系统换掉;用户在系统那一步点了取消,这里会 reject,
  // 按钮据此恢复可按(UpdateBanner 的 installUpdate().catch)。
  await plugin.install({ version: staged.version, sha256: staged.sha256 })
}
