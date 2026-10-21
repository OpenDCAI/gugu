/**
 * #6264 兜底模式(没有 systemd 用户会话的 Linux:容器、WSL、精简系统)的「看门人」。
 *
 * 有 systemd / launchd 时,守护进程挂了由它们拉起(Restart=always / KeepAlive)。兜底模式以前只是
 * 「后台起一个」—— 守护进程被 OOM、kill -9、崩掉之后就再没人管,机器在所有端显示离线,要人去重新执行安装命令。
 * 这里补的就是 systemd 那一格:一个 POSIX sh 的循环(runit / daemontools 的 supervise 同一个做法),
 * 守护进程退了就按 current 软链再起一次 —— 升级换版也因此只剩「切软链 + 退出」,与 systemd 下一模一样。
 *
 * 为什么是 sh 而不是再起一个 node:常驻只占约 1MB;它自己几乎不可能坏(不加载任何咕咕代码),
 * 坏包也坏不到它 —— 它每一轮都重新解析 current。
 *
 * 什么时候不再拉起(三种,缺一种都会变成「停不掉」):
 *  ① 有人明确要停:`gugu-server stop` / 收到 SIGTERM、SIGINT 的守护进程先写下 data/stopped;
 *  ② 被新的看门人接替:data/keeper.pid 里已经不是自己(重新执行安装命令时新的一个接班);
 *  ③ 守护进程说「这台机器上已经有一个在跑」(退出码 {@link SUPERVISOR_EXIT_ALREADY_RUNNING}):两边会一直互相顶。
 * 升级换版、看门狗回滚要的是「请重启」:守护进程退出时不写 stopped,看门人照常再起。
 *
 * 开销:守护进程活着时看门人阻塞在 wait 上,零轮询;只有「接手一个已在跑的守护进程」那一段每 10 秒读一次
 * /proc/<pid>/stat(一次 sed,微秒级)。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isProcessAlive, readProcCmdline } from './process-alive'
import { quoteShellArg } from '../session/main/utils/shellEscape'

/** 守护进程发现锁被另一个活着的守护进程占着时的退出码:看门人见到它就收手。 */
export const SUPERVISOR_EXIT_ALREADY_RUNNING = 4
/** 看门人两次拉起之间至少隔这么久(与 systemd 单元的 RestartSec=3 同一量级)。 */
export const KEEPER_RESTART_DELAY_S = 3
const KEEPER_MARK = 'gugu-server-keeper'

export const keeperPidFile = (home: string): string => path.join(home, 'data', 'keeper.pid')
export const stopFlagFile = (home: string): string => path.join(home, 'data', 'stopped')
export const loginShellFile = (home: string): string => path.join(home, 'data', 'login-shell')


/**
 * 看门人脚本。`adoptPid`:先等这个已经在跑的守护进程退出再接手(它不归任何人管时,由它自己请看门人来);
 * `waitPid`:第一轮起的守护进程要等这个旧进程退干净(放掉单实例锁)再启动 —— 与升级换版同一招。
 */
export function keeperScript(home: string, options: { adoptPid?: number; waitPid?: number; executable?: string } = {}): string {
  const data = path.join(home, 'data')
  // 装过(有 current)就每一轮按 current 解析 —— 升级换版、回滚只切软链;没有 current(手动解包)用给定的那一份。
  const exe = options.executable ?? path.join(home, 'current', 'bin', 'gugu-server')
  return [
    `# ${KEEPER_MARK}`,
    `H=${quoteShellArg(home)}; D=${quoteShellArg(data)}; E=${quoteShellArg(exe)}`,
    'mkdir -p "$D"; echo $$ > "$D/keeper.pid"',
    // 与 process-alive.ts 同一个判据:僵尸(Z)不算活着 —— 容器里 PID 1 常常不收尸。
    'alive() { if [ -r "/proc/$1/stat" ]; then s=$(sed \'s/.*) //\' "/proc/$1/stat" | cut -c1); [ "$s" != Z ] && [ "$s" != X ]; elif [ -d /proc/self ]; then return 1; else kill -0 "$1" 2>/dev/null; fi; }',
    'mine() { [ "$(cat "$D/keeper.pid" 2>/dev/null)" = "$$" ]; }',
    options.adoptPid ? `while alive ${options.adoptPid}; do sleep 10; done` : ':',
    options.adoptPid ? '{ [ -f "$D/stopped" ] || ! mine; } && exit 0' : ':',
    `W=${options.waitPid ? String(options.waitPid) : "''"}`,
    // 第一轮不看 stopped:接班时旧守护进程收到 SIGTERM 会写下它,那是说给旧看门人听的。
    'first=1',
    'while :; do',
    '  if [ -z "$first" ]; then [ -f "$D/stopped" ] && break; mine || break; fi; first=',
    '  GUGU_SERVER_HOME="$H" GUGU_SERVER_SUPERVISED=keeper GUGU_SERVER_WAIT_PID="$W" "$E" run',
    '  code=$?; W=\'\'',
    '  [ -f "$D/stopped" ] && break',
    '  mine || break',
    `  [ "$code" = ${SUPERVISOR_EXIT_ALREADY_RUNNING} ] && break`,
    `  sleep ${KEEPER_RESTART_DELAY_S}`,
    'done',
    'if mine; then rm -f "$D/keeper.pid"; fi',
    '',
  ].join('\n')
}

/** 起一个脱离终端的看门人。日志(守护进程的 stdout/stderr)进 `logFile`。返回看门人的进程号。 */
export function startKeeper(input: {
  home: string
  logFile: string
  adoptPid?: number
  waitPid?: number
  executable?: string
  env?: NodeJS.ProcessEnv
}): number | undefined {
  fs.mkdirSync(path.join(input.home, 'data'), { recursive: true })
  // 新的看门人就是「要它跑」:以前 stop 留下的记号作废。
  fs.rmSync(stopFlagFile(input.home), { force: true })
  const fd = fs.openSync(input.logFile, 'a')
  try {
    const child = spawn('/bin/sh', ['-c', keeperScript(input.home, input)], {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: { ...(input.env ?? process.env), GUGU_SERVER_SUPERVISED: '' },
    })
    child.on('error', () => undefined)
    child.unref()
    return child.pid
  } finally {
    fs.closeSync(fd)
  }
}

/** 这台机器上有没有一个活着的看门人(pid 文件在、进程活着、命令行是看门人脚本)。 */
export function liveKeeperPid(home: string, deps: { isAlive?: (pid: number) => boolean; cmdline?: (pid: number) => string | null } = {}): number | null {
  const isAlive = deps.isAlive ?? isProcessAlive
  const cmdline = deps.cmdline ?? readProcCmdline
  let pid: number
  try {
    pid = Number(fs.readFileSync(keeperPidFile(home), 'utf8').trim())
  } catch {
    return null
  }
  if (!isAlive(pid)) return null
  const line = cmdline(pid)
  // 读不到命令行(macOS 读不了别人的 /proc)时按活着算;读得到就必须真是看门人 —— pid 被别的进程复用了不算。
  if (line !== null && !line.includes(KEEPER_MARK)) return null
  return pid
}


/** 「有人要它停」:写下记号,看门人见到就不再拉起。 */
export function markStopped(home: string): void {
  try {
    fs.mkdirSync(path.join(home, 'data'), { recursive: true })
    fs.writeFileSync(stopFlagFile(home), `${new Date().toISOString()}\n`)
  } catch {
    // 写不进(磁盘满)时最坏是看门人把它再拉起来一次;不能因此让停止本身失败
  }
}

export function clearStopped(home: string): void {
  try {
    fs.rmSync(stopFlagFile(home), { force: true })
  } catch {
    // 同上
  }
}

// ── 登录 shell ───────────────────────────────────────────────────────────────

/**
 * 后台起的 server 该用哪个 shell 去采用户的登录环境(nvm / conda 装的 claude、node 在哪)。
 * cron 给的是 /bin/sh、`docker exec` 进来的环境里干脆没有 SHELL —— 用它们采样只读得到 ~/.profile。
 * 顺序:安装时那个交互终端里的 $SHELL(用户实际在用的)→ /etc/passwd 里的登录 shell → 进程环境 → 不改。
 * 每一项都要真是个能执行的文件;nologin / false 这类「禁止登录」的不算。
 */
export function resolveLoginShell(input: {
  recorded: string | null
  passwd: string | null
  env: string | undefined
  isExecutable: (file: string) => boolean
}): string | null {
  const usable = (shell: string | null | undefined): shell is string =>
    Boolean(shell && shell.startsWith('/') && !/(nologin|\/false)$/.test(shell) && input.isExecutable(shell))
  for (const candidate of [input.recorded?.trim(), input.passwd?.trim(), input.env?.trim()]) {
    if (usable(candidate)) return candidate
  }
  return null
}

const isExecutableFile = (file: string): boolean => {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** 安装时记下这个终端里的 $SHELL(`service install` 调)。 */
export function recordLoginShell(home: string, shell: string | undefined): void {
  if (!shell || !shell.startsWith('/')) return
  try {
    fs.mkdirSync(path.join(home, 'data'), { recursive: true })
    fs.writeFileSync(loginShellFile(home), `${shell}\n`)
  } catch {
    // 记不下只是退回 passwd 里的那个
  }
}

/** 守护进程启动时把 SHELL 定下来,账号进程与它们起的 agent、终端都继承这一份。 */
export function applyLoginShell(home: string, env: NodeJS.ProcessEnv = process.env): string | null {
  let recorded: string | null = null
  try {
    recorded = fs.readFileSync(loginShellFile(home), 'utf8')
  } catch {
    recorded = null
  }
  let passwd: string | null = null
  try {
    passwd = os.userInfo().shell
  } catch {
    passwd = null
  }
  const shell = resolveLoginShell({ recorded, passwd, env: env.SHELL, isExecutable: isExecutableFile })
  if (shell) env.SHELL = shell
  return shell
}
