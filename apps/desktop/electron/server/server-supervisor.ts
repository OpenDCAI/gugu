/**
 * 咕咕 server 的守护进程(`gugu-server run`,系统服务拉起的就是它)。
 *
 * 一台服务器上可以有好几个咕咕账号(product spec 第 7 条),每个账号一个独立的子进程
 * (`gugu-server run-account <id>`,跑的是桌面同一份 main.ts)。守护进程只做四件事:
 *  ① 盯着 accounts/:有人 `gugu-server login` 就给他起一个;有人退出登录就停掉他那个;
 *  ② 子进程挂了就重启(连续秒退时退避,别打满 CPU);
 *  ③ 自己升级(server-updater.ts):所有账号都没有 agent 在干活时才切版本;
 *  ④ 收到停止信号时把子进程一起带走;
 *  ⑤ #6264 每个账号跑和自己桌面匹配的那一版(server-account-versions.ts):各账号可以跑不同版本,换版只重启那一个账号。
 */
import { SERVER_LOGIN_ACTION } from '@gugu/core/cloud/remoteTunnel'
import { readVersionSwitchRequest } from '@gugu/core/cloud/serverDesktopVersions'
import { onErrorEvents } from '@gugu/session-shared'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { isOwnProcessAlive, SERVER_PROCESS_MARK } from './process-alive'
import { applyLoginShell, clearStopped, liveKeeperPid, markStopped, startKeeper, SUPERVISOR_EXIT_ALREADY_RUNNING } from './server-keeper'
import { noteExitReason } from '../lib/exit-reason'
import { removeLegacyBrowserLogins } from '../lib/remove-legacy-browser-logins'
import { accountDataDir, accountIsBusy, listAccounts, serverHome, supervisorDataDir } from './server-layout'
import { rotateByCopyTruncate, rotateByRename, SERVICE_LOG_CHECK_MS } from './server-log-rotate'
import { ensureUpgradeGuard, writeSupervisorHealth, SUPERVISOR_HEALTH_MS } from './server-upgrade-guard'
import { createAccountVersionConverger } from './server-account-converge'
import { managedLayout, startServerUpdater } from './server-updater'

const RECONCILE_MS = 3_000
const CHILD_STOP_GRACE_MS = 30_000
/** 起来不到这么久就退出,算「秒退」,下次重启要退避。 */
const QUICK_EXIT_MS = 30_000
const MAX_BACKOFF_MS = 60_000

type Child = { process: ChildProcess; startedAt: number; version: string | null }

export type SupervisorLog = {
  info: (message: string, fields?: Record<string, unknown>) => void
  warn: (message: string, fields?: Record<string, unknown>) => void
}

export function createSupervisorLog(): SupervisorLog {
  const dir = path.join(supervisorDataDir(), 'logs')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'supervisor.log')
  const write = (level: string, message: string, fields?: Record<string, unknown>) => {
    const line = `${new Date().toISOString()} ${level} ${message}${fields ? ` ${JSON.stringify(fields)}` : ''}`
    process.stdout.write(`${line}\n`)
    try {
      // #6264 有上限:超过就整份挪成 .1(只留一份旧的),见 server-log-rotate.ts。
      rotateByRename(file)
      fs.appendFileSync(file, `${line}\n`)
    } catch {
      // 日志写不进去不许把守护进程带崩
    }
  }
  return { info: (m, f) => write('INFO ', m, f), warn: (m, f) => write('WARN ', m, f) }
}

/** 守护进程自己的单实例锁:同一个数据目录只能有一个守护进程。进程已死的旧锁直接接管。 */
function acquireLock(): (() => void) | null {
  const lockPath = path.join(supervisorDataDir(), 'server.lock')
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  const tryAcquire = (): boolean => {
    let fd: number
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      return false
    }
    try {
      fs.writeSync(fd, String(process.pid))
    } catch {
      // #6264 磁盘满:锁文件建出来了(占的是目录项),进程号写不进去。锁照样算拿到 ——
      // 抛出去会让守护进程秒退、systemd 每 3 秒重来一次,整台机器因为「写不进 5 个字节」下线。
    } finally {
      fs.closeSync(fd)
    }
    return true
  }
  if (!tryAcquire()) {
    let holder = 0
    try {
      holder = Number(fs.readFileSync(lockPath, 'utf8').trim())
    } catch {
      holder = 0
    }
    // #6264 只认「活着且真是咕咕 server」的持有者:进程号被别的进程复用时,这把锁不能永远没人敢接。
    if (isOwnProcessAlive(holder, SERVER_PROCESS_MARK)) return null
    fs.rmSync(lockPath, { force: true })
    if (!tryAcquire()) return null
  }
  return () => {
    try {
      if (Number(fs.readFileSync(lockPath, 'utf8').trim()) === process.pid) fs.rmSync(lockPath, { force: true })
    } catch {
      // 锁已经不在了
    }
  }
}

export async function runSupervisor(): Promise<void> {
  const log = createSupervisorLog()
  const release = acquireLock()
  if (!release) {
    process.stderr.write(`[server] 这台机器上已经有一个咕咕 server 在跑(${supervisorDataDir()})\n`)
    // 专门的退出码:看门人见到它就收手,❌ 两个一直互相顶(server-keeper.ts)。
    process.exit(SUPERVISOR_EXIT_ALREADY_RUNNING)
  }
  process.on('exit', release)
  // Include signed-out accounts: their saved website logins must not wait for another sign-in.
  for (const account of listAccounts()) removeLegacyBrowserLogins(account.dataDir, log)
  const home = serverHome()
  const startedAt = Date.now()
  // 正在跑 = 没有人要它停:上一次 stop 留下的记号作废(看门人据此判断要不要再拉起)。
  clearStopped(home)
  // #6264 后台起的(cron 给 /bin/sh、docker exec 里没有 SHELL)也用用户的登录 shell 去采环境。
  const shell = applyLoginShell(home)
  // #6264 不归 systemd / launchd / 看门人管的(兜底模式的老安装、手动起的):请一个看门人来接手,
  // 它等本进程退了再按 current 拉起 —— 从此崩了、被 OOM 杀了都有人管。开发时的非受管布局不请。
  if (!process.env.GUGU_SERVER_SUPERVISED && managedLayout() && liveKeeperPid(home) === null) {
    const keeper = startKeeper({ home, logFile: path.join(supervisorDataDir(), 'logs', 'service.log'), adoptPid: process.pid })
    log.info('没有系统服务管这个进程,已请看门人接手', { keeper: keeper ?? null })
  }

  const serverScript = process.argv[1]
  if (!serverScript) throw new Error('找不到 server.js 的路径(process.argv[1])')
  const children = new Map<string, Child>()
  const backoff = new Map<string, { failures: number; notBefore: number }>()
  let stopping = false

  const layout = managedLayout()
  const followSupervisor = process.env.GUGU_CLOUD_COMPUTER === '1'
  const versions = createAccountVersionConverger({
    layout,
    followSupervisor,
    log,
    running: (userId) => (children.has(userId) ? (children.get(userId)?.version ?? null) : undefined),
    // 换版:先留一句「更新」,账号进程开机收残据此说清在跑的那一轮是被更新打断的。
    restart: (userId) => {
      noteExitReason(accountDataDir(userId), 'update')
      children.get(userId)?.process.kill('SIGTERM')
    },
  })

  const start = (userId: string): void => {
    // #6264 这个账号该跑哪一版:记着的那一版(装着)就从它的目录起;否则跑守护进程自己这一版。
    const pinned = versions.binaryFor(userId)
    const child = pinned
      ? spawn(pinned.binary, ['run-account', userId], { env: accountProcessEnv(process.env), stdio: ['ignore', 'inherit', 'inherit'] })
      : spawn(process.execPath, [serverScript, 'run-account', userId], { env: accountProcessEnv(process.env), stdio: ['ignore', 'inherit', 'inherit'] })
    const version = pinned?.version ?? process.env.GUGU_TASK_HOST_VERSION ?? null
    children.set(userId, { process: child, startedAt: Date.now(), version })
    log.info('账号进程已启动', { account: userId, pid: child.pid, version })
    // 起不来(可执行文件没了、fd 用尽)时 Node 只发 'error' 不发 'exit':没人接会把守护进程带崩,
    // 接了但不收尾,这个账号会一直挂着一条死记录、再也不重启。两条路走同一个收尾。
    let settled = false
    const settle = (reason: Record<string, unknown>): void => {
      if (settled) return
      settled = true
      const entry = children.get(userId)
      if (entry?.process === child) children.delete(userId)
      if (stopping) return
      const ranFor = Date.now() - (entry?.startedAt ?? Date.now())
      // 刚换过去的那一版起不来:退回原来那一版(❌ 把这个账号切死),这一版冷却一阵不再试。
      if (ranFor < QUICK_EXIT_MS) versions.quickExit(userId, version)
      const previous = backoff.get(userId)?.failures ?? 0
      const failures = ranFor < QUICK_EXIT_MS ? previous + 1 : 0
      const delay = failures === 0 ? 1_000 : Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** (failures - 1))
      backoff.set(userId, { failures, notBefore: Date.now() + delay })
      log.warn('账号进程退出了', { account: userId, ...reason, ranForMs: ranFor, restartInMs: delay })
    }
    child.on('exit', (code, signal) => settle({ code, signal }))
    onErrorEvents([child], (error) => {
      // 进程在跑时的 'error'(发信号失败之类)不代表它退出了:只记一笔,等真正的 'exit'
      if (child.pid === undefined) settle({ error: error.message })
      else log.warn('账号进程报错', { account: userId, pid: child.pid, error: error.message })
    })
  }

  const reconcile = (): void => {
    if (stopping) return
    const signedIn = listAccounts().filter((account) => account.signedIn)
    // 受控云电脑先纠正旧 pin 再冷启动,避免先起桌面报告留下的旧包。
    if (followSupervisor) versions.converge(signedIn)
    const wanted = new Set(signedIn.map((account) => account.userId))
    for (const userId of wanted) {
      if (children.has(userId)) continue
      const wait = backoff.get(userId)
      if (wait && Date.now() < wait.notBefore) continue
      start(userId)
    }
    for (const [userId, child] of children) {
      if (wanted.has(userId)) continue
      log.info('账号已退出登录,停掉它的进程', { account: userId })
      child.process.kill('SIGTERM')
    }
    // #6264 各账号对一对版本:只读每个账号目录里的两个小文件,要换的只重启那一个账号。
    if (!followSupervisor) versions.converge(signedIn)
  }

  const stopAll = async (): Promise<void> => {
    stopping = true
    const all = [...children.values()].map((child) => child.process)
    for (const child of all) child.kill('SIGTERM')
    const deadline = Date.now() + CHILD_STOP_GRACE_MS
    while (Date.now() < deadline && all.some((child) => child.exitCode === null && child.signalCode === null)) {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    for (const child of all) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }

  const shutdown = (reason: string): void => {
    if (stopping) return
    log.info('守护进程停止', { reason })
    if (reason === 'upgrade') for (const userId of children.keys()) noteExitReason(accountDataDir(userId), 'update')
    void stopAll().then(() => process.exit(0))
  }
  // 有人要它停(stop、systemctl stop、Ctrl-C):记下来,看门人就不再拉起。
  const stopRequested = (signal: string): void => {
    markStopped(home)
    shutdown(signal)
  }
  process.on('SIGTERM', () => stopRequested('SIGTERM'))
  process.on('SIGINT', () => stopRequested('SIGINT'))
  // 「请重启」(升级看门狗回滚后):不写停止记号,由 systemd / launchd / 看门人按 current 再拉起。
  process.on('SIGUSR2', () => shutdown('restart'))

  const accounts = listAccounts().filter((account) => account.signedIn)
  log.info('咕咕 server 已启动', {
    version: process.env.GUGU_TASK_HOST_VERSION ?? null,
    accounts: accounts.map((account) => account.email ?? account.userId),
    supervisedBy: process.env.GUGU_SERVER_SUPERVISED || 'none',
    followSupervisor,
    shell,
  })
  // #6264 升级看门狗读这份「我起来了、还活着」(没有账号登录时它是唯一的健康读数);每 30 秒续写一次。
  const health = (): void => writeSupervisorHealth(home, { version: process.env.GUGU_TASK_HOST_VERSION ?? null, pid: process.pid, startedAt })
  health()
  setInterval(health, SUPERVISOR_HEALTH_MS).unref()
  // 刚换过版本、看门狗却不在了(换版途中机器重启):再请一个来,继续盯到新版本站稳或回滚。
  ensureUpgradeGuard(home, log)
  // #6264 兜底模式 / launchd 下所有进程的 stdout 进 service.log,由看门人 / launchd 持有 fd:定时截断,见 server-log-rotate.ts。
  const serviceLog = path.join(supervisorDataDir(), 'logs', 'service.log')
  const rotateServiceLog = (): void => {
    if (rotateByCopyTruncate(serviceLog)) log.info('service.log 超过上限,已轮转')
  }
  rotateServiceLog()
  setInterval(rotateServiceLog, SERVICE_LOG_CHECK_MS).unref()
  if (accounts.length === 0) log.info(`还没有账号登录这台机器:${SERVER_LOGIN_ACTION}`)
  reconcile()
  setInterval(reconcile, RECONCILE_MS)

  startServerUpdater({
    log,
    // 人在这个账号上点了「现在重启更新」:它的 agent 不再挡守护进程自己的升级(别的账号的照样挡)。
    isBusy: () =>
      listAccounts().some(
        (account) => children.has(account.userId) && accountIsBusy(account.dataDir) && !readVersionSwitchRequest(account.dataDir)?.confirmed,
      ),
    shutdown: () => shutdown('upgrade'),
    inUse: () => versions.inUse(),
  })
}

/**
 * 账号进程的环境。
 * #6264 MALLOC_MMAP_THRESHOLD_:账号进程启动时要编译一个 13MB 的主进程代码块,V8 解析器的临时内存
 * 按 glibc 默认走主堆,用完释放了却还不回系统 —— 实测每个账号白占约 135MB 常驻(gugu-walk:主堆 145MB,
 * 单独编译那一块就复现 +139MB)。16K 以上的分配改走 mmap,释放即归还(同一实验 RSS 243→110MB)。
 * 只是一个 glibc 环境变量:macOS、musl 直接忽略;代价是大块分配多一次 mmap 系统调用。用户显式设过就不动。
 */
export function accountProcessEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env, GUGU_SERVER_WAIT_PID: '' }
  if (platform === 'linux' && next.MALLOC_MMAP_THRESHOLD_ === undefined) next.MALLOC_MMAP_THRESHOLD_ = '16384'
  return next
}
