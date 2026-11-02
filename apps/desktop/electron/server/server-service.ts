/**
 * `gugu-server service install | uninstall | status`:让 server 常驻(product spec 第 4 条)——
 * SSH 断开不停、机器重启自己起来、全程不要 root。
 *
 * - Linux 有 systemd 用户会话:写用户服务 + `loginctl enable-linger`(否则最后一个 SSH 会话一断,用户级 systemd
 *   连同 server 一起被收掉)。`KillMode=process`:重启/升级只停 server 本身,tmux 里的终端会话留着。
 * - Linux 没有 systemd 用户会话(容器、部分精简系统):crontab `@reboot` 管开机自起 + 现在就后台起一个。
 * - macOS:launchd 用户代理(RunAtLoad + KeepAlive),`AbandonProcessGroup` 同样是为了留住 tmux。
 *
 * 服务里跑的是 `<数据目录>/current/bin/gugu-server`:升级只切 current 软链,服务定义不用改。
 *
 * `service install` 的交付是「此刻真在跑的就是这一版」,不是「服务写好了」:一行安装命令重新执行一遍
 * (behavior 第 5 条「急用可在那台机器上重新执行安装命令」)时,机器上往往已经有一个旧版本在跑,
 * 这里负责把它换下来,最后以单实例锁里那个进程的真实版本为准报出结果,没换成就说清怎么办。
 */
import { execFileSync } from '@gugu/core/local/childProcess'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isProcessAlive } from './process-alive'
import { readAccountRuntime } from './server-account-runtime'
import { recordLoginShell, startKeeper } from './server-keeper'
import { activityProof, listAccounts, supervisorDataDir } from './server-layout'
import { SERVICE_UMASK } from './server-permissions'
import { spawnUpgradeGuard, writeUpgradeMarker } from './server-upgrade-guard'
import { ownServerNames } from './server-names'

/** 这一份 server 的通道名字(server-names.ts):正式版 `gugu-server.service`,Beta `gugu-server-beta.service`,其余同理。 */
const NAMES = ownServerNames()
const UNIT_NAME = NAMES.systemdUnit
const LAUNCHD_LABEL = NAMES.launchdLabel
const CRON_MARK = NAMES.cronMark
/** crontab 里属于这条通道的那一行:按行尾的标记整串比(`# gugu-server` 是 `# gugu-server-beta` 的前缀,❌ includes)。 */
const isCronLine = (line: string): boolean => line.trimEnd().endsWith(` ${CRON_MARK}`)

type Out = (line: string) => void

function serverHome(): string {
  const home = process.env.GUGU_SERVER_HOME
  if (!home) throw new Error('GUGU_SERVER_HOME 未设置(应由 server 入口设置)')
  return home
}

/** 服务要跑的那个可执行文件:装过(有 current)就用 current,否则用当前这份。 */
function serviceExecutable(): string {
  const current = path.join(serverHome(), 'current', 'bin', 'gugu-server')
  if (fs.existsSync(current)) return current
  const appPath = process.env.GUGU_TASK_HOST_APP_PATH
  if (!appPath) throw new Error('找不到 gugu-server 可执行文件:既没有 current 软链,也不是从安装包启动的')
  return path.join(path.dirname(appPath), 'bin', 'gugu-server')
}

function logFile(): string {
  const dir = path.join(serverHome(), 'data', 'logs')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'service.log')
}

function tryRun(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, out: out.trim() }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message: string }
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message }
  }
}

/**
 * 当前进程能不能跟这个用户的 systemd 用户会话说上话。`su`、`docker exec -u` 进来的 shell 没有 XDG_RUNTIME_DIR,
 * `systemctl --user` 直接失败 —— 可这个用户的 systemd(开了 linger,或另有登录会话)可能正跑着、服务就在它下面。
 * 所以失败时再按 /run/user/<uid>/bus 找一次;找到就把 XDG_RUNTIME_DIR 留在本进程环境里,后面的 systemctl 都走它。
 */
function reachSystemdUserSession(): boolean {
  if (process.platform !== 'linux') return false
  if (tryRun('systemctl', ['--user', 'show-environment']).ok) return true
  const runtime = `/run/user/${os.userInfo().uid}`
  if (process.env.XDG_RUNTIME_DIR === runtime || !fs.existsSync(path.join(runtime, 'bus'))) return false
  const previous = process.env.XDG_RUNTIME_DIR
  process.env.XDG_RUNTIME_DIR = runtime
  if (tryRun('systemctl', ['--user', 'show-environment']).ok) return true
  if (previous === undefined) delete process.env.XDG_RUNTIME_DIR
  else process.env.XDG_RUNTIME_DIR = previous
  return false
}

function hasCrontab(): boolean {
  return tryRun('sh', ['-c', 'command -v crontab']).ok
}

/**
 * systemd 单元里的一个值加引号(路径里有空格、引号、`%`、`$` 时单元照样对)。
 * 规则见 systemd.service(5)「Command lines」与 systemd.unit(5)「Specifiers」:双引号包住、`\\` 与 `"` 转义,
 * `%` 写成 `%%`(否则当成说明符展开);ExecStart 里 `$` 写成 `$$`(否则当成变量展开)。
 */
export function systemdQuote(value: string, options: { execLine?: boolean } = {}): string {
  let s = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')
  // 替换串里 `$$` 表示一个 `$`,所以两个 `$` 要写四个。
  if (options.execLine) s = s.replace(/\$/g, '$$$$')
  return `"${s}"`
}

/** crontab 一行里的 shell 单引号值:`'` 照 sh 规矩拆开,`%` 在 crontab 里是换行,要写成 `\%`(crontab(5))。 */
export function cronQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`).replace(/%/g, '\\%')}'`
}

export function systemdUnit(executable: string, home: string): string {
  return `[Unit]
Description=咕咕 server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${systemdQuote(executable, { execLine: true })} run
Environment=${systemdQuote(`GUGU_SERVER_HOME=${home}`)}
Environment=GUGU_SERVER_SUPERVISED=systemd
# 不写的话继承用户管理器的 umask(Ubuntu 每用户同名组的系统上是 0002,组可写)。0022 = 跟登录 shell 一样:
# agent 与编程终端在项目里建的文件照常是 0644;server 自己的数据目录另由 0700 的根保证私有。
UMask=0${SERVICE_UMASK.toString(8).padStart(3, '0')}
Restart=always
RestartSec=3
# 只停 server 本身:tmux 里的终端会话要活过重启和升级。
KillMode=process

[Install]
WantedBy=default.target
`
}

export function launchdPlist(executable: string, home: string, log: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key><array><string>${esc(executable)}</string><string>run</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>GUGU_SERVER_HOME</key><string>${esc(home)}</string>
    <key>GUGU_SERVER_SUPERVISED</key><string>launchd</string>
  </dict>
  <key>Umask</key><integer>${SERVICE_UMASK}</integer>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>${esc(log)}</string>
  <key>StandardErrorPath</key><string>${esc(log)}</string>
</dict>
</plist>
`
}

function unitPath(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user', UNIT_NAME)
}

function plistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
}

function lingerEnabled(user: string): boolean {
  const r = tryRun('loginctl', ['show-user', user, '-p', 'Linger', '--value'])
  return r.ok && r.out === 'yes'
}

/**
 * 在后台起一个脱离终端的 server(兜底模式用;有 systemd/launchd 时交给它们)。
 * #6264 起的是看门人(server-keeper.ts):守护进程崩了、被 OOM 杀了由它再拉起,❌ 以前那样起一次就没人管。
 * extraEnv.GUGU_SERVER_WAIT_PID:第一轮先等这个旧进程退干净。返回看门人的进程号。
 */
export function startDetached(executable: string, extraEnv: NodeJS.ProcessEnv = {}): number | undefined {
  const home = serverHome()
  const waitPid = Number(extraEnv.GUGU_SERVER_WAIT_PID)
  const hasCurrent = fs.existsSync(path.join(home, 'current', 'bin', 'gugu-server'))
  try {
    return startKeeper({
      home,
      logFile: logFile(),
      waitPid: Number.isInteger(waitPid) && waitPid > 0 ? waitPid : undefined,
      executable: hasCurrent ? undefined : executable,
      env: { ...process.env, ...extraEnv },
    })
  } catch (error) {
    try {
      fs.appendFileSync(logFile(), `${new Date().toISOString()} 后台启动 server 失败:${error instanceof Error ? error.message : String(error)}\n`)
    } catch {
      // 日志也写不进去时,调用方看到的进程号为空就是信号
    }
    return undefined
  }
}

/** 写用户服务并 `restart`(没在跑就是启动)。只说注册了什么;在跑的是不是新版本,由调用方看锁里那个进程再报。 */
function registerSystemd(out: Out, executable: string, home: string): void {
  fs.mkdirSync(path.dirname(unitPath()), { recursive: true })
  fs.writeFileSync(unitPath(), systemdUnit(executable, home))
  const steps: Array<[string, string[]]> = [
    ['systemctl', ['--user', 'daemon-reload']],
    ['systemctl', ['--user', 'enable', UNIT_NAME]],
    ['systemctl', ['--user', 'restart', UNIT_NAME]],
  ]
  for (const [cmd, args] of steps) {
    const r = tryRun(cmd, args)
    if (!r.ok) throw new Error(`${cmd} ${args.join(' ')} 失败:${r.out}`)
  }
  removeCronEntry()
  const user = os.userInfo().username
  if (!lingerEnabled(user)) tryRun('loginctl', ['enable-linger', user])
  out(`已注册为 systemd 用户服务(${unitPath()})。`)
  if (lingerEnabled(user)) {
    out('SSH 断开后继续运行、机器重启后自动启动。')
  } else {
    out('⚠ 断开 SSH 或重启后 server 会停。请管理员执行一次:')
    out(`  sudo loginctl enable-linger ${user}`)
  }
}

/** 整份替换当前用户的 crontab。经临时文件喂给 `crontab <文件>`(❌ 同步 spawn 的 input,见 #3766)。 */
function writeCrontab(lines: string[]): void {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-server-cron-')), 'crontab')
  try {
    fs.writeFileSync(file, lines.length ? `${lines.join('\n')}\n` : '')
    execFileSync('crontab', [file], { stdio: ['ignore', 'ignore', 'pipe'] })
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  }
}

/** 兜底模式留下的 @reboot 那一行(换成 systemd / launchd 管、或卸载时去掉,❌ 开机时两边各起一个)。 */
function removeCronEntry(): void {
  if (!hasCrontab()) return
  const existing = tryRun('crontab', ['-l'])
  const lines = existing.ok ? existing.out.split('\n') : []
  if (!lines.some(isCronLine)) return
  try {
    writeCrontab(lines.filter((l) => l && !isCronLine(l)))
  } catch {
    // 删不掉只是开机时多起一个,它会撞在单实例锁上自己退出
  }
}

/** 兜底模式的开机自启:crontab @reboot。返回有没有写成。 */
function registerCron(executable: string, home: string): boolean {
  if (!hasCrontab()) return false
  // #6264 开机起的是看门人(`keep`),不是守护进程本身:之后崩了也有人拉起。路径照 crontab 的规矩转义(空格、引号、%)。
  const line = `@reboot umask 022; GUGU_SERVER_HOME=${cronQuote(home)} ${cronQuote(executable)} keep >> ${cronQuote(logFile())} 2>&1 ${CRON_MARK}`
  const existing = tryRun('crontab', ['-l'])
  const kept = (existing.ok ? existing.out : '').split('\n').filter((l) => l && !isCronLine(l))
  try {
    writeCrontab([...kept, line])
    return true
  } catch {
    return false
  }
}

function registerLaunchd(out: Out, executable: string, home: string): void {
  fs.mkdirSync(path.dirname(plistPath()), { recursive: true })
  fs.writeFileSync(plistPath(), launchdPlist(executable, home, logFile()))
  const uid = String(os.userInfo().uid)
  for (const domain of [`gui/${uid}`, `user/${uid}`]) {
    tryRun('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`])
    const r = tryRun('launchctl', ['bootstrap', domain, plistPath()])
    if (r.ok) {
      out(`已注册为 launchd 用户代理(${plistPath()})。`)
      return
    }
  }
  throw new Error('launchctl bootstrap 失败')
}

// ── 此刻在跑的那一个 ─────────────────────────────────────────────────────────────

/** 此刻在跑的守护进程:单实例锁里的进程号,加上从它自己的环境 / 命令行里读出的版本与托管方。 */
export type RunningServer = {
  pid: number
  version: string | null
  /** 控制器启动的受控云电脑,从活进程环境读取。 */
  managedCloud?: boolean
  /** 谁在管它;unknown = 读不到(macOS 读不了别的进程的环境)。 */
  supervisedBy: 'systemd' | 'launchd' | 'none' | 'unknown'
}

/**
 * 从进程的环境(/proc/<pid>/environ,\0 分隔)与命令行读版本、托管方。启动器(bin/gugu-server)会 export
 * GUGU_TASK_HOST_VERSION,并以 `pwd -P` 解开软链 —— 命令行里是 versions/<版本>/node/bin/node 这样的真实路径,
 * 所以读不到环境时(macOS)从命令行也能认出版本。
 */
export function describeProcess(pid: number, environ: string | null, cmdline: string | null): RunningServer {
  const env = new Map<string, string>()
  for (const entry of (environ ?? '').split('\0')) {
    const eq = entry.indexOf('=')
    if (eq > 0) env.set(entry.slice(0, eq), entry.slice(eq + 1))
  }
  const fromPath = cmdline?.match(/\/versions\/([^/\s]+)\/(?:node|app)\//)?.[1] ?? null
  const supervised = env.get('GUGU_SERVER_SUPERVISED')
  return {
    pid,
    ...(env.get('GUGU_CLOUD_COMPUTER') === '1' ? { managedCloud: true } : {}),
    version: env.get('GUGU_TASK_HOST_VERSION') || fromPath,
    supervisedBy:
      environ === null
        ? 'unknown'
        : supervised === 'systemd' || supervised === 'launchd'
          ? supervised
          : 'none',
  }
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

export function readRunningServer(): RunningServer | null {
  const pid = Number(readText(path.join(supervisorDataDir(), 'server.lock'))?.trim())
  if (!isProcessAlive(pid)) return null
  if (process.platform === 'linux') {
    return describeProcess(pid, readText(`/proc/${pid}/environ`), readText(`/proc/${pid}/cmdline`)?.replace(/\0/g, ' ') ?? null)
  }
  const ps = tryRun('ps', ['-o', 'command=', '-p', String(pid)])
  return describeProcess(pid, null, ps.ok ? ps.out : null)
}

// ── service install ─────────────────────────────────────────────────────────────

/**
 * - launchd / systemd:交给它们(重)启动;
 * - systemdUnreachable:这个用户注册过 systemd 用户服务,但当前 shell 连不上它的用户会话(su、docker exec 进来)
 *   —— ❌ 另起一个后台进程或写 crontab:那会跟 systemd 那一份抢单实例锁;
 * - fallback:没有 systemd 用户会话,后台进程 + crontab @reboot。
 */
export type ServiceMode = 'launchd' | 'systemd' | 'systemdUnreachable' | 'fallback'

export function chooseServiceMode(input: { platform: NodeJS.Platform; systemdReachable: boolean; unitExists: boolean }): ServiceMode {
  if (input.platform === 'darwin') return 'launchd'
  if (input.systemdReachable) return 'systemd'
  return input.unitExists ? 'systemdUnreachable' : 'fallback'
}

/** 起来之后最多等这么久确认「在跑的是新版本」:旧的收子进程最多 30 秒(server-supervisor.ts),新的再起来。 */
const CONFIRM_TIMEOUT_MS = 75_000
const CONFIRM_POLL_MS = 500

export type InstallServiceDeps = {
  mode: ServiceMode
  /** 这次要跑起来的版本(= 执行这条命令的这一份);开发构建为 null,不比版本。 */
  targetVersion: string | null
  running: () => RunningServer | null
  /** 受控云电脑:已登录账号的实际进程是否都在目标包上。 */
  accountsMatchPackage?: (version: string) => boolean
  isAlive: (pid: number) => boolean
  /** 这台机器上有没有 agent 正在干活(跑一轮或等人批准)。 */
  isBusy: () => boolean
  /** 让在跑的那个正常退出(SIGTERM:收子进程、放锁)。 */
  stop: (pid: number) => void
  /** 马上要把在跑的旧版本换下来(重新执行安装命令 = 现在就升级):请升级看门狗盯着,新版本站不稳就退回去。 */
  beforeReplace?: (before: RunningServer) => void
  registerSystemd: (out: Out) => void
  registerLaunchd: (out: Out) => void
  /** 兜底开机自启(crontab @reboot);返回有没有写成。 */
  registerCron: () => boolean
  /** 后台起一个新的;给了 waitPid 就让它等那个进程退干净(放掉单实例锁)再启动 —— 与自动升级换版同一招。 */
  startDetached: (waitPid?: number) => number | undefined
  /** 没跑起来时告诉人去哪看。 */
  logHint: string
  user: string
  sleep: (ms: number) => Promise<void>
  now: () => number
}

const expectedSupervisor = (mode: ServiceMode): RunningServer['supervisedBy'] =>
  mode === 'launchd' ? 'launchd' : mode === 'fallback' ? 'none' : 'systemd'

/**
 * 注册常驻服务,并保证结束时在跑的是这一版。返回 false = 没做到(已经把原因和下一步打出来了)。
 *
 * 已经有一个在跑时,重新执行安装命令就是「现在就升级」(behavior 第 5 条的「急用」):不等空闲,当场换。
 * 正在跑的 agent 那一轮会被中断 —— 先明说;会话记录在库里,终端会话在 tmux 里(三种托管方式都只停守护进程本身),都留着。
 */
export async function installServiceWith(out: Out, deps: InstallServiceDeps): Promise<boolean> {
  const { mode, targetVersion } = deps
  const before = deps.running()
  const label = (version: string | null) => (version ? `咕咕 server ${version}` : '咕咕 server')
  const accountsReady = (running: RunningServer): boolean => !running.managedCloud || !targetVersion || deps.accountsMatchPackage?.(targetVersion) === true
  const alreadyRunning = !!(before && targetVersion && before.version === targetVersion &&
    (before.supervisedBy === 'unknown' || before.supervisedBy === expectedSupervisor(mode)))
  if (before && alreadyRunning && accountsReady(before)) {
    out(`${label(targetVersion)} 已在运行(进程 ${before.pid})。`)
    return true
  }
  if (!alreadyRunning) {
    if (before) {
      out(`正在把 ${label(before.version)}(进程 ${before.pid})换成 ${targetVersion ?? '这一版'}。`)
      if (deps.isBusy()) {
        out('⚠ 有 agent 正在运行,这一轮会被中断。')
      }
    }

    if (before && targetVersion && before.version && before.version !== targetVersion && mode !== 'systemdUnreachable') {
      deps.beforeReplace?.(before)
    }
    switch (mode) {
      case 'systemd':
        deps.registerSystemd(out)
        break
      case 'launchd':
        deps.registerLaunchd(out)
        break
      case 'fallback': {
        const cronOk = deps.registerCron()
        deps.startDetached(before?.pid)
        if (before) deps.stop(before.pid)
        out('没有 systemd 用户会话,改用后台进程常驻。')
        if (cronOk) out('已加入 crontab @reboot,重启后自动启动。')
        else out('⚠ 没有可用的 crontab,重启后需再执行:gugu-server service install')
        break
      }
      case 'systemdUnreachable': {
        if (!before) {
          out('⚠ 当前 shell 连不上 systemd 用户会话(su、docker exec 时常见)。任选其一:')
          out(`  · 以 ${deps.user} 直接 SSH 登录后执行:gugu-server service install`)
          out(`  · 请管理员执行 sudo loginctl enable-linger ${deps.user},再重新安装`)
          return false
        }
        out('当前 shell 连不上 systemd 用户会话,改由 systemd 以新版本重启。')
        // 旧的那个不归 systemd 管(以前兜底起的):照兜底的办法自己接上。
        if (before.supervisedBy === 'none') deps.startDetached(before.pid)
        deps.stop(before.pid)
        break
      }
    }
    // 管理器重启完旧进程还在 = 它不归这个管理器管(以前兜底起的、手动起的):停掉它,管理器那一份会接上。
    if (before && (mode === 'systemd' || mode === 'launchd') && deps.isAlive(before.pid)) deps.stop(before.pid)

  }
  const deadline = deps.now() + CONFIRM_TIMEOUT_MS
  let now: RunningServer | null = null
  for (;;) {
    now = deps.running()
    const replaced = alreadyRunning || !before || now?.pid !== before.pid
    if (now && replaced && (!targetVersion || !now.version || now.version === targetVersion) && accountsReady(now)) {
      out(`${label(now.version ?? targetVersion)} 已在运行(进程 ${now.pid})。`)
      return true
    }
    if (deps.now() >= deadline) break
    await deps.sleep(CONFIRM_POLL_MS)
  }
  if (now && now.managedCloud && now.version === targetVersion && !accountsReady(now)) {
    out(`⚠ 守护进程已运行 ${targetVersion},账号尚未运行目标包。日志:${deps.logHint}`)
  } else if (now && before && now.pid === before.pid) {
    out(`⚠ 旧的 ${label(before.version)}(进程 ${before.pid})没有退出。请执行 gugu-server stop,再执行 gugu-server service install。`)
  } else if (now) {
    out(`⚠ 在运行的是 ${label(now.version)}(进程 ${now.pid}),不是 ${targetVersion}。请执行 gugu-server stop,再执行 gugu-server service install。`)
  } else {
    out(`⚠ server 没有启动。日志:${deps.logHint}`)
  }
  return false
}

export async function installService(out: Out): Promise<boolean> {
  const executable = serviceExecutable()
  const home = serverHome()
  // #6264 记下这个终端里的登录 shell:之后不管由谁在后台拉起,都用它去采用户的环境(server-keeper.ts)。
  recordLoginShell(home, process.env.SHELL)
  const mode = chooseServiceMode({
    platform: process.platform,
    systemdReachable: reachSystemdUserSession(),
    unitExists: fs.existsSync(unitPath()),
  })
  const supervisorLog = path.join(supervisorDataDir(), 'logs', 'supervisor.log')
  return installServiceWith(out, {
    mode,
    targetVersion: process.env.GUGU_TASK_HOST_VERSION ?? null,
    running: readRunningServer,
    accountsMatchPackage: (version) => listAccounts().filter((account) => account.signedIn).every((account) => readAccountRuntime(account.dataDir).version === version),
    isAlive: isProcessAlive,
    isBusy: () => listAccounts().some((account) => account.signedIn && activityProof(account.dataDir) !== 'idle'),
    stop: (pid) => {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // 已经退出了
      }
    },
    beforeReplace: (before) => guardReplacement(home, before, process.env.GUGU_TASK_HOST_VERSION ?? null),
    registerSystemd: (o) => registerSystemd(o, executable, home),
    registerLaunchd: (o) => registerLaunchd(o, executable, home),
    registerCron: () => registerCron(executable, home),
    startDetached: (waitPid) =>
      startDetached(executable, { GUGU_SERVER_HOME: home, ...(waitPid ? { GUGU_SERVER_WAIT_PID: String(waitPid) } : {}) }),
    logHint: mode === 'systemd' || mode === 'systemdUnreachable'
      ? `journalctl --user -u ${UNIT_NAME},以及 ${supervisorLog}`
      : `${logFile()},以及 ${supervisorLog}`,
    user: os.userInfo().username,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
  })
}

/** 重新执行安装命令换版本时,与自动升级同一个看门狗(server-upgrade-guard.ts)。旧版本不在盘上就退不回去,不请。 */
function guardReplacement(home: string, before: RunningServer, target: string | null): void {
  if (!before.version || !target) return
  const fromDir = path.join(home, 'versions', before.version)
  const toDir = path.join(home, 'versions', target)
  if (!fs.existsSync(path.join(fromDir, 'bin', 'gugu-server')) || !fs.existsSync(toDir)) return
  if (writeUpgradeMarker(home, { from: before.version, to: target, fromDir, toDir, switchedAt: Date.now() })) spawnUpgradeGuard(home)
}

export function uninstallService(out: Out): void {
  if (process.platform === 'darwin') {
    const uid = String(os.userInfo().uid)
    for (const domain of [`gui/${uid}`, `user/${uid}`]) tryRun('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`])
    fs.rmSync(plistPath(), { force: true })
  } else {
    if (fs.existsSync(unitPath())) {
      tryRun('systemctl', ['--user', 'disable', '--now', UNIT_NAME])
      fs.rmSync(unitPath(), { force: true })
      tryRun('systemctl', ['--user', 'daemon-reload'])
    }
    removeCronEntry()
  }
  out('已移除常驻服务。停止当前进程:gugu-server stop')
}

/** 一句话说清服务状态,给 `gugu-server status` 用。 */
export function describeService(): string {
  if (process.platform === 'darwin') {
    return fs.existsSync(plistPath()) ? `launchd 用户代理(${plistPath()})` : '未注册常驻服务'
  }
  if (fs.existsSync(unitPath())) {
    const active = tryRun('systemctl', ['--user', 'is-active', UNIT_NAME]).out || 'unknown'
    const linger = lingerEnabled(os.userInfo().username) ? '断开 SSH 后继续运行' : '⚠ 未开启 linger,断开 SSH 后会停'
    return `systemd 用户服务,${active},${linger}`
  }
  const cron = hasCrontab() ? tryRun('crontab', ['-l']) : { ok: false, out: '' }
  if (cron.ok && cron.out.split('\n').some(isCronLine)) return 'crontab @reboot 自启(无 systemd 用户会话)'
  return '未注册常驻服务(执行 gugu-server service install)'
}
