// @@@2125①b — 启动残留引擎进程组回收(补 ①a 的缺口)。
//
// ①a(#2132)在崩溃/信号路径(SIGINT/SIGTERM/uncaughtException/will-quit)同步硬杀所有引擎进程组。但 **SIGKILL /
// 断电 / OOM kill 不可捕获** → 那些 handler 根本不跑 → 上一轮的引擎进程组(claude-agent-acp / codex-acp 及其孙进程
// provider 子进程 re-parent 到 PID1 成孤儿,一直活到下次开机。①b 在**启动**时扫上一轮落下的 pidfile,把仍存活的
// 孤儿组收掉。
//
// 安全第一(宁可漏杀不可错杀):只有「① 记录的 owner main 已确认退出(独立 userData 的实例可能共用 GUGU_HOME)
// ② 记录的组长 pid 仍存活 ③ 存活进程的 cmdline 里**原样**含我们启动时记录的 endpoint」三者全中,才硬杀整组/进程树。
// 防 PID 重用:endpoint 是那次 spawn 独有的地址,别的进程 cmdline 不会含它。
// POSIX 用 detached process group + SIGKILL；Windows 用树根 PID + taskkill /T /F。

import { createHash } from 'node:crypto'
import { readdir, readFile, unlink } from 'node:fs/promises'
import { execFile, execFileSync } from '@gugu/core/local/childProcess'
import { promisify } from 'node:util'
import path from 'node:path'
import { atomicWriteText, resolveGuguHome } from '@gugu/core/local/state/paths'

const execFileAsync = promisify(execFile)

/** 引擎 spawn 时落盘的一条 pidfile 记录(组长 pid + 归属 + 反 PID 重用所需的启动 argv)。 */
export interface EnginePidRecord {
  /** POSIX detached 进程组长 / Windows 进程树根 pid(= child.pid)。 */
  pgid: number
  /** spawn 它的 Electron main 进程 pid。另一实例可能仍存活,PID 不同不能证明是残留。 */
  ownerMainPid: number
  engineId: string
  agentUserId: string
  conversationId: string
  threadRootId: string | null
  cwd: string
  /** launch.command(argv[0],通常 = node/Electron execPath)——仅诊断,**不**用于匹配。 */
  command: string
  /** launch.args(argv[1..],含适配器入口脚本路径)——反 PID 重用的匹配源。 */
  args: string[]
  startedAt: number
}

/**
 * engine-pids 目录(gugu home 下,沿用 acp-sessions/runtime-sessions 兄弟目录惯例)。
 *
 * @@@3890⑬ **全模块只此一处解析台账目录,且只认 `process.env`**,写侧删侧读侧不再各有一个 env 参数。
 * 这条台账记的是 `ownerMainPid` —— 它是**主进程**的簿子,不是某个账号的状态,所以只能有一个位置:
 * 收尸的那个进程自己的 home。曾经写侧/删侧各带一个 `env` 形参,sessionpage 那条 codex app-server 顺手把
 * spawn 用的 childEnv 传了进去;childEnv 的 GUGU_HOME 来自 capability bundle,附加账号是
 * `<userData>/gugu-home-accounts/<id>` —— 台账于是落进一个 `createReapDeps()` 从不扫描的目录,
 * 那些引擎组既收不到、也不计进 retained,永久泄漏且无人知道。删掉形参 = 这个分叉在类型层面不存在。
 */
export function enginePidDir(): string {
  return path.join(resolveGuguHome(process.env), 'engine-pids')
}

/** 按会话隔离三元组(agent, conversation, thread)哈希出稳定文件名;写/删两侧同源。 */
export function enginePidfileName(agentUserId: string, conversationId: string, threadRootId: string | null | undefined): string {
  const key = JSON.stringify([agentUserId, conversationId, threadRootId ?? null])
  return `${createHash('sha256').update(key).digest('hex').slice(0, 40)}.json`
}

/** 解析 pidfile 文本 → 记录;字段缺失/类型不对/JSON 坏 → null(调用方删该坏文件)。fail-loud:不静默兜。 */
export function parseEnginePidfile(text: string): EnginePidRecord | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.pgid !== 'number' || !Number.isInteger(r.pgid) || r.pgid <= 0) return null
  if (typeof r.ownerMainPid !== 'number' || !Number.isInteger(r.ownerMainPid)) return null
  if (!Array.isArray(r.args) || !r.args.every((a) => typeof a === 'string')) return null
  if (typeof r.engineId !== 'string' || typeof r.agentUserId !== 'string') return null
  return {
    pgid: r.pgid,
    ownerMainPid: r.ownerMainPid,
    engineId: r.engineId,
    agentUserId: r.agentUserId,
    conversationId: typeof r.conversationId === 'string' ? r.conversationId : '',
    threadRootId: typeof r.threadRootId === 'string' ? r.threadRootId : null,
    cwd: typeof r.cwd === 'string' ? r.cwd : '',
    command: typeof r.command === 'string' ? r.command : '',
    args: r.args as string[],
    startedAt: typeof r.startedAt === 'number' ? r.startedAt : 0,
  }
}

// 存活进程是否**确实**是我们记录的那个引擎组长(→ 可安全 SIGKILL)。台账只有一个写入方:会话页那条
// codex app-server 投递(`codex-app-server-delivery.ts`),按记录的 exact endpoint 认 —— endpoint 是这次 spawn
// 独有的 unix:// / ws:// 地址,别的进程 cmdline 不会原样含它,PID 被重用也不中。认不出 ⇒ 不杀(宁可漏杀)。
export function shouldReapEngineGroup(input: {
  liveCmdline: string
  recordedArgs: readonly string[]
  engineId?: string
}): boolean {
  if (!input.liveCmdline || input.engineId !== 'codex-app-server') return false
  const recorded = input.recordedArgs.join(' ')
  const endpoint = recorded.match(/(?:unix|ws):\/\/[^\s"']+/)?.[0]
  return Boolean(endpoint && recorded.includes('app-server')
    && input.liveCmdline.includes('app-server') && input.liveCmdline.includes(endpoint))
}

// ── @@@2146② reap-先于-spawn 时序不变量的运行期锁 ────────────────────────────────────────────
// 回收的正确性依赖「reapResidualEngineGroupsOnce 先于本轮任何引擎 spawn **完成**」。反例(若被重构打乱顺序):
// 本轮引擎 spawn 拿到 pgid=P;OS 恰把上一轮已死引擎的 pid P 重用给它;上一轮遗留 pidfile 也记 pgid=P
// (ownerMainPid≠本轮 → 不被 skippedOwn 跳过)。此时 reap 才运行 → isPidAlive(P)=真、cmdline 含同一适配器
// marker → shouldReap=真 → **SIGKILL 掉本轮刚 spawn 的活引擎**(静默误杀)。
// 锁法:引擎一 spawn(codex app-server 投递)就 markEngineSpawned();reap 启动时若发现本轮已 spawn 过 → **自禁**(一个都不回收,
// abortedLateReap=true)。失败方向 = 漏杀,符合本模块「宁可漏杀不可错杀」既定安全偏置,绝不因重构反向变成误杀。
let engineSpawnedThisSession = false
/** 每次引擎 spawn 后由 codex app-server 投递调用,置「本轮已 spawn 过引擎」——供 reap 自禁判定。 */
export function markEngineSpawned(): void {
  engineSpawnedThisSession = true
}

/** 回收注入依赖(可测)。 */
export interface ReapDeps {
  currentMainPid: number
  listPidfiles: () => Promise<string[]>
  readPidfile: (name: string) => Promise<string>
  deletePidfile: (name: string) => Promise<void>
  /** false 必须证明 PID 不存在；权限/探测错误和 PID 重用均按存活保留。 */
  isPidAlive: (pid: number) => boolean
  /** POSIX detached ownership stays alive while any member remains, even if the group leader exited. */
  isProcessGroupAlive?: (pgid: number) => boolean
  /** 读存活进程 cmdline(Linux /proc、macOS ps);读不到 → null。 */
  readCmdline: (pid: number) => Promise<string | null>
  /** Read all live members of an exact POSIX PGID; used by Codex wrapper + Rust descendant ownership. */
  readProcessGroupCmdline?: (pgid: number) => Promise<string | null>
  killGroup: (pgid: number) => void
  /** A pidfile remains owned until this proves the signalled group/tree terminal. */
  waitForGroupTerminal: (pgid: number) => Promise<boolean>
  /** @@@2146② 本轮是否已 spawn 过引擎——true 则 reap 自禁(reap 迟于 spawn,PID 重用会误杀活引擎)。 */
  engineAlreadySpawned: () => boolean
  log?: (msg: string) => void
}

export interface ReapSummary {
  scanned: number
  reaped: number
  cleaned: number
  skippedOwn: number
  /** Another owner is alive or cannot be proved absent; preserve its process and ledger. */
  skippedLiveOwner: number
  /** Exact-owned groups that were signalled but could not be proved terminal; their pidfiles remain. */
  retained: number
  /** @@@2146② reap 因迟于本轮引擎 spawn 而自禁:一个都没扫/没杀(漏杀方向,防 PID 重用误杀活引擎)。 */
  abortedLateReap?: boolean
}

// 逐 pidfile:坏文件删;属当前 main 的跳过(我们自己的活引擎);组长已死删(残留记录);cmdline 读不到跳过(下轮再试);
// 身份对上 → 杀整组 + 删。对不上 → PID 被无关进程重用,只清记录(cleaned)。
export async function reapResidualEngineGroupsOnce(deps: ReapDeps): Promise<ReapSummary> {
  const summary: ReapSummary = { scanned: 0, reaped: 0, cleaned: 0, skippedOwn: 0, skippedLiveOwner: 0, retained: 0 }
  const preserveLiveOwner = (record: EnginePidRecord): boolean => {
    if (record.ownerMainPid > 0 && !deps.isPidAlive(record.ownerMainPid)) return false
    summary.skippedLiveOwner++
    deps.log?.(`[engine-reap] preserving engine pgid=${record.pgid}: owner pid=${record.ownerMainPid} is alive or unverified`)
    return true
  }
  // @@@2146② 不变量守卫:reap 必须先于本轮任何引擎 spawn。两道:
  //  ① 入口:spawn 完全早于 reap(顺序被重构打乱)→ 自禁,scanned=0。
  //  ② 扫描期:reap 是逐 pidfile 多次 await 的长扫描(readPidfile/readCmdline 走 /proc 或 ps),期间若本轮 spawn 了
  //     引擎(用户操作 / device-runtime 唤醒自动投递),继续扫可能撞 PID 重用、把刚 spawn 的活引擎当残留误杀 →
  //     **每轮开头 + 每次 kill 前复检 latch**,一翻真即中止余下扫描(漏杀 > 误杀)。「顺序颠倒即失败」守护测试锚此。
  if (deps.engineAlreadySpawned()) {
    deps.log?.('[engine-reap] 跳过回收:本轮已 spawn 过引擎(reap 迟于 spawn)→ 避免 PID 重用误杀活引擎,宁可漏杀')
    return { ...summary, abortedLateReap: true }
  }
  let names: string[]
  try {
    names = await deps.listPidfiles()
  } catch {
    return summary // 目录不存在/读不了 → 无残留可收
  }
  let abortedLateReap = false
  for (const name of names) {
    if (deps.engineAlreadySpawned()) { abortedLateReap = true; break } // @@@2146② 扫描期本轮已 spawn → 中止,绝不再 kill
    summary.scanned++
    let rec: EnginePidRecord | null = null
    try {
      rec = parseEnginePidfile(await deps.readPidfile(name))
    } catch {
      rec = null
    }
    if (!rec) {
      await deps.deletePidfile(name).catch(() => {})
      summary.cleaned++
      continue
    }
    if (rec.ownerMainPid === deps.currentMainPid) {
      summary.skippedOwn++ // 本轮 main spawn 的活引擎 → 保留 pidfile,绝不回收
      continue
    }
    if (preserveLiveOwner(rec)) continue
    const processGroupOwned = rec.engineId === 'codex-app-server'
    const alive = processGroupOwned
      ? (deps.isProcessGroupAlive?.(rec.pgid) ?? deps.isPidAlive(rec.pgid))
      : deps.isPidAlive(rec.pgid)
    if (!alive) {
      await deps.deletePidfile(name).catch(() => {}) // 组长已亡 → 残留记录,清掉
      summary.cleaned++
      continue
    }
    const liveCmdline = await (
      processGroupOwned && deps.readProcessGroupCmdline
        ? deps.readProcessGroupCmdline(rec.pgid)
        : deps.readCmdline(rec.pgid)
    ).catch(() => null)
    if (liveCmdline == null) continue // 存活但读不到 cmdline → 不确定,不杀不删,下轮再判
    // cmdline 读取跨 await；owner PID 可能已被复用。无法证明原 owner 已退出时仍保留台账。
    if (preserveLiveOwner(rec)) continue
    if (shouldReapEngineGroup({ liveCmdline, recordedArgs: rec.args, engineId: rec.engineId })) {
      if (deps.engineAlreadySpawned()) { abortedLateReap = true; break } // @@@2146② 杀前最后一道:上面 await 期间可能刚 spawn
      try {
        deps.killGroup(rec.pgid) // 确认是我们上一轮的孤儿引擎组 → SIGKILL 整组
        if (!await deps.waitForGroupTerminal(rec.pgid)) {
          deps.log?.(`[engine-reap] group pgid=${rec.pgid} remained live; retaining pidfile for retry`)
          summary.retained++
          continue
        }
        summary.reaped++
        deps.log?.(`[engine-reap] killed residual engine group pgid=${rec.pgid} engine=${rec.engineId} agent=${rec.agentUserId}`)
      } catch (err) {
        deps.log?.(`[engine-reap] kill pgid=${rec.pgid} failed: ${String(err)}`)
        summary.retained++
        continue
      }
      await deps.deletePidfile(name).catch(() => {})
    } else {
      await deps.deletePidfile(name).catch(() => {}) // pid 被无关进程重用 → 我们的引擎早没了,只清记录
      summary.cleaned++
    }
  }
  if (abortedLateReap) {
    deps.log?.('[engine-reap] 扫描中止:期间本轮已 spawn 引擎 → 余下残留留待下轮,避免 PID 重用误杀')
    return { ...summary, abortedLateReap: true }
  }
  return summary
}

/**
 * @@@3890⑦ 启动回收的读数 → 该记什么。**它永远不产生「拦住启动」这个选项**,所以这里只回日志、不抛。
 *
 * 之前 main 在 `retained > 0` 时直接 throw,而那条 `app.whenReady().then(async …)` 链没有终结 catch:
 * 全局 unhandledRejection 处理器只记一行、不退出 → 进程活着,但窗口、托盘、activate 处理器全都没建,
 * 单实例锁还攥在手里,用户再点图标只会 second-instance 去 focus 一个从没存在过的窗口(表现为「双击没反应」)。
 * 更要命的是它**不自愈**:下一次启动那个杀不掉的组还在,照样 retained>0、照样 throw,永远起不来。
 *
 * retained 的语义本来就是「pidfile 保留,下轮再收」——它已经是重试机制了,不需要也不该顺带把 app 弄死。
 * 回收是尽力而为的清扫:清扫失败的正确表现是响亮记账 + 继续启动。
 */
export function describeReapSummary(summary: ReapSummary): { info: string | null; warning: string | null } {
  return {
    info: (summary.reaped || summary.cleaned || summary.skippedLiveOwner)
      ? `[engine-reap] scanned=${summary.scanned} reaped=${summary.reaped} cleaned=${summary.cleaned} skippedOwn=${summary.skippedOwn} skippedLiveOwner=${summary.skippedLiveOwner}`
      : null,
    warning: summary.retained > 0
      ? `[engine-reap] ${summary.retained} 个残留引擎组未能证明终结;pidfile 已保留待下轮回收 —— 启动继续,清扫失败绝不阻断启动`
      : null,
  }
}

// ───────────────────────── 真实 IO(供 codex app-server 投递写/删、main 启动回收接线) ─────────────────────────

/** 引擎 spawn 后落 pidfile(atomicWriteText:tmp+rename+chmod 0600 私有语义)。best-effort,失败不该阻断引擎启动。 */
export async function writeEnginePidfile(record: EnginePidRecord): Promise<void> {
  const file = path.join(enginePidDir(), enginePidfileName(record.agentUserId, record.conversationId, record.threadRootId))
  await atomicWriteText(file, JSON.stringify(record))
}

/**
 * 删自己 pidfile 前的归属校验(#2146①):磁盘上的记录是否仍是「我这个组长 pgid」。
 * 文件名 = 三元组(agent,conversation,thread)哈希 → 引擎重启/换实例时,同三元组的**新实例会覆盖写同名 pidfile**。
 * 老实例的 exit handler 若无条件删,就删掉了新实例的 pidfile:新实例一旦被 SIGKILL/断电孤儿化,下次启动扫不到它 →
 * 进程组永久泄漏。故删前先核 pgid 一致(仍是我这轮 spawn 的组)才删。
 */
export function pidfileBelongsToPgid(rec: EnginePidRecord | null, expectedPgid: number): boolean {
  return rec != null && rec.pgid === expectedPgid
}

/**
 * 优雅停止/子进程确认退出时删 pidfile(下次启动就不会把已停的引擎当孤儿回收)。ENOENT 无害。
 * @param expectedPgid 传入 = **归属校验后**才删(#2146①):仅当磁盘记录的 pgid == 此值(还是我这轮 spawn 的组)才删,
 *   否则(已被同三元组新实例覆盖写)保留 → 不误删新实例的 pidfile。不传 = 无条件删(无 pid 可校验时的兼容路径)。
 */
export async function deleteEnginePidfile(
  agentUserId: string,
  conversationId: string,
  threadRootId: string | null | undefined,
  expectedPgid?: number,
): Promise<void> {
  const file = path.join(enginePidDir(), enginePidfileName(agentUserId, conversationId, threadRootId))
  if (expectedPgid !== undefined) {
    let rec: EnginePidRecord | null = null
    try {
      rec = parseEnginePidfile(await readFile(file, 'utf8'))
    } catch {
      return // 读不到/不存在 → 无我方 pidfile 可删(已被新实例覆盖后清、或从未写成)
    }
    if (!pidfileBelongsToPgid(rec, expectedPgid)) return // 已被同三元组新实例覆盖 → 那是它的 pidfile,绝不删
  }
  await unlink(file).catch(() => {})
}

/** 只有 ESRCH 证明不存在；权限错误或其它探测错误均保留。 */
function isPidAliveReal(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code !== 'ESRCH'
  }
}

function isProcessGroupAliveReal(pgid: number): boolean {
  if (process.platform === 'win32') return isPidAliveReal(pgid)
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code !== 'ESRCH'
  }
}

async function waitForGroupTerminalReal(
  pgid: number,
  platform: NodeJS.Platform,
  timeoutMs = 1_000,
): Promise<boolean> {
  const isAlive = platform === 'win32' ? isPidAliveReal : isProcessGroupAliveReal
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (!isAlive(pgid)) return true
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  return false
}

async function readProcessGroupCmdlineReal(pgid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-ww', '-axo', 'pgid=,command='])
    const commands = stdout.split('\n').flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(.*)$/)
      return match && Number(match[1]) === pgid ? [match[2]] : []
    })
    return commands.length ? commands.join('\n') : null
  } catch {
    return null
  }
}

/** 读存活进程 cmdline:Linux /proc、macOS ps、Windows Win32_Process；读不到 → null。 */
async function readCmdlineReal(pid: number, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  try {
    if (platform === 'linux') {
      const raw = await readFile(`/proc/${pid}/cmdline`, 'utf8')
      return raw.replace(/\0/g, ' ').trim() || null
    }
    if (platform === 'darwin') {
      // -ww:不按终端宽度截断 command(否则长 cmdline 被截 → 匹配不到适配器路径 → 漏杀)。
      const { stdout } = await execFileAsync('ps', ['-ww', '-p', String(pid), '-o', 'command='])
      return stdout.trim() || null
    }
    if (platform === 'win32') {
      const powershell = process.env.SystemRoot
        ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : 'powershell.exe'
      const script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if($null -ne $p.CommandLine){[Console]::Out.Write($p.CommandLine)}`
      const { stdout } = await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script])
      return stdout.trim() || null
    }
    return null
  } catch {
    return null
  }
}

function killWindowsProcessTreeReal(pid: number): void {
  const taskkill = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'taskkill.exe')
    : 'taskkill.exe'
  execFileSync(taskkill, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
}

export interface CreateReapDepsOptions {
  platform?: NodeJS.Platform
  readWindowsCmdline?: (pid: number) => Promise<string | null>
  killWindowsTree?: (pid: number) => void
}

/** main 启动回收用的真实依赖。Windows 用 taskkill 杀树，不按 gugu.exe 进程名宽泛匹配。 */
export function createReapDeps(options: CreateReapDepsOptions = {}): ReapDeps {
  const dir = enginePidDir()
  const platform = options.platform ?? process.platform
  return {
    currentMainPid: process.pid,
    listPidfiles: async () => {
      try {
        return (await readdir(dir)).filter((n) => n.endsWith('.json'))
      } catch {
        return []
      }
    },
    readPidfile: (name) => readFile(path.join(dir, name), 'utf8'),
    deletePidfile: (name) => unlink(path.join(dir, name)).catch(() => {}),
    isPidAlive: isPidAliveReal,
    isProcessGroupAlive: platform === 'win32' ? isPidAliveReal : isProcessGroupAliveReal,
    readCmdline: platform === 'win32' && options.readWindowsCmdline
      ? options.readWindowsCmdline
      : (pid) => readCmdlineReal(pid, platform),
    readProcessGroupCmdline: platform === 'win32'
      ? (pid) => readCmdlineReal(pid, platform)
      : readProcessGroupCmdlineReal,
    waitForGroupTerminal: (pgid) => waitForGroupTerminalReal(pgid, platform),
    engineAlreadySpawned: () => engineSpawnedThisSession, // @@@2146② reap 迟于本轮 spawn → 自禁

    killGroup: platform === 'win32'
      ? (pid) => (options.killWindowsTree ?? killWindowsProcessTreeReal)(pid)
      : (pgid) => {
          try {
            process.kill(-pgid, 'SIGKILL') // 负 pid = 整组(含孙进程)
          } catch {
            /* 组已不存在 —— 下面 waitForGroupTerminal 判终局 */
          }
        },
    log: (msg) => console.error(msg),
  }
}
