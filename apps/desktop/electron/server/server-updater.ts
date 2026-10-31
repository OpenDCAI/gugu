import type { ServerVersionLifecycle } from './server-version-lifecycle'
import type { AccountHandoff } from './server-account-handoff'
/**
 * 咕咕 server 自己升级(product spec 第 5 条):后台悄悄下好、校验、解开,
 * **这台机器上没有 agent 在跑的时候**才切过去;切的时候终端会话(tmux)不受影响。
 *
 * 只管「经 install.sh 装的」那种布局:`<数据目录>/versions/<版本>` + `current` 软链。别的方式起的(开发、手动解包)不动。
 * 清单与 install.sh 读的是同一份:`<下载根>/<通道>/<os>-<arch>.txt`,一行「版本 sha256 地址」。
 *
 * 切换方式:改 current → 退出。有系统服务(systemd/launchd)时由它按 current 拉起新版本;
 * 兜底模式(没有服务管)就自己先起一个新版本的进程,让它等旧进程退干净再启动。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { SERVER_UPDATE_STATE_FILE } from '@gugu/core'
import { compareServerVersions } from '@gugu/core/cloud/serverDesktopVersions'
import { serverDownloadBase } from './server-download'
import { liveKeeperPid } from './server-keeper'
import { startDetached } from './server-service'
import type { SupervisorLog } from './server-supervisor'
import { touchVersion, versionManifestUrl } from './server-account-versions'
import { readBadVersions, spawnUpgradeGuard } from './server-upgrade-guard'

/**
 * 新版本最迟半小时就发现(原先 6 小时:新 Beta 要好几个小时才到云机器上,10-27 owner 撞到)。
 * 每次只取一行的通道清单,一台机器一天 48 次;大包只在真有新版本时下一次,下载站压力不在这。
 * 与手机端查新版同一个间隔(capacitorAppUpdate.ts)。
 */
const CHECK_INTERVAL_MS = 30 * 60 * 1000
const FIRST_CHECK_DELAY_MS = 60 * 1000
const IDLE_POLL_MS = 30 * 1000

export type ServerManifest = { version: string; sha256: string; url: string }

export function parseManifest(text: string): ServerManifest {
  const [version, sha256, url] = text.trim().split(/\s+/)
  if (!version || !/^[0-9a-f]{64}$/.test(sha256 ?? '') || !url) throw new Error(`版本清单格式不对:${text.trim()}`)
  return { version, sha256, url }
}

type Layout = { home: string; versions: string; current: string; running: string; version: string }

/**
 * #6264 把「升级走到哪了」写给这台机器上各账号的进程看:它们随心跳报上去,「设置 → 设备」那一行据此显示
 * 「更新中」/「有新版本,空闲时自动更新」。读侧(packages/core/src/cloud/deviceHostInfo.ts)按时间判过期:
 * 守护进程半路没了,这个文件不会让界面永远挂着「更新中」。
 */
export type ServerUpdateStateWriter = {
  /** reason 'unreachable' = 连不上下载站(桌面经 SSH 读到它就把包的字节传过来,见 match-version-cli.ts);
   *  'boot-failed' = 装上了、起不来(冷却只认确认重启)。 */
  set: (state: 'downloading' | 'ready' | 'failed', version: string, reason?: 'unreachable' | 'runtime-unverified' | 'boot-failed') => void
  clear: () => void
}

export function createServerUpdateStateWriter(home: string, now: () => number = Date.now): ServerUpdateStateWriter {
  const file = path.join(home, 'data', SERVER_UPDATE_STATE_FILE)
  return {
    set(state, version, reason) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        const tmp = `${file}.${process.pid}.tmp`
        fs.writeFileSync(tmp, JSON.stringify({ state, version, at: now(), ...(reason ? { reason } : {}) }))
        fs.renameSync(tmp, file)
      } catch {
        // 写不进去只影响界面上的一行提示,❌ 不为它打断升级
      }
    },
    clear() {
      fs.rmSync(file, { force: true })
    },
  }
}

/** 在受管布局里运行才返回;否则(开发/手动解包)不做自动升级。 */
export function managedLayout(env: NodeJS.ProcessEnv = process.env): Layout | null {
  const home = env.GUGU_SERVER_HOME
  const appPath = env.GUGU_TASK_HOST_APP_PATH
  const version = env.GUGU_TASK_HOST_VERSION
  if (!home || !appPath || !version) return null
  const versions = path.join(home, 'versions')
  const running = path.dirname(appPath)
  let realVersions: string
  let realRunning: string
  try {
    realVersions = fs.realpathSync(versions)
    realRunning = fs.realpathSync(running)
  } catch {
    return null
  }
  if (path.dirname(realRunning) !== realVersions) return null
  return { home, versions, current: path.join(home, 'current'), running: realRunning, version }
}

export function platformKey(): string {
  const os = process.platform === 'darwin' ? 'darwin' : 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  return `${os}-${arch}`
}

function readChannel(home: string): string {
  try {
    return fs.readFileSync(path.join(home, 'channel'), 'utf8').trim() || 'stable'
  } catch {
    return 'stable'
  }
}

async function fetchManifest(home: string): Promise<ServerManifest> {
  const base = serverDownloadBase()
  const url = `${base}/${readChannel(home)}/${platformKey()}.txt`
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`取版本清单失败(${response.status}):${url}`)
  return parseManifest(await response.text())
}

/** 下载站上还没有这一版(清单 404、通道清单还是更旧的版本):发版时 server 包可能比桌面包晚到,这不是「这一版在这台机器上失败」。 */
export class VersionNotPublishedError extends Error {}

/**
 * 两份清单都没拿到任何应答(被拒、解析不了、连接超时):这台机器连不上下载站。由这一次真下载来判,❌ 另做联网检测。
 * 实测(mac1,10-09):被拒 16 ms、解析不了 37 ms;黑洞每次 fetch 卡满 undici 的 10 s 连接超时,两份清单最坏 21 s。
 */
export class DownloadSiteUnreachableError extends Error {}

/**
 * #6264 某一个版本的清单(给账号换到和桌面匹配的那一版用):`<根>/<版本>/<os>-<arch>.txt`。
 * 发版脚本从带上它那一版起才写;更早的版本没有,这时通道清单正好是这一版也认(与 install.sh --version 同一条)。
 */
export async function fetchVersionManifest(
  home: string,
  version: string,
  fetchImpl: (url: string) => Promise<Response> = (url) => fetch(url, { cache: 'no-store' }),
): Promise<ServerManifest> {
  const base = serverDownloadBase()
  const url = versionManifestUrl(base, version, platformKey())
  const response = await fetchImpl(url).catch(() => null)
  if (response?.ok) {
    const manifest = parseManifest(await response.text())
    if (manifest.version !== version) throw new Error(`版本清单说的是 ${manifest.version},要的是 ${version}:${url}`)
    return manifest
  }
  const channel = await fetchImpl(`${base}/${readChannel(home)}/${platformKey()}.txt`).catch(() => null)
  const latest = channel?.ok ? parseManifest(await channel.text()) : null
  if (latest?.version === version) return latest
  const message = `下载站上没有 ${version} 这一版(${response ? response.status : '连不上'}):${url}`
  if (!response && !channel) throw new DownloadSiteUnreachableError(message)
  // 还没发 = 版本清单 404、通道还没走到这一版;通道已越过它或也取不到 = 真没有(下载站对任何不存在的路径都回 404)。
  throw response?.status === 404 && latest && compareServerVersions(latest.version, version) < 0
    ? new VersionNotPublishedError(message)
    : new Error(message)
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(fs.createReadStream(file), hash)
  return hash.digest('hex')
}

/**
 * 下载、校验、解开、试跑,放到 versions/<版本>。已经在那儿就直接返回。
 * `local` = 桌面经 SSH 放进来的包(这台机器上不了网):用它而 ❌ 下载,其余一步不少。
 */
export async function stageVersion(layout: Pick<Layout, 'versions'>, manifest: ServerManifest, local?: string): Promise<string> {
  const target = path.join(layout.versions, manifest.version)
  const bin = path.join(target, 'bin', 'gugu-server')
  if (fs.existsSync(bin)) return target
  const tmp = fs.mkdtempSync(path.join(layout.versions, '.download-'))
  try {
    const archive = local ?? path.join(tmp, 'pkg.tar.gz')
    if (!local) {
      const response = await fetch(manifest.url)
      if (!response.ok || !response.body) throw new Error(`下载失败(${response.status}):${manifest.url}`)
      await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), fs.createWriteStream(archive))
    }
    const actual = await sha256File(archive)
    if (actual !== manifest.sha256) throw new Error(`包校验不通过:期望 ${manifest.sha256},实际 ${actual}`)
    const extracted = path.join(tmp, 'x')
    fs.mkdirSync(extracted)
    execFileSync('tar', ['-xzf', archive, '-C', extracted])
    const [inner] = fs.readdirSync(extracted)
    const innerDir = path.join(extracted, inner ?? '')
    const innerBin = path.join(innerDir, 'bin', 'gugu-server')
    if (!inner || !fs.existsSync(innerBin)) throw new Error('新包里没有 bin/gugu-server')
    // 试跑一下再切:包在这台机器上起不来(系统太旧、架构不符、原生模块 ABI 不对),就留在旧版本上,❌ 切过去把自己弄死。
    // #6264 以前只跑 `help` —— 它在加载任何原生模块之前就退出了,等于没试。现在跑 `selftest`:真的加载
    // better-sqlite3 / node-pty / @parcel/watcher 并跑一下自带的 tmux(server-selftest.ts)。
    // 切过去之后能不能真的站稳,另由升级看门狗盯着(server-upgrade-guard.ts)。
    execFileSync(innerBin, ['selftest'], { stdio: 'ignore', timeout: 60_000, env: { ...process.env, GUGU_SERVER_WAIT_PID: '' } })
    fs.renameSync(innerDir, target)
    touchVersion(layout.versions, manifest.version)
    return target
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

export type ServerUpdaterDeps = {
  log: SupervisorLog
  lifecycle: ServerVersionLifecycle | null
  /** 这台机器上有没有 agent 正在干活(在跑一轮,或卡在等人批准)。 */
  isBusy: () => boolean
  /** Same current-process heartbeat proof as isBusy; old binaries cannot establish runtime idle. */
  unverifiedAccounts?: () => string[]
  prepareHandoff?: (target: string) => Promise<AccountHandoff | null>
  /** 走正常退出流程(收子进程、放锁)。 */
  shutdown: () => void
  /** 升级状态写到哪(缺省:数据目录下的状态文件)。测试注入用。 */
  stateWriter?: ServerUpdateStateWriter
  /** 各账号正在用 / 要用的版本(清旧版本时不许删,见 server-account-versions.ts)。 */
  inUse?: () => string[]
}

export function startServerUpdater(deps: ServerUpdaterDeps): () => void {
  const { log } = deps
  const layout = managedLayout()
  if (!layout) {
    log.info('不是经 install.sh 装的布局,不做自动升级')
    return () => {}
  }
  let stopped = false
  let ticking = false
  /** 已装好、在等空闲的那一版 —— 只用于等待期间续写状态,❌ 当切换目标(切之前总是现取清单)。 */
  let waitingWith: string | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  const state = deps.stateWriter ?? createServerUpdateStateWriter(layout.home)
  let reportedUnverified = ''
  const ready = (version: string): void => {
    const accounts = deps.unverifiedAccounts?.() ?? []
    const unverified = accounts.length > 0 || !deps.lifecycle?.runtimeOwned(version)
    state.set('ready', version, unverified ? 'runtime-unverified' : undefined)
    const key = unverified ? JSON.stringify([version, accounts]) : ''
    if (key && key !== reportedUnverified) log.info('Automatic supervisor upgrade paused: runtime ownership is unverified', {
      version, accounts,
      action: accounts.length > 0
        ? accounts.map(id => `Check tasks, then explicitly restart this account: gugu-server match-version --account ${id} --apply ${version} --now`)
        : 'The target cannot report runtime ownership; select a supported server version',
    })
    reportedUnverified = key
  }
  // 上一个守护进程留下的(它在等空闲时被停掉、或升级已经完成)一律作废,从此刻的事实重来。
  state.clear()

  /**
   * 取清单 → 装 → 空闲就切;忙就 30 s 后整个再来一遍。切到哪一版**每次都现取**,❌ 记住等待开始时的那一版:
   * 等空闲可能等上几个小时,这期间发布了更新的版本,切过去的就得是它(10-08 实读:59.1 等了 2 h 38 min,
   * 切到的是开头取到的 62.1,起来 60 s 后又升到 63.1,账号进程因此多重启一次)。
   */
  const tick = async (idlePoll = false): Promise<void> => {
    if (stopped || ticking) return
    ticking = true
    try {
      // 等空闲的那 30 s 一轮、此刻仍忙:不取清单(等的是空闲;新版本由半小时那一轮去发现、后台装上)。
      if (idlePoll && waitingWith !== null && deps.isBusy()) {
        ready(waitingWith)
        return void retryWhenIdle(waitingWith)
      }
      const manifest = await fetchManifest(layout.home)
      // 与账号换版同一把尺(`-beta.N` 也比):0.2.51-beta.46.1 → 0.2.51-beta.48.1 是升级,只比主版本会当成同一版。
      if (compareServerVersions(manifest.version, layout.version) <= 0) {
        waitingWith = null
        deps.lifecycle?.hold('supervisor-update', null)
        return void state.clear()
      }
      // #6264 这个版本在这台机器上起不来过(看门狗退回来的):不再自动升到它,等下一个版本。
      if (readBadVersions(layout.home)[manifest.version] !== undefined) {
        log.info('这个版本上次在这台机器上没站稳,跳过', { version: manifest.version })
        waitingWith = null
        deps.lifecycle?.hold('supervisor-update', null)
        return void state.clear()
      }
      if (!fs.existsSync(path.join(layout.versions, manifest.version, 'bin', 'gugu-server'))) {
        log.info('发现新版本,后台下载', { current: layout.version, next: manifest.version })
        state.set('downloading', manifest.version)
        // #6264 下载前先清:留下各账号在用的 + 最近 5 份(同一台机器上几个账号各跑各的版本,❌ 只留一份)。
        deps.lifecycle?.hold('supervisor-update', manifest.version)
        deps.lifecycle?.reclaim()
      }
      if (!deps.lifecycle) throw new Error('Supervisor version lifecycle is not initialised')
      deps.lifecycle.hold('supervisor-update', manifest.version)
      await deps.lifecycle.stage(manifest.version, () => stageVersion(layout, manifest))
      const versionDir = path.join(layout.versions, manifest.version)
      // 每一轮都续写一次:读侧据此知道守护进程还在等,而不是早就没了。
      ready(manifest.version)
      if (!deps.lifecycle.runtimeOwned(manifest.version) || deps.isBusy()) return void retryWhenIdle(manifest.version)
      if (stopped) return
      const permit = deps.prepareHandoff ? await deps.prepareHandoff(manifest.version) : undefined
      if (deps.prepareHandoff && !permit?.valid()) { await permit?.release(); return void retryWhenIdle(manifest.version) }
      if (stopped || deps.isBusy()) { await permit?.release(); return void retryWhenIdle(manifest.version) }
      log.info('没有 agent 在跑,切到新版本', { from: layout.version, to: manifest.version })
      // #6264 先留下「从哪切到哪」,再请看门狗(用本进程 —— 已知能跑的这一版)盯着:新版本站不稳就切回来。
      try { deps.lifecycle.switchSupervisor({
        from: layout.version,
        to: manifest.version,
        fromDir: layout.running,
        toDir: versionDir,
        switchedAt: Date.now(),
      }, () => {
      const guard = spawnUpgradeGuard(layout.home)
      log.info('升级看门狗已就位', { guard: guard ?? null })
      }) } catch (error) { await permit?.release(); throw error }
      if (!process.env.GUGU_SERVER_SUPERVISED && liveKeeperPid(layout.home) === null) {
        // 没有系统服务管:自己先起新版本,它会等本进程退干净(放掉单实例锁)再启动。
        startDetached(path.join(layout.current, 'bin', 'gugu-server'), { GUGU_SERVER_WAIT_PID: String(process.pid) })
      }
      deps.shutdown()
    } catch (error) {
      log.warn('检查/下载新版本失败,下次再试', { error: error instanceof Error ? error.message : String(error) })
      // 在等空闲时取清单失败(断网一下):照旧等,下一轮再取;❌ 一次失败就把等待丢到半小时以后。
      if (waitingWith !== null) retryWhenIdle(waitingWith)
      else { state.clear(); deps.lifecycle?.hold('supervisor-update', null) }
    } finally {
      ticking = false
    }
  }
  const retryWhenIdle = (version: string): void => {
    waitingWith = version
    if (retry !== null) clearTimeout(retry)
    retry = setTimeout(() => void tick(true), IDLE_POLL_MS)
    retry.unref()
  }

  const first = setTimeout(() => void tick(), FIRST_CHECK_DELAY_MS)
  first.unref()
  const timer = setInterval(() => void tick(), CHECK_INTERVAL_MS)
  timer.unref()
  return () => {
    stopped = true
    deps.lifecycle?.hold('supervisor-update', null)
    clearTimeout(first)
    clearInterval(timer)
    if (retry !== null) clearTimeout(retry)
  }
}
