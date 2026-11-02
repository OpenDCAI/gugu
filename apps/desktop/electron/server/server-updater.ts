import { AccountBootRejectedError, createServerVersionLifecycle, type ServerVersionLifecycle } from './server-version-lifecycle'
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
import { execFileSync } from '@gugu/core/local/childProcess'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { DeviceRpcHandlers } from '@gugu/core/cloud/deviceRpcResponder'
import { VERSION_RESTART_RPC, VERSION_RETRY_RPC, LEGACY_VERSION_RETRY_RPC } from '@gugu/core/cloud/serverMachineHealth'
import { compareServerVersions, isServerVersion } from '@gugu/core/cloud/serverDesktopVersions'
import { createServerUpdateStateWriter, readUpdateRecord, type ServerUpdateRecord, type ServerUpdateStateWriter } from './server-update-state'
export { createServerUpdateStateWriter } from './server-update-state'
import type { FailureCause, Outcome } from '@gugu/core/shared/serverVersionOutcome'
import { serverDownloadBase } from './server-download'
import { touchVersion, versionManifestUrl } from './server-account-versions'
import { readBadVersions } from './server-startup'
import { controllerOwnsUpdates, readInstallation } from './server-package-environment.mts'

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
  if (!isServerVersion(version) || !/^[0-9a-f]{64}$/.test(sha256 ?? '') || !url) throw new Error(`版本清单格式不对:${text.trim()}`)
  return { version, sha256, url }
}

type Layout = { home: string; versions: string; current: string; running: string; version: string }

/**
 * #6264 把「升级走到哪了」写给这台机器上各账号的进程看:它们随心跳报上去,「设置 → 设备」那一行据此显示
 * 「更新中」/「有新版本,空闲时自动更新」。读侧(packages/core/src/cloud/deviceHostInfo.ts)按时间判过期:
 * 守护进程半路没了,这个文件不会让界面永远挂着「更新中」。
 */
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
  const installation = readInstallation(home)
  if (installation) return installation.channel
  const channel = fs.readFileSync(path.join(home, 'channel'), 'utf8').trim()
  if (!/^[a-z][a-z0-9-]*$/.test(channel)) throw new Error('Server update channel is missing or invalid')
  return channel
}

async function fetchManifest(home: string): Promise<ServerManifest> {
  const base = serverDownloadBase()
  const url = `${base}/${readChannel(home)}/${platformKey()}.txt`
  const response = await fetch(url, { cache: 'no-store' }).catch(() => { throw new DownloadSiteUnreachableError(`Cannot reach the server release feed: ${url}`) })
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
    // 切过去之后能不能真的站稳,由预加载按连续启动失败计数(server-boot.cjs)。
    execFileSync(innerBin, ['selftest'], { stdio: 'ignore', timeout: 60_000, env: { ...process.env, GUGU_SERVER_WAIT_PID: '' } })
    fs.renameSync(innerDir, target)
    touchVersion(layout.versions, manifest.version)
    return target
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

export type ServerUpdaterRuntime = { isBusy: () => boolean; shutdown: () => void }
export type ServerUpdaterDeps = ServerUpdaterRuntime & {
  log: { info: (message: string, fields?: Record<string, unknown>) => void; warn: (message: string, fields?: Record<string, unknown>) => void }
  lifecycle?: ServerVersionLifecycle | null
  stateWriter?: ServerUpdateStateWriter
}
export type ServerUpdater = {
  dispose: () => void
  bindRuntime: (runtime: ServerUpdaterRuntime) => void
  retryWhenIdle: () => boolean
  restartConfirmed: (target: unknown, confirmed: unknown) => number | false
}
let activeUpdater: ServerUpdater | null = null
/** The one run process owns this instance; both cloud and SSH handlers call it. */
export const singleServerUpdater = (): ServerUpdater | null => activeUpdater
export function serverUpdateRpcHandlers(): DeviceRpcHandlers {
  const idle = () => activeUpdater?.retryWhenIdle()
    ? { result: { requested: true } }
    : { error: { code: 'unavailable', message: 'Server updates are not managed by this process' } }
  return {
    [VERSION_RETRY_RPC]: idle,
    [LEGACY_VERSION_RETRY_RPC]: idle,
    [VERSION_RESTART_RPC]: payload => {
      const value = payload as { version?: unknown; confirmed?: unknown } | null
      const at = activeUpdater?.restartConfirmed(value?.version, value?.confirmed)
      return typeof at === 'number' ? { result: { requested: true, at } }
        : { error: { code: 'invalid_payload', message: 'Confirm the current ready target version before restarting' } }
    },
  }
}
const FAILURE_COOLDOWN_MS = 6 * 60 * 60 * 1000


export function startServerUpdater(deps: ServerUpdaterDeps): ServerUpdater {
  const layout = managedLayout()
  let runtime: ServerUpdaterRuntime = deps
  let stopped = false
  let ticking = false
  let request: { at: number; confirmed: boolean; target?: string } | null = null
  let nextRequest = 0
  let retry: ReturnType<typeof setTimeout> | null = null
  let first: ReturnType<typeof setTimeout> | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  const controller = layout ? controllerOwnsUpdates(layout.home) : false
  const lifecycle = layout ? deps.lifecycle ?? createServerVersionLifecycle({ layout }) : null
  const state = layout ? deps.stateWriter ?? createServerUpdateStateWriter(layout.home) : null
  let record = layout ? readUpdateRecord(layout.home) : null
  const publish = (value: Omit<ServerUpdateRecord, 'at'>): void => {
    const current = layout ? readUpdateRecord(layout.home) ?? record : record
    const next = { ...value, at: Date.now(), ...(value.lastOutcome ? {} : current?.lastOutcome ? { lastOutcome: current.lastOutcome } : {}) }
    state?.set(next.state, next.version, next.cause === 'unreachable' ? 'unreachable' : undefined, next)
    record = next
  }
  const schedule = (delay: number): void => {
    if (stopped) return
    if (retry !== null) clearTimeout(retry)
    retry = setTimeout(() => { retry = null; void tick(true) }, delay)
    retry.unref()
  }
  const control: ServerUpdater = {
    bindRuntime: value => { runtime = value },
    retryWhenIdle() {
      if (!layout || stopped || controller) return false
      request = { at: nextRequest = Math.max(Date.now(), nextRequest + 1), confirmed: false }
      schedule(0)
      return true
    },
    restartConfirmed(target, confirmed) {
      if (!layout || stopped || confirmed !== true || !isServerVersion(target)) return false
      // A platform controller can prepare the same state file from another process.
      record = readUpdateRecord(layout.home) ?? record
      if (!record || record.version !== target || (record.state !== 'ready' && !(record.state === 'failed' && record.cause === 'boot'))) return false
      const at = nextRequest = Math.max(Date.now(), nextRequest + 1)
      try { publish({ ...record, lastOutcome: { kind: 'waiting', target, at, request: at } }) }
      catch (error) {
        deps.log.warn('Could not persist the confirmed server update', { error: String(error) })
        return false
      }
      request = { at, confirmed: true, target }
      // Leave the RPC response a turn to publish its acknowledgement before exit 75.
      schedule(0)
      return at
    },
    dispose() {
      stopped = true
      if (first !== null) clearTimeout(first)
      if (timer !== null) clearInterval(timer)
      if (retry !== null) clearTimeout(retry)
      lifecycle?.hold('server-update', null)
      if (activeUpdater === control) activeUpdater = null
    },
  }
  if (!layout || !lifecycle) {
    deps.log.info('Not a managed installation; automatic server updates are disabled')
    return control
  }
  activeUpdater = control

  async function tick(idlePoll = false): Promise<void> {
    if (stopped || ticking) return
    ticking = true
    record = readUpdateRecord(layout!.home) ?? record
    const received = request
    let target = received?.target ?? record?.version ?? layout!.version
    let resolved = false
    try {
      if (controller && !received?.confirmed) return
      if (idlePoll && !received?.confirmed && record?.state === 'ready' && runtime.isBusy()) {
        publish({ state: 'ready', version: record.version })
        return schedule(IDLE_POLL_MS)
      }
      const manifest = received?.confirmed
        ? controller || fs.existsSync(path.join(layout!.versions, target, 'bin/gugu-server'))
          ? { version: target, sha256: '', url: '' }
          : await fetchVersionManifest(layout!.home, target)
        : await fetchManifest(layout!.home)
      resolved = true
      target = manifest.version
      if (stopped || request !== received) return
      // A failure cools down its target, not subsequently published releases.
      if (!received && record?.state === 'failed' && record.version === target && typeof record.until === 'number' && record.until > Date.now()) return
      if (target === layout!.version || (!received?.confirmed && compareServerVersions(target, layout!.version) <= 0)) {
        publish({ state: 'idle', version: layout!.version,
          ...(received ? { lastOutcome: { kind: 'switched', target: layout!.version, at: Date.now(), request: received.at } as Outcome } : {}) })
        if (request === received) request = null
        return
      }
      if (!received?.confirmed && readBadVersions(layout!.home)[target] !== undefined) {
        publish({ state: 'failed', version: target, cause: 'boot', until: Date.now() + FAILURE_COOLDOWN_MS,
          ...(received ? { lastOutcome: { kind: 'refused', target, cause: 'boot', at: Date.now(), request: received.at } as Outcome } : {}) })
        if (request === received) request = null
        return
      }
      lifecycle!.hold('server-update', target)
      if (!lifecycle!.ready(target)) deps.log.info('Preparing server update', { from: layout!.version, to: target })
      publish({ state: 'downloading', version: target })
      lifecycle!.reclaim()
      await lifecycle!.stage(target, () => {
        if (controller) {
          if (!fs.existsSync(path.join(layout!.versions, target, 'bin/gugu-server'))) throw new Error('The controller has not prepared this package')
          return Promise.resolve()
        }
        return stageVersion(layout!, manifest)
      })
      if (stopped || request !== received) return
      publish({ state: 'ready', version: target })
      if (!received?.confirmed && runtime.isBusy()) return schedule(IDLE_POLL_MS)
      // The lifecycle verifies the environment and boot before recording pending/current.
      publish({ state: 'switching', version: target })
      lifecycle!.switchSupervisor({ from: layout!.version, to: target, fromDir: layout!.running,
        toDir: path.join(layout!.versions, target), switchedAt: Date.now(), ...(received ? { request: received.at } : {}) }, () => {})
      deps.log.info('Switching server package', { from: layout!.version, to: target, request: received?.at })
      control.dispose()
      runtime.shutdown()
    } catch (error) {
      if (stopped || request !== received) return
      if (!resolved && idlePoll && record?.state === 'ready') {
        deps.log.warn('Could not refresh the release feed; continuing to wait', { error: String(error) })
        return schedule(IDLE_POLL_MS)
      }
      const cause: FailureCause = error instanceof AccountBootRejectedError ? 'boot' : error instanceof DownloadSiteUnreachableError ? 'unreachable' : 'install'
      const attempts = record?.state === 'failed' && record.version === target ? (record.attempts ?? 0) + 1 : 1
      const until = Date.now() + (error instanceof VersionNotPublishedError
        ? Math.min(5 * 60 * 1000 * 2 ** (attempts - 1), FAILURE_COOLDOWN_MS) : FAILURE_COOLDOWN_MS)
      try {
        publish({ state: 'failed', version: target, cause, until, attempts,
          lastOutcome: { kind: 'failed', target, cause, at: Date.now(), ...(received ? { request: received.at } : {}) } })
      } catch (writeError) { deps.log.warn('Could not persist server update failure', { error: String(writeError) }) }
      if (request === received) request = null
      lifecycle!.hold('server-update', null)
      deps.log.warn('Server update failed; waiting for retry or the next check', { target, error: error instanceof Error ? error.message : String(error), until })
    } finally {
      ticking = false
      if (!stopped && request && request !== received) schedule(0)
    }
  }
  if (controller) deps.log.info('The platform controller selects server packages')
  else {
    first = setTimeout(() => void tick(), FIRST_CHECK_DELAY_MS)
    first.unref()
    timer = setInterval(() => void tick(), CHECK_INTERVAL_MS)
    timer.unref()
  }
  return control
}
