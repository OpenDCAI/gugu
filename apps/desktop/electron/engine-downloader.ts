// 两样随包工具,给 claude 桥接(acp-bridge/claude-bridge-deps.ts)在后台装用户那份 Claude 配对的桥接用:
//   · execWithStallWatch:跑一个子进程,盯工作目录的字节进展,连续零进展就杀掉并报错(#2004 §3);
//   · resolveBundledNpmInvocation:用 Electron 内嵌的 node 跑随 App 交付的 npm。
// 文件名是历史:这里原来还有 #1478 那套「agent 运行时按需下载到共享缓存」,它从 acp-bridge-impl 退役起就没有生产调用方,
// 连同下载进度浮层一起删了(要用时从 git 取回)。
import { execFile, type ChildProcess, type ExecFileOptionsWithStringEncoding } from 'node:child_process'
import { statSync, type Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

// #2004 §3 (product spec) —— 运行时下载 stall 检测。
// 起因：npm 下载原用 execFileSync('npm', ...) 同步跑，npm 卡半开连接（网络中途断但
// TCP 连接未 RST）时会永久阻塞，"下载失败"这个事件永不发生 → 前端乐观种下的 starting 状态永久滞留。
// 判据 = 连续 60s 零字节**增长**（无总时长上限，慢网下载大文件合法，只要字节在涨就继续等；
// 下降/波动不续命——npm 自身 bookkeeping 的字节波动不能把真卡死的 stall 时钟无限续期）。
// 进展信号 = 该次调用的整个临时工作目录总字节：涵盖 npm/pacote 流式落盘的 `<cache>/_cacache/tmp/*`
// （实测验证：67MB tarball 下载期间逐轮增长）+ 下载后的本地阶段（pack 的 tarball 落盘/解压、
// install 的 node_modules extract/link）——只盯 cache tmp 会把健康但慢的本地收尾误判成网络 stall。
// 每次下载用**隔离**的 --cache 目录（而非用户全局 npm 缓存），否则并发 agent 的下载会共享同一
// tmp 目录、互相掩盖各自的「零进展」。代价（有意取舍）：stall 重试无 warm-start，每次全量冷下载。

/** #2004 §3：连续零字节进展超过此值 → 判定卡死。无总时长上限，只要字节在动就继续等。 */
export const DOWNLOAD_STALL_TIMEOUT_MS = 60_000
const PROGRESS_POLL_INTERVAL_MS = 1_000
/** SIGTERM 后仍未退出（真卡死的进程可能吞信号，如阻塞在系统调用里）→ 兜底 SIGKILL，避免子进程泄漏。 */
export const STALL_KILL_ESCALATE_MS = 5_000

// 非 ENOENT 的目录读取失败（EACCES 等真配置错）warn 一次留痕——否则被静默成 0 字节、60s 后误报成
// 网络 stall，把权限/文件系统 bug 引向错误的排查方向。ENOENT 属预期（目录尚未创建/已被挪走）不警。
const warnedWalkErrors = new Set<string>()
function warnNonEnoentOnce(dir: string, err: unknown): void {
  const code = (err as { code?: string } | null)?.code
  if (code === 'ENOENT') return
  const key = `${dir}:${code}`
  if (warnedWalkErrors.has(key)) return
  warnedWalkErrors.add(key)
  console.warn(`[engine-downloader] 进展目录不可读（${code}），按 0 字节计：${dir}`)
}

/** 递归求目录总字节。异步——poll 每秒跑在 Electron 主进程，同步 IO 会周期性冻整个 UI（慢盘/AV 扫描下
 * 一次递归可达数百 ms）。扫描期间文件被 npm 挪走（cacache 完成后搬迁到 content-v2）属预期，缺失按 0 计。
 * 导出 = stall watch 的默认进展读数实现（见 StallWatchDeps）。 */
export async function dirTotalBytes(dir: string): Promise<number> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    warnNonEnoentOnce(dir, err)
    return 0
  }
  let total = 0
  for (const entry of entries) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await dirTotalBytes(p)
    } else {
      try {
        total += (await stat(p)).size
      } catch {
        // 文件在 readdir 和 stat 之间被搬走 —— 按 0 计，下一轮轮询自然反映最新状态。
      }
    }
  }
  return total
}

// #2449 —— stall 判定的外界输入只有三样：现在几点、这一轮多少字节、子进程退了没。前两样在下面做成
// 注入缝，时钟由调用方的 timer 提供（单测用 fake timers 即可完全接管）。
// 原设计要求单测直接驱动真子进程 + 真文件系统，把 behavior 的 60s 压成几百毫秒当阈值：全量单测下几百个
// 文件抢 CPU 时，子进程从 spawn 到写出第一个字节可以慢过阈值本身 —— 真进展被判成卡死、被杀死的取证
// 文件还没来得及创建就被读。那样的断言测的是这台机器有多快，不是状态机对不对。

/** stall 状态机眼里的子进程：只需要「退了没」和「杀掉整棵树」，平台差异不外泄。 */
export interface StallWatchProcess {
  /** 真实现下 = OS pid（供调用方取证进程确已消失）。 */
  readonly pid: number | undefined
  /** 已终止（exitCode / signalCode 任一非 null）→ 不该再判它卡死。 */
  hasExited(): boolean
  /** 杀掉整棵进程树。 */
  killTree(signal: NodeJS.Signals): void
}

export type StallWatchSpawn = (
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  /** 子进程真正退出时回调（execFile 语义：非零退出/spawn 失败给 err，成功给 stdout）。 */
  onExit: (err: Error | null, stdout: string) => void
) => StallWatchProcess

/** 注入缝：默认 = 真子进程 + 真目录扫描；单测注入假件，让断言只落在状态机上。 */
export interface StallWatchDeps {
  spawn: StallWatchSpawn
  readProgressBytes(dir: string): Promise<number>
}

/**
 * 默认进程边界。detached（POSIX）→ npm 自成进程组，stall 时 kill(-pid) 连 postinstall 等孙进程一起杀，
 * 不留孤儿；Windows 无进程组语义 → taskkill /T 杀进程树。
 */
export const spawnKillableTree: StallWatchSpawn = (cmd, args, env, onExit) => {
  const isWin = process.platform === 'win32'
  const child: ChildProcess = execFile(
    cmd,
    args,
    // detached 在类型 ExecFileOptions 里缺席但运行时直通 spawn 生效（POSIX 起新进程组供 kill(-pid) 杀树）。
    { encoding: 'utf8', env, detached: !isWin } as ExecFileOptionsWithStringEncoding & { detached: boolean },
    (err, stdout) => onExit(err, stdout as string)
  )
  return {
    get pid(): number | undefined {
      return child.pid
    },
    hasExited: () => child.exitCode !== null || child.signalCode !== null,
    killTree(signal) {
      if (child.pid === undefined) return
      if (isWin) {
        try {
          execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'])
        } catch {
          child.kill(signal)
        }
      } else {
        try {
          process.kill(-child.pid, signal)
        } catch {
          child.kill(signal) // 进程组已不存在（刚退出）→ 退回单进程 kill，无害。
        }
      }
    },
  }
}

export interface StallWatchOptions {
  /** 连续零字节变化超过此值 → 判定卡死（默认 DOWNLOAD_STALL_TIMEOUT_MS）。 */
  stallTimeoutMs?: number
  /** 轮询间隔（默认 PROGRESS_POLL_INTERVAL_MS）。 */
  pollIntervalMs?: number
  /** #2449 注入缝（默认真子进程 + 真目录扫描）。 */
  deps?: StallWatchDeps
  // #2136 - 字节增长外显：每次轮询到「增长」时回调本轮的**正增长 delta**（不是目录当前大小——
  // npm/tar 清理临时文件会让目录收缩,直接外显当前值 UI 数字会倒退,#2150 review 019 实测命中）。
  // 调用方自行累计 → 显示值单调不减,且收缩后的新增长照样产生正 delta 推动数字——与 watchdog
  // 「有正增长即续命」严格同源(数字冻结 ⟺ watchdog 计时中)。
  onBytes?: (deltaBytes: number) => void
}

/**
 * #2004 §3 —— 跑 `cmd args` 子进程，同时轮询 progressDir 总字节当「进展」信号：连续 stallTimeoutMs
 * 零变化 → 判定卡死，kill 子进程并 reject；子进程自然退出（成功/失败）按其 exit 结算，stdout 原样返回
 * （复刻 execFileSync 的调用惯例）。无总时长上限——只要字节还在动就继续等。
 * 进程边界与进展读数走 watchOptions.deps 注入（#2449）：单测拿假件逐拍驱动这台状态机，不靠真子进程
 * 抢到 CPU 的快慢来碰阈值。
 */
export function execWithStallWatch(
  cmd: string,
  args: string[],
  execOptions: { env: NodeJS.ProcessEnv },
  progressDir: string,
  watchOptions: StallWatchOptions = {}
): Promise<string> {
  const stallTimeoutMs = watchOptions.stallTimeoutMs ?? DOWNLOAD_STALL_TIMEOUT_MS
  const pollIntervalMs = watchOptions.pollIntervalMs ?? PROGRESS_POLL_INTERVAL_MS
  const spawn = watchOptions.deps?.spawn ?? spawnKillableTree
  const readProgressBytes = watchOptions.deps?.readProgressBytes ?? dirTotalBytes
  return new Promise((resolve, reject) => {
    let settled = false
    let stallMsg: string | null = null // 已判卡死，等子进程真正退出后以此结算（见 onExit）。
    let walking = false // 读数防重入：慢盘上一轮 walk 未归就跳过本轮，不叠加 IO。
    let lastResortTimer: NodeJS.Timeout | undefined
    const child = spawn(cmd, args, execOptions.env, (err, stdout) => {
      clearInterval(pollTimer)
      if (lastResortTimer) clearTimeout(lastResortTimer)
      if (settled) return
      settled = true
      // 结算永远发生在子进程真正退出之后（onExit 即退出信号）→ 调用方 finally 的清理
      // 不会撞上仍持句柄的进程，stall 诊断也不会被 EBUSY 类文件系统错顶掉。
      if (stallMsg) reject(new Error(stallMsg))
      else if (err) reject(err)
      else resolve(stdout)
    })
    let lastBytes = -1
    let lastGrowthAt = Date.now()
    const pollTimer = setInterval(() => {
      if (settled || stallMsg || walking) return
      walking = true
      void readProgressBytes(progressDir).then((bytes) => {
        walking = false
        if (settled || stallMsg) return
        const now = Date.now()
        if (bytes > lastBytes) {
          // 仅**增长**算进展。下降（npm 清理坏 partial / cacache 搬迁走文件）只更新基线不续命——
          // 否则半开连接期间 npm 自身 bookkeeping 的字节波动能把 stall 时钟无限续期（假阴性）。
          // #2136 - 增长即外显**正增长 delta**（1s 轮询天然限频）。回调抛错不得影响 stall 判定/下载本体。
          // lastBytes 初值 -1（哨兵）：首轮按「从 0 起的增长」计（不多算哨兵那 1 字节）；空目录首轮
          // （0 > -1 走增长分支但 delta=0）不回调——契约是只报正增长。
          const delta = bytes - Math.max(0, lastBytes)
          lastBytes = bytes
          lastGrowthAt = now
          if (delta > 0) {
            try {
              watchOptions.onBytes?.(delta)
            } catch (e) {
              console.warn('[engine-downloader] onBytes 回调抛错（已忽略）：', e)
            }
          }
          return
        }
        if (bytes < lastBytes) lastBytes = bytes
        if (now - lastGrowthAt < stallTimeoutMs) return
        // 子进程已自然退出（成功/失败）→ 让 onExit 结算，不把恰好静默收尾的成功误报成卡死。
        if (child.hasExited()) return
        stallMsg = `[engine-downloader] 下载卡死：连续 ${Math.round(stallTimeoutMs / 1000)}s 零字节进展（${cmd} ${args.join(' ')}）`
        clearInterval(pollTimer)
        child.killTree('SIGTERM')
        // SIGTERM 后仍未退出（真卡死的进程可能吞信号）→ 兜底 SIGKILL；SIGKILL 都压不死（不可中断
        // IO）→ 最后强制结算：状态必须收敛（fail-loud 优先），进程残留在错误信息里言明。
        setTimeout(() => {
          if (!settled) child.killTree('SIGKILL')
        }, STALL_KILL_ESCALATE_MS).unref()
        lastResortTimer = setTimeout(() => {
          if (settled) return
          settled = true
          reject(new Error(`${stallMsg}；SIGKILL 后进程仍未退出，可能残留`))
        }, STALL_KILL_ESCALATE_MS * 2)
        lastResortTimer.unref()
      })
    }, pollIntervalMs)
  })
}

/** 非空文件校验（防截断/0 字节）。 */
function isNonEmptyFile(p: string): boolean {
  try {
    return statSync(p).size > 0
  } catch {
    return false
  }
}

export interface BundledNpmInvocation {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

/**
 * Run the production npm dependency through Electron's embedded Node. Windows npm installs expose a
 * `npm.cmd` shim that `execFile` cannot execute, and ordinary app users may not have Node/npm at all.
 */
export function resolveBundledNpmInvocation(
  env: NodeJS.ProcessEnv = process.env,
  appRoot: string = join(__dirname, '../../..'),
  execPath: string = process.execPath
): BundledNpmInvocation {
  const npmCli = join(appRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!isNonEmptyFile(npmCli)) {
    throw new Error(`[engine-downloader] 随 App 交付的 npm CLI 缺失/空：${npmCli}`)
  }
  return {
    command: execPath,
    args: [npmCli],
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
  }
}
