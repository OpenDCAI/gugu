/**
 * #6264 升级看门狗:新版本切过去之后真的站稳了没有;没站稳就自动退回上一版(product spec 第 5 条
 * 「❌ 不把自己切死」)。
 *
 * 抄的是 ChromeOS / Android 的 A/B 更新(新槽位启动后要「标记成功」,否则下次启动回到旧槽位)与
 * Kubernetes 滚动更新的 progressDeadlineSeconds + rollback:判定「成功」的必须是新版本自己跑起来之后的读数,
 * 判定「失败」的必须是一个**不依赖新版本**的进程 —— 新包坏到连守护进程都起不来时,它自己什么也做不了。
 * 所以看门狗是换版**之前**由旧版本(已知是好的)起的一个独立进程,活得比旧守护进程久,盯到出结论为止。
 * (VS Code server 按 commit 装、Zed 按版本装,都只在「装之前」试跑一次,装上之后起不来就一直起不来 ——
 * Coder 那次 text file busy 就是这样把机器永久卡死的,coder/coder#25975。)
 *
 * 成功 = 新版本的某个账号进程已经连续跑了 {@link STABLE_MS}(它每 10 秒写一次 activity.json,带上自己的版本与起始时刻);
 *        没有账号跑在新版本上时,看守护进程自己写的 supervisor-health.json。
 *        「跑在新版本上」按这个账号**该**跑哪一版判(server-account-versions.ts 的 pinnedVersionToRun,converge 起账号进程
 *        用的也是它):钉在和桌面匹配的另一版上的账号,心跳说的是那一版,证明不了新版本的任何事,不算进来;❌ 按心跳里报的
 *        版本判 ——「该跑新版本却还在报旧版本」正是新版本没起来,那一格得照旧算失败。
 * 失败 = 从开始盯起过了 {@link DEADLINE_MS} 仍不成功 → 切回上一版,记下这个坏版本(之后不再自动升级到它,
 *        等更新的版本出来),通知设备行「新版本在这台机器上起不来,已退回」,再请守护进程重启。
 *
 * 开销:只在换版后的最多 10 分钟里存在;每 15 秒读几个几十字节的小文件。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { SERVER_ROLLBACK_FILE, SUPERVISOR_HEALTH_FILE } from '@gugu/core'
import { isOwnProcessAlive, SERVER_PROCESS_MARK } from './process-alive'
import { pinnedVersionToRun, readAccountVersionPin, versionBinary } from './server-account-versions'
import { liveKeeperPid, startKeeper } from './server-keeper'

export const UPGRADE_PENDING_FILE = 'upgrade-pending.json'
export const UPGRADE_GUARD_PID_FILE = 'upgrade-guard.pid'
export const BAD_VERSIONS_FILE = 'bad-versions.json'
export const SUPERVISOR_HEALTH_MS = 30_000
/** 新版本要连续跑这么久才算站稳(账号进程秒退的崩溃循环最长 60 秒一轮,见 server-supervisor.ts)。 */
export const STABLE_MS = 90_000
/** 从开始盯起,最多给新版本这么久。 */
export const DEADLINE_MS = 10 * 60_000
export const GUARD_POLL_MS = 15_000
/** 读数超过这么久没续写,当它已经不在了。 */
const FRESH_MS = 60_000
const GUARD_MARK = 'upgrade-guard'

export type UpgradeMarker = {
  from: string
  to: string
  fromDir: string
  toDir: string
  switchedAt: number
}

export type Heartbeat = { version: string | null; startedAt: number; at: number }

export type UpgradeProbe = {
  now: number
  /** 看门狗开始盯的时刻(换版途中机器重启过时,从重新开始盯算起,❌ 一醒来就判超时)。 */
  watchingSince: number
  marker: UpgradeMarker
  supervisor: Heartbeat | null
  /** 登着、而且该跑新版本的账号各自的进程读数(没写过 = null);钉在别的版本上的账号不在这里。 */
  accounts: Array<Heartbeat | null>
}

export type UpgradeVerdict = 'healthy' | 'waiting' | 'failed'

const stable = (beat: Heartbeat | null, version: string, now: number): boolean =>
  beat !== null && beat.version === version && now - beat.at < FRESH_MS && beat.at - beat.startedAt >= STABLE_MS

/** 纯函数:此刻该判成功、再等等,还是失败回滚。 */
export function judgeUpgrade(probe: UpgradeProbe): UpgradeVerdict {
  const { marker, now } = probe
  const ok =
    probe.accounts.length > 0
      ? probe.accounts.some((beat) => stable(beat, marker.to, now))
      : stable(probe.supervisor, marker.to, now)
  if (ok) return 'healthy'
  const since = Math.max(marker.switchedAt, probe.watchingSince)
  return now - since >= DEADLINE_MS ? 'failed' : 'waiting'
}

// ── 读写 ──────────────────────────────────────────────────────────────────────

const dataDir = (home: string): string => path.join(home, 'data')

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

/** 先写临时文件再改名;写不进(磁盘满)就算了 —— 这些都是辅助读数,❌ 为它们打断主流程。 */
function writeJson(file: string, value: unknown): boolean {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(value))
    fs.renameSync(tmp, file)
    return true
  } catch {
    fs.rmSync(tmp, { force: true })
    return false
  }
}

export function writeSupervisorHealth(home: string, input: { version: string | null; pid: number; startedAt: number }, now = Date.now()): void {
  writeJson(path.join(dataDir(home), SUPERVISOR_HEALTH_FILE), { ...input, at: now })
}

export function parseHeartbeat(value: unknown): Heartbeat | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (typeof row.at !== 'number' || typeof row.startedAt !== 'number') return null
  return { version: typeof row.version === 'string' ? row.version : null, startedAt: row.startedAt, at: row.at }
}

export function readUpgradeMarker(home: string): UpgradeMarker | null {
  const raw = readJson<Partial<UpgradeMarker>>(path.join(dataDir(home), UPGRADE_PENDING_FILE))
  if (!raw || typeof raw.from !== 'string' || typeof raw.to !== 'string') return null
  if (typeof raw.fromDir !== 'string' || typeof raw.toDir !== 'string' || typeof raw.switchedAt !== 'number') return null
  return raw as UpgradeMarker
}

export function writeUpgradeMarker(home: string, marker: UpgradeMarker): boolean {
  return writeJson(path.join(dataDir(home), UPGRADE_PENDING_FILE), marker)
}

export function clearUpgradeMarker(home: string): void {
  fs.rmSync(path.join(dataDir(home), UPGRADE_PENDING_FILE), { force: true })
}

export function readBadVersions(home: string): Record<string, number> {
  const raw = readJson<Record<string, unknown>>(path.join(dataDir(home), BAD_VERSIONS_FILE))
  const out: Record<string, number> = {}
  for (const [version, at] of Object.entries(raw ?? {})) if (typeof at === 'number') out[version] = at
  return out
}

/** 「这一版在这台机器上起不来」的唯一一本账:看门狗退回来的、账号换过去秒退的都记这里,守护进程追通道与账号追桌面都读它。 */
export function addBadVersion(home: string, version: string, now: number): void {
  writeJson(path.join(dataDir(home), BAD_VERSIONS_FILE), { ...readBadVersions(home), [version]: now })
}

export function readProbe(home: string, marker: UpgradeMarker, watchingSince: number, now: number): UpgradeProbe {
  const accountsDir = path.join(home, 'accounts')
  let names: string[] = []
  try {
    names = fs.readdirSync(accountsDir)
  } catch {
    names = []
  }
  // service install 的 shell 不一定带云标志;以实际守护进程继承的控制器环境为准。
  const supervisorPid = supervisorLockHolder(home)
  let followsSupervisor = false
  try {
    followsSupervisor = supervisorPid !== null && fs.readFileSync(`/proc/${supervisorPid}/environ`, 'utf8').split('\0').includes('GUGU_CLOUD_COMPUTER=1')
  } catch {
    // /proc 不可读(如普通 macOS SSH server)时仍按原来的逐账号 pin 判断。
  }
  const accounts: Array<Heartbeat | null> = []
  for (const name of names) {
    const data = path.join(accountsDir, name, 'data')
    if (!fs.existsSync(path.join(data, 'server-session.enc'))) continue
    // 受控云电脑的旧 pin 不是例外:账号也必须真的在新包上,不能只看守护进程。
    if (!followsSupervisor && pinnedVersionToRun(readAccountVersionPin(data), marker.to, (v) => fs.existsSync(versionBinary(path.join(home, 'versions'), v)))) continue
    accounts.push(parseHeartbeat(readJson(path.join(data, 'activity.json'))))
  }
  return {
    now,
    watchingSince,
    marker,
    supervisor: parseHeartbeat(readJson(path.join(dataDir(home), SUPERVISOR_HEALTH_FILE))),
    accounts,
  }
}

// ── 回滚 ──────────────────────────────────────────────────────────────────────

/** 原子切 current:临时软链再改名(守护进程换版与看门狗回滚都用它)。 */
export function pointCurrent(home: string, versionDir: string): void {
  const current = path.join(home, 'current')
  const tmp = `${current}.tmp-${process.pid}`
  fs.rmSync(tmp, { force: true })
  fs.symlinkSync(path.relative(home, versionDir), tmp)
  fs.renameSync(tmp, current)
}

function currentVersionName(home: string): string | null {
  try {
    return path.basename(fs.realpathSync(path.join(home, 'current')))
  } catch {
    return null
  }
}

export type RollbackDeps = {
  now: () => number
  lockHolder: () => number | null
  kill: (pid: number, signal: NodeJS.Signals) => void
  isAlive: (pid: number) => boolean
  sleep: (ms: number) => Promise<void>
  /** systemd / launchd / 看门人会不会在守护进程退出后把它按 current 拉起来。 */
  restartsAutomatically: () => boolean
  startKeeper: (waitPid: number | undefined) => void
  log: (message: string, fields?: Record<string, unknown>) => void
}

/**
 * 退回上一版。返回 false = 没有退(current 已经被人换走了 —— 有人重新执行了安装命令,尊重他的选择)。
 */
export async function rollbackUpgrade(home: string, marker: UpgradeMarker, deps: RollbackDeps): Promise<boolean> {
  if (currentVersionName(home) !== path.basename(marker.toDir)) {
    deps.log('current 已经不指向新版本了,不回滚', { to: marker.to, current: currentVersionName(home) })
    clearUpgradeMarker(home)
    return false
  }
  if (!fs.existsSync(path.join(marker.fromDir, 'bin', 'gugu-server'))) {
    deps.log('上一版已经不在盘上,退不回去', { from: marker.from })
    clearUpgradeMarker(home)
    return false
  }
  pointCurrent(home, marker.fromDir)
  const now = deps.now()
  addBadVersion(home, marker.to, now)
  writeJson(path.join(dataDir(home), SERVER_ROLLBACK_FILE), { version: marker.to, restored: marker.from, at: now })
  clearUpgradeMarker(home)
  deps.log('新版本没站稳,已退回上一版', { bad: marker.to, restored: marker.from })
  const holder = deps.lockHolder()
  if (holder !== null) {
    // SIGUSR2 =「请重启」:守护进程收子进程、放锁、不写停止记号(server-supervisor.ts)。
    deps.kill(holder, 'SIGUSR2')
    const deadline = deps.now() + 45_000
    while (deps.isAlive(holder) && deps.now() < deadline) await deps.sleep(500)
    if (deps.isAlive(holder)) deps.kill(holder, 'SIGKILL')
  }
  if (!deps.restartsAutomatically()) deps.startKeeper(holder ?? undefined)
  return true
}

export type GuardDeps = RollbackDeps & {
  readProbe: (marker: UpgradeMarker, watchingSince: number) => UpgradeProbe
  readMarker: () => UpgradeMarker | null
}

/** 盯到出结论。返回结论(healthy / failed / abandoned = 标记没了,别人已经处理过)。 */
export async function runGuardLoop(home: string, deps: GuardDeps): Promise<'healthy' | 'rolled-back' | 'abandoned'> {
  const watchingSince = deps.now()
  for (;;) {
    const marker = deps.readMarker()
    if (!marker) return 'abandoned'
    const verdict = judgeUpgrade(deps.readProbe(marker, watchingSince))
    if (verdict === 'healthy') {
      clearUpgradeMarker(home)
      deps.log('新版本已站稳', { version: marker.to })
      return 'healthy'
    }
    if (verdict === 'failed') return (await rollbackUpgrade(home, marker, deps)) ? 'rolled-back' : 'abandoned'
    await deps.sleep(GUARD_POLL_MS)
  }
}

function supervisorLockHolder(home: string): number | null {
  try {
    const pid = Number(fs.readFileSync(path.join(dataDir(home), 'server.lock'), 'utf8').trim())
    return isOwnProcessAlive(pid, SERVER_PROCESS_MARK) ? pid : null
  } catch {
    return null
  }
}

/** `gugu-server upgrade-guard`:看门狗进程本体。 */
export async function runUpgradeGuard(home: string, write: (line: string) => void): Promise<number> {
  const pidFile = path.join(dataDir(home), UPGRADE_GUARD_PID_FILE)
  const existing = Number(readJson<number>(pidFile) ?? 0)
  if (existing && existing !== process.pid && isOwnProcessAlive(existing, GUARD_MARK)) return 0
  writeJson(pidFile, process.pid)
  const log = (message: string, fields?: Record<string, unknown>): void =>
    write(`${new Date().toISOString()} INFO  [升级看门狗] ${message}${fields ? ` ${JSON.stringify(fields)}` : ''}`)
  const supervised = process.env.GUGU_SERVER_SUPERVISED
  try {
    const result = await runGuardLoop(home, {
      now: Date.now,
      readMarker: () => readUpgradeMarker(home),
      readProbe: (marker, since) => readProbe(home, marker, since, Date.now()),
      lockHolder: () => supervisorLockHolder(home),
      kill: (pid, signal) => {
        try {
          process.kill(pid, signal)
        } catch {
          // 已经退出了
        }
      },
      isAlive: (pid) => isOwnProcessAlive(pid, SERVER_PROCESS_MARK),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      restartsAutomatically: () =>
        supervised === 'systemd' || supervised === 'launchd' || supervised === 'keeper' || liveKeeperPid(home) !== null,
      startKeeper: (waitPid) => {
        startKeeper({ home, logFile: path.join(dataDir(home), 'logs', 'service.log'), waitPid })
      },
      log,
    })
    log('结束', { result })
    return 0
  } finally {
    if (Number(readJson<number>(pidFile) ?? 0) === process.pid) fs.rmSync(pidFile, { force: true })
  }
}

/** 起一个脱离终端的看门狗(用本进程这一份 node 与 server.js —— 调用方就是已知能跑的那一版)。 */
export function spawnUpgradeGuard(home: string, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const script = process.argv[1]
  if (!script) return undefined
  const logFile = path.join(dataDir(home), 'logs', 'service.log')
  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  const fd = fs.openSync(logFile, 'a')
  try {
    const child = spawn(process.execPath, [script, GUARD_MARK], {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: { ...env, GUGU_SERVER_HOME: home, GUGU_SERVER_WAIT_PID: '' },
    })
    child.on('error', () => undefined)
    child.unref()
    return child.pid
  } finally {
    fs.closeSync(fd)
  }
}

/** 守护进程启动时:有待确认的换版、看门狗却不在(换版途中机器重启了),再请一个。 */
export function ensureUpgradeGuard(home: string, log: { info: (m: string, f?: Record<string, unknown>) => void }): void {
  const marker = readUpgradeMarker(home)
  if (!marker) return
  const pid = Number(readJson<number>(path.join(dataDir(home), UPGRADE_GUARD_PID_FILE)) ?? 0)
  if (pid && isOwnProcessAlive(pid, GUARD_MARK)) return
  log.info('换版还没确认、看门狗不在,重新请一个', { from: marker.from, to: marker.to, guard: spawnUpgradeGuard(home) ?? null })
}
