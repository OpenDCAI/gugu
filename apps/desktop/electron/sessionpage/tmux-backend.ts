// #6264 编程会话的推理后台放进 tmux,活过宿主进程(server 的账号进程、桌面主进程)重启。
//
// 三家编程会话的推理不在用户看的那个终端里跑,而在咕咕替它起的一个后台进程里:codex 的 `app-server`、
// opencode / mimocode 的 `opencode serve`、droid 的 `daemon`。终端(TUI)只是它的客户端。终端早就住进了 tmux,
// 宿主换人它照跑;后台却是宿主的子进程,宿主一走它就被收掉 —— 于是终端还在、推理没了(spec gugu-server 第 5 条)。
//
// 照 VS Code 的持久终端:终端进程不归窗口,归一个独立的 ptyHost;窗口重载只断开连接,新窗口按 id 接回同一个进程;
// 没人来接的孤儿过一段宽限就收掉(src/vs/platform/terminal/common/terminal.ts `LocalReconnectConstants.GraceTime`)。
// 这里的对应:
//  · 后台进程归 tmux 服务器,❌ 归宿主:会话名 `gugubk-<终端会话名的编码段>`,与终端一一对应;
//  · 宿主退出只断开连接(不杀);新宿主在同一地址(套接字 / 端口记在 tmux 会话的用户选项上)按名字接回;
//  · 孤儿 = 终端会话已经不在:终端会话一关,tmux 的 session-closed 钩子当场收掉它的后台(咕咕自己的 tmux 服务器才挂);
//    宿主启动时再按名字对一遍(一次 list-sessions),漏网的收掉。❌ 不轮询。
//
// 环境 ❌ 进命令行(里面有 MCP 授权、平台中转口令):写进一份 0600 的启动脚本,由 `env -i /bin/sh <脚本>` 读完即删,
// 而且 `env -i` 先把 tmux 服务器自己的全局环境清空 —— 那是第一次起服务器那条会话的环境,不是这一条的。
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import { closeSync, openSync, readSync, fstatSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  getConfiguredTmuxSocketLabel,
  TMUX_SESSION_PREFIX,
  tmuxExecArgs,
} from '../session/main/core/pty/tmux-session-name'
import { quoteShellArg } from '../session/main/utils/shellEscape'
import { ensurePrivateSocketDir } from './codex-app-server-transport'
import { createLogger } from '../lib/logger'

const execFileAsync = promisify(execFile)
const log = () => createLogger('sessionpage/tmux-backend')

export const BACKEND_SESSION_PREFIX = 'gugubk-'
export type TmuxBackendKind = 'codex-app-server' | 'opencode-serve' | 'droid-daemon'
const KIND_OPTION = '@gugu-backend-kind'
const ENDPOINT_OPTION = '@gugu-backend-endpoint'
const LOG_OPTION = '@gugu-backend-log'
/** session-closed 钩子的数组下标:只占咕咕自己这一格,❌ 覆盖别人挂在同一钩子上的命令。 */
const CLOSE_HOOK = 'session-closed[6264]'
const STDERR_TAIL_BYTES = 8 * 1024

/** 终端会话 `gugu-<x>` 的后台叫 `gugubk-<x>`。不是咕咕的终端会话名 → null(那就没有可以跟着活的终端)。 */
export function backendSessionNameFor(tuiSessionName: string | undefined | null): string | null {
  if (!tuiSessionName?.startsWith(TMUX_SESSION_PREFIX)) return null
  const encoded = tuiSessionName.slice(TMUX_SESSION_PREFIX.length)
  return encoded ? `${BACKEND_SESSION_PREFIX}${encoded}` : null
}

function tuiSessionNameFor(backendName: string): string {
  return `${TMUX_SESSION_PREFIX}${backendName.slice(BACKEND_SESSION_PREFIX.length)}`
}

export type TmuxBackendDeps = {
  /** 跑一条 tmux 命令(已含 `-L`),回 stdout。 */
  tmux: (args: string[]) => Promise<string>
  /** 挂不挂 session-closed 钩子:只在咕咕自己的 tmux 服务器(有套接字标签)上挂,❌ 动用户自己的 tmux。 */
  ownServer: () => boolean
  isPidAlive: (pid: number) => boolean
  signalGroup: (pgid: number, signal: NodeJS.Signals) => void
  scratchDir: () => string
  sleep: (ms: number) => Promise<void>
}

export const defaultTmuxBackendDeps: TmuxBackendDeps = {
  tmux: async (args) => {
    const { command, args: full } = tmuxExecArgs({ supportsLocalSpawn: true }, args)
    return (await execFileAsync(command, full, { timeout: 10_000 })).stdout
  },
  ownServer: () => Boolean(getConfiguredTmuxSocketLabel()),
  isPidAlive: (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  },
  signalGroup: (pgid, signal) => {
    try {
      process.kill(-pgid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  },
  scratchDir: () => {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'x'
    const dir = join(tmpdir(), `gugu-bk-${uid}`)
    if (!ensurePrivateSocketDir(dir)) throw new Error(`tmux backend: private scratch dir ${dir} is not usable`)
    return dir
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

/** tmux 里的一台后台。pid = pane 进程 = 守着后台的那个 sh,也是它那一组的组长(tmux 给每个 pane setsid;后台与它同组)。 */
export class TmuxBackend {
  constructor(
    readonly name: string,
    readonly kind: TmuxBackendKind,
    readonly endpoint: string,
    readonly pid: number,
    private readonly logPath: string,
    private readonly deps: TmuxBackendDeps = defaultTmuxBackendDeps,
  ) {}

  /** 一次 kill(pid, 0):不起进程、不轮询。 */
  isAlive(): boolean {
    return this.pid > 0 && this.deps.isPidAlive(this.pid)
  }

  /** 启动失败时拿来说人话的那段 stderr(后台的 stderr 写进这份日志)。 */
  stderrTail(): string {
    if (!this.logPath) return ''
    try {
      const fd = openSync(this.logPath, 'r')
      try {
        const size = fstatSync(fd).size
        const length = Math.min(size, STDERR_TAIL_BYTES)
        const buffer = Buffer.alloc(length)
        readSync(fd, buffer, 0, length, size - length)
        return buffer.toString('utf8')
      } finally {
        closeSync(fd)
      }
    } catch {
      return ''
    }
  }

  /** 会话真结束:整组 TERM → 等 → KILL,证明整组没了再关 tmux 会话、删日志。 */
  async terminate(termTimeoutMs = 5_000, killTimeoutMs = 1_000): Promise<void> {
    if (this.pid > 0 && this.isAlive()) {
      this.deps.signalGroup(this.pid, 'SIGTERM')
      if (!(await this.waitGone(termTimeoutMs))) {
        this.deps.signalGroup(this.pid, 'SIGKILL')
        if (!(await this.waitGone(killTimeoutMs))) {
          throw new Error(`tmux backend ${this.name} (pid ${this.pid}) survived SIGTERM and SIGKILL`)
        }
      }
    }
    await this.deps.tmux(['kill-session', '-t', this.name]).catch(() => undefined)
    if (this.logPath) rmSync(this.logPath, { force: true })
  }

  private async waitGone(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!this.isAlive()) return true
      await this.deps.sleep(50)
    }
    return !this.isAlive()
  }
}

export type TmuxBackendLaunch = {
  name: string
  kind: TmuxBackendKind
  /** 新宿主接回时连的地址(unix://… / ws://… / http://…),记在会话的用户选项上。 */
  endpoint: string
  command: string
  args: readonly string[]
  env: NodeJS.ProcessEnv
  cwd: string
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * 启动脚本:先删自己,再导出这一份环境、进工作目录,然后把后台作为**子进程**起来并守着它。
 *
 * 为什么不 `exec` 成后台、也不把它的 stdin 接到 /dev/null(实测 tmux 3.7c,两条都踩过):
 *  · pane 里的 pty 一旦**没有任何进程还开着它**,tmux 就当 pane 已死、发 SIGHUP 收掉 ——
 *    后台把 0/1/2 全重定向走就正是这样,起来即死。所以守着它的 sh 自己的 0/1/2 留在 pty 上。
 *  · codex app-server 不理 SIGHUP:终端会话一关(tmux 发 SIGHUP),后台会留下来。所以 sh 接住
 *    HUP / TERM,转成对整组的 TERM(后台与它同组 —— 非交互 sh 不做作业控制)。
 * pane 进程 = 这个 sh = 组长;后台退出 → wait 返回 → sh 退出 → pane 关。
 */
export function buildLaunchScript(launch: Pick<TmuxBackendLaunch, 'command' | 'args' | 'env' | 'cwd'>, logPath: string): string {
  const lines = ['rm -f "$0"']
  for (const [name, value] of Object.entries(launch.env)) {
    if (value === undefined || !ENV_NAME.test(name)) continue
    lines.push(`export ${name}=${quoteShellArg(value)}`)
  }
  lines.push(`cd ${quoteShellArg(launch.cwd)} || exit 97`)
  lines.push(`trap 'trap - TERM; kill -TERM 0; exit 129' HUP TERM`)
  const argv = [launch.command, ...launch.args].map(quoteShellArg).join(' ')
  lines.push(`${argv} >/dev/null 2>>${quoteShellArg(logPath)} &`)
  lines.push('wait $!')
  return `${lines.join('\n')}\n`
}

/**
 * 在 tmux 里起一台后台。一条 tmux 调用里依次:建会话、记类型与地址、(自家服务器上)挂收孤儿的钩子、回 pane pid。
 * 同名会话已在 = 调用方没先接回就来起新的,是编程错误 → tmux 报 duplicate session,这里原样抛。
 */
export async function launchTmuxBackend(
  launch: TmuxBackendLaunch,
  deps: TmuxBackendDeps = defaultTmuxBackendDeps,
): Promise<TmuxBackend> {
  const dir = deps.scratchDir()
  const id = crypto.randomBytes(6).toString('hex')
  const scriptPath = join(dir, `launch-${id}.sh`)
  const logPath = join(dir, `${launch.name.slice(0, 48)}-${id}.log`)
  writeFileSync(scriptPath, buildLaunchScript(launch, logPath), { mode: 0o600 })
  const args = [
    'new-session', '-d', '-s', launch.name, '-x', '200', '-y', '50',
    `env -i /bin/sh ${quoteShellArg(scriptPath)}`,
    ';', 'set-option', '-t', launch.name, KIND_OPTION, launch.kind,
    ';', 'set-option', '-t', launch.name, ENDPOINT_OPTION, launch.endpoint,
    ';', 'set-option', '-t', launch.name, LOG_OPTION, logPath,
  ]
  if (deps.ownServer()) {
    // 终端会话 `gugu-x` 一关 → 杀 `gugubk-x`。对别的会话名,替换不命中、kill 找不到目标,无害。
    args.push(';', 'set-hook', '-g', CLOSE_HOOK,
      `run-shell -C "kill-session -t \\"#{s/^${TMUX_SESSION_PREFIX}/${BACKEND_SESSION_PREFIX}/:hook_session_name}\\""`)
  }
  args.push(';', 'display-message', '-p', '-t', launch.name, '#{pane_pid}')
  let stdout: string
  try {
    stdout = await deps.tmux(args)
  } catch (error) {
    rmSync(scriptPath, { force: true })
    const tail = new TmuxBackend(launch.name, launch.kind, launch.endpoint, 0, logPath, deps).stderrTail().trim()
    rmSync(logPath, { force: true })
    throw new Error(`tmux backend ${launch.kind} did not start: ${error instanceof Error ? error.message : String(error)}${tail ? ` | ${tail}` : ''}`)
  }
  const pid = Number(stdout.trim().split('\n').pop())
  if (!Number.isInteger(pid) || pid <= 1) {
    throw new Error(`tmux backend ${launch.kind} started without a pane pid (${stdout.trim()})`)
  }
  log().info({ name: launch.name, kind: launch.kind, pid }, 'tmux backend started')
  return new TmuxBackend(launch.name, launch.kind, launch.endpoint, pid, logPath, deps)
}

/** list-sessions 的字段分隔。❌ 用制表符:tmux 把格式输出里的不可见字符换成 `_`(实测 3.7c)。 */
const FIELD_SEP = '|@|'

type ListedSession = { name: string; pid: number; kind: string; endpoint: string; logPath: string }

async function listSessions(deps: TmuxBackendDeps): Promise<ListedSession[] | null> {
  let stdout: string
  try {
    stdout = await deps.tmux([
      'list-sessions', '-F',
      [`#{session_name}`, '#{pane_pid}', `#{${KIND_OPTION}}`, `#{${ENDPOINT_OPTION}}`, `#{${LOG_OPTION}}`].join(FIELD_SEP),
    ])
  } catch (error) {
    // 机器上没有 tmux = 没有任何后台住在 tmux 里(读数,不是故障)。
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    const detail = `${(error as { stderr?: unknown }).stderr ?? ''} ${error instanceof Error ? error.message : String(error)}`
    if (/no server running|error connecting to .*\(No such file or directory\)/i.test(detail)) return []
    log().warn({ err: detail.trim() }, 'tmux backend: cannot list sessions')
    return null
  }
  return stdout.split('\n').filter(Boolean).map((line) => {
    const [name = '', pid = '', kind = '', endpoint = '', logPath = ''] = line.split(FIELD_SEP)
    return { name, pid: Number(pid), kind, endpoint, logPath }
  })
}

/** 按名字找一台还活着的后台。找不到(没有这个会话、没有 tmux 服务器、tmux 调用失败)→ null,调用方新起一台。 */
export async function findTmuxBackend(
  name: string,
  kind: TmuxBackendKind,
  deps: TmuxBackendDeps = defaultTmuxBackendDeps,
): Promise<TmuxBackend | null> {
  const listed = (await listSessions(deps))?.find((session) => session.name === name)
  if (!listed || listed.kind !== kind || !listed.endpoint || !(listed.pid > 1)) return null
  const backend = new TmuxBackend(listed.name, kind, listed.endpoint, listed.pid, listed.logPath, deps)
  if (!backend.isAlive()) {
    await deps.tmux(['kill-session', '-t', name]).catch(() => undefined)
    return null
  }
  return backend
}

let startupSweep: Promise<unknown> = Promise.resolve()

/** 宿主启动时那一次清扫(只发起一次)。失败只记 warn:清扫是尽力而为,❌ 拦启动。 */
export function startTmuxBackendStartupSweep(): void {
  startupSweep = sweepOrphanTmuxBackends().catch((error: unknown) => {
    log().warn({ err: error }, 'startup sweep of tmux backends failed')
  })
}

/** 启动清扫落定(没发起过 = 已落定)。要按名字改 tmux 会话的启动步骤先等它,免得改到一半被它当孤儿收掉。 */
export function tmuxBackendStartupSweepSettled(): Promise<unknown> {
  return startupSweep
}

/**
 * 宿主启动时对一遍:终端会话已经不在的后台就是孤儿,收掉。一次 list-sessions + 每个孤儿一次收尾,只在启动时跑。
 * tmux 调用失败 → 什么都不动(❌ 当成空集去杀:那会把正在用的后台收掉)。
 */
export async function sweepOrphanTmuxBackends(
  deps: TmuxBackendDeps = defaultTmuxBackendDeps,
): Promise<{ kept: number; reaped: string[] }> {
  const sessions = await listSessions(deps)
  if (!sessions) return { kept: 0, reaped: [] }
  const names = new Set(sessions.map((session) => session.name))
  const reaped: string[] = []
  let kept = 0
  for (const session of sessions) {
    if (!session.name.startsWith(BACKEND_SESSION_PREFIX)) continue
    if (names.has(tuiSessionNameFor(session.name))) {
      kept++
      continue
    }
    const kind = (session.kind || 'codex-app-server') as TmuxBackendKind
    await new TmuxBackend(session.name, kind, session.endpoint, session.pid, session.logPath, deps)
      .terminate()
      .then(() => reaped.push(session.name))
      .catch((error: unknown) => log().warn({ name: session.name, err: String(error) }, 'tmux backend: orphan reap failed'))
  }
  if (reaped.length > 0 || kept > 0) log().info({ kept, reaped }, 'tmux backend: startup sweep')
  return { kept, reaped }
}
