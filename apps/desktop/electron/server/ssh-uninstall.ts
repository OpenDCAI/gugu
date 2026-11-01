/**
 * #6264「设置 → 设备 → 从这台机器上卸载咕咕 server」(只给用 SSH 装上的机器):经同一条 SSH 连过去,
 * 停掉常驻服务与它的终端会话、删掉安装与数据。经 SSH 远程卸载
 * (杀进程、删目录)与 JetBrains「Manage IDE Backends → uninstall」。
 *
 * 两段式,中间停下来等人确认:
 *  ① 看一眼 —— 装的哪个版本、这台机器上登着哪些账号(卸载会让他们一起用不了,确认页要点名);
 *  ② 人确认后才卸 —— 服务注销、server 停下、各账号的 tmux 终端服务端收掉、安装目录与两个软链删掉。
 * 项目文件夹不在咕咕的目录里,不碰。
 *
 * 纯逻辑(脚本、解析)与编排(注入 spawn ssh)都在这里,单测把整条状态机走一遍;接 Electron 的在 ssh-uninstall-ipc.ts。
 */
import type {
  ServerUninstallAccount,
  ServerUninstallInspection,
  ServerUninstallState,
} from '../../src/lib/serverSshMachines'
import type { ServerSshInstallPrompt } from '../../src/lib/serverSshInstall'
import { buildSshArgs, classifySshFailure, lastLines, type SshTarget } from './ssh-install/logic'
import type { SpawnSsh, SshRunResult } from './ssh-install/runner'
import { desktopServerChannel, remoteServerPaths, serverNames } from './server-names'

export const INSPECT_BEGIN = '__GUGU_UNINSTALL_PROBE_BEGIN__'
export const INSPECT_END = '__GUGU_UNINSTALL_PROBE_END__'
export const UNINSTALLED_MARK = '__GUGU_UNINSTALLED__'

/** 卸的是这台桌面那条通道的 server(server-names.ts),同一个用户下别的通道的那份不碰。 */
const { home: SERVER_HOME, bin: SERVER_BIN } = remoteServerPaths(desktopServerChannel())

/** 看一眼:装没装、哪个版本、登着哪些账号(账号 id、有没有登录态、邮箱)。输出夹在两行标记之间。 */
export function inspectScript(): string {
  return [
    `echo ${INSPECT_BEGIN}`,
    `H=${SERVER_HOME}`,
    `B=${SERVER_BIN}`,
    'if [ -d "$H" ] || [ -e "$B" ] || [ -L "$B" ]; then echo installed=1; fi',
    'echo "version=$(cat "$H/current/version" 2>/dev/null)"',
    'for d in "$H"/accounts/*/; do',
    '  [ -f "$d/account.json" ] || continue',
    '  id="$(basename "$d")"',
    '  s=0; [ -f "$d/data/server-session.enc" ] && s=1',
    '  e="$(sed -n \'s/.*"email": *"\\([^"]*\\)".*/\\1/p\' "$d/account.json" | head -n 1)"',
    '  echo "account=$id $s $e"',
    'done',
    `echo ${INSPECT_END}`,
    '',
  ].join('\n')
}

export type InspectedAccount = { userId: string; signedIn: boolean; email: string | null }
export type InspectResult = { installed: boolean; version: string | null; accounts: InspectedAccount[] }

export function parseInspectOutput(stdout: string): InspectResult | null {
  const begin = stdout.lastIndexOf(INSPECT_BEGIN)
  const end = stdout.indexOf(INSPECT_END, begin)
  if (begin < 0 || end < 0) return null
  let installed = false
  let version: string | null = null
  const accounts: InspectedAccount[] = []
  for (const raw of stdout.slice(begin + INSPECT_BEGIN.length, end).split(/\r?\n/)) {
    const line = raw.trim()
    if (line === 'installed=1') installed = true
    else if (line.startsWith('version=')) version = line.slice('version='.length).trim() || null
    else if (line.startsWith('account=')) {
      const [userId, signed, ...rest] = line.slice('account='.length).split(' ')
      if (!userId) continue
      accounts.push({ userId, signedIn: signed === '1', email: rest.join(' ').trim() || null })
    }
  }
  return { installed, version, accounts }
}

/** 给确认页的清单:登着的在前、你自己排第一;没登录态的账号(退出过的)也列出来 —— 它的数据同样会被删。 */
export function toInspection(result: InspectResult, currentUserId: string | null): ServerUninstallInspection {
  const accounts: ServerUninstallAccount[] = result.accounts
    .map((account) => ({ email: account.email, signedIn: account.signedIn, you: account.userId === currentUserId }))
    .sort((a, b) => Number(b.you) - Number(a.you) || Number(b.signedIn) - Number(a.signedIn))
  return { installed: result.installed, version: result.version, accounts }
}

/**
 * 卸载。先把同机别的账号逐个注销(见脚本里的注释);再让 server 自己注销服务、停下(守护进程会收掉各账号的进程);再收各账号的 tmux 终端服务端
 * (server 为了让终端活过升级,停的时候特意不碰它们);最后删目录与指进目录的软链(别处装的同名程序不碰)。
 */
export function uninstallScript(options: { keepUserId?: string | null } = {}): string {
  const keep = options.keepUserId && /^[A-Za-z0-9_-]{1,128}$/.test(options.keepUserId) ? options.keepUserId : ''
  return [
    `H=${SERVER_HOME}`,
    `B=${SERVER_BIN}`,
    // #6264 先把这台机器上每个账号都注销(从账号里移除这台机器、续期令牌作废),照 `code tunnel unregister`:
    // ❌ 只删本地文件 —— 那样别人的账号里一直挂着一台永远离线的机器、云端的会话也一直有效。
    // 桌面自己那个账号(KEEP)由桌面在卸完后自己移除(它知道要不要连同智能体一起删)。老版本不认这条命令:照卸。
    `KEEP='${keep}'`,
    'if [ -x "$B" ]; then',
    '  for d in "$H"/accounts/*/; do',
    '    [ -f "$d/data/server-session.enc" ] || continue',
    '    id="$(basename "$d")"',
    '    [ "$id" = "$KEEP" ] && continue',
    '    "$B" unregister --account "$id" </dev/null 2>/dev/null',
    '  done',
    'fi',
    'if [ -x "$B" ]; then',
    '  "$B" service uninstall </dev/null >/dev/null 2>&1',
    '  "$B" stop </dev/null >/dev/null 2>&1',
    'fi',
    // #6264 老版本的 stop 只停守护进程:守护进程被 kill -9 / OOM 后留下的孤儿账号进程、兜底模式的看门人,
    // 在它的数据目录被删掉之后还会接着跑、接着发心跳。按各把锁里的进程号收掉(命令行对得上才动,❌ 误杀复用了号的进程)。
    'own() { [ -r "/proc/$1/cmdline" ] || return 0; tr "\\000" " " < "/proc/$1/cmdline" | grep -q -e server.js -e gugu-server-keeper; }',
    'P=""',
    'for f in "$H/data/keeper.pid" "$H/data/server.lock" "$H"/accounts/*/data/server.lock; do',
    '  [ -f "$f" ] || continue',
    '  p="$(cat "$f" 2>/dev/null)"; case "$p" in ""|*[!0-9]*) continue ;; esac',
    '  if kill -0 "$p" 2>/dev/null && own "$p"; then kill "$p" 2>/dev/null; P="$P $p"; fi',
    'done',
    'if [ -n "$P" ]; then sleep 3; for p in $P; do kill -0 "$p" 2>/dev/null && own "$p" && kill -9 "$p" 2>/dev/null; done; fi',
    'T="$H/current/app/tmux-bundle/tmux"; [ -x "$T" ] || T=tmux',
    'for d in "$H"/accounts/*/; do',
    '  [ -d "$d" ] || continue',
    '  id="$(basename "$d")"',
    `  "$T" -L "${serverNames(desktopServerChannel()).bin}-$(printf %s "$id" | cut -c1-8)" kill-server >/dev/null 2>&1`,
    'done',
    'for l in "$B" "$HOME/.local/bin/node"; do',
    '  if [ -L "$l" ]; then case "$(readlink "$l")" in "$H"/*) rm -f "$l" ;; esac; fi',
    'done',
    // 命令是一行启动脚本(install.sh 写的):里面钉着的正是这个目录才删。
    'if [ -f "$B" ] && [ ! -L "$B" ] && grep -qF "GUGU_SERVER_HOME=\\"$H\\"" "$B"; then rm -f "$B"; fi',
    'rm -rf "$H"',
    'if [ -e "$H" ]; then echo "卸载失败:删不掉 $H" >&2; exit 1; fi',
    `echo ${UNINSTALLED_MARK}`,
    '',
  ].join('\n')
}

export type UninstallDeps = {
  spawnSsh: SpawnSsh
  controlPath: string | null
  /** 桌面此刻登着的账号,用来在清单里标「你」。 */
  currentUserId: string | null
  /** 等人看完清单:true = 确认卸载,false = 不卸了。 */
  waitForConfirm: () => Promise<boolean>
  signal: AbortSignal
}

class UninstallFailure extends Error {
  constructor(
    readonly reason: NonNullable<ServerUninstallState['failure']>['reason'],
    readonly detail?: string,
  ) {
    super(reason)
  }
}

/** 一次卸载的状态;快照每变一次整份推给界面。 */
export class UninstallRun {
  private state: ServerUninstallState

  constructor(
    runId: string,
    deviceId: string,
    target: string,
    private readonly emit: (state: ServerUninstallState) => void,
  ) {
    this.state = { runId, deviceId, target, phase: 'inspecting', prompt: null, inspection: null, failure: null }
  }

  snapshot(): ServerUninstallState {
    return this.state
  }

  update(mutate: (draft: ServerUninstallState) => void): void {
    const draft = structuredClone(this.state)
    mutate(draft)
    this.state = draft
    this.emit(draft)
  }

  setPrompt(prompt: ServerSshInstallPrompt | null): void {
    this.update((draft) => {
      draft.prompt = prompt
    })
  }
}

export async function runSshUninstall(target: SshTarget, run: UninstallRun, deps: UninstallDeps): Promise<ServerUninstallState> {
  const args = buildSshArgs(target, { controlPath: deps.controlPath })
  const ssh = async (stdin: string): Promise<SshRunResult> => {
    if (deps.signal.aborted) throw new UninstallFailure('cancelled')
    let result: SshRunResult
    try {
      result = await deps.spawnSsh(args, { stdin, signal: deps.signal })
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') throw new UninstallFailure('sshMissing')
      throw new UninstallFailure('unknown', error instanceof Error ? error.message : String(error))
    }
    if (deps.signal.aborted) throw new UninstallFailure('cancelled')
    if (result.code === 255) throw new UninstallFailure(classifySshFailure(result.stderr), lastLines(result.stderr))
    return result
  }

  try {
    const inspected = await ssh(inspectScript())
    const parsed = parseInspectOutput(inspected.stdout)
    if (!parsed) throw new UninstallFailure('unknown', lastLines(`${inspected.stdout}\n${inspected.stderr}`))
    run.update((draft) => {
      draft.prompt = null
      draft.inspection = toInspection(parsed, deps.currentUserId)
      draft.phase = 'confirm'
    })
    if (!(await deps.waitForConfirm())) throw new UninstallFailure('cancelled')
    run.update((draft) => {
      draft.phase = 'uninstalling'
    })
    const removed = await ssh(uninstallScript({ keepUserId: deps.currentUserId }))
    if (removed.code !== 0 || !removed.stdout.includes(UNINSTALLED_MARK)) {
      const own = removed.stderr.split(/\r?\n/).reverse().find((line) => line.startsWith('卸载失败'))
      throw new UninstallFailure('uninstallFailed', own ?? lastLines(`${removed.stdout}\n${removed.stderr}`))
    }
    run.update((draft) => {
      draft.prompt = null
      draft.phase = 'done'
    })
  } catch (error) {
    const failure = error instanceof UninstallFailure ? error : new UninstallFailure('unknown', error instanceof Error ? error.message : String(error))
    run.update((draft) => {
      draft.prompt = null
      draft.phase = failure.reason === 'cancelled' ? 'cancelled' : 'failed'
      draft.failure = failure.reason === 'cancelled' ? null : { reason: failure.reason, ...(failure.detail ? { detail: failure.detail } : {}) }
    })
  }
  return run.snapshot()
}
