/**
 * 开机清掉「上一条命留下的版本探测孤儿」(#5384)。
 *
 * ## 机理（2026-09-10 在 mac1 上量实的，不是推断）
 *
 * 依赖体检对每个 harness 跑一次 `<bin> --version`（`runVersionProbe` → `execInProcessGroup`）。
 * 那条 spawn 是 **detached** 的 —— 必须如此：真 harness 二进制常常是适配器的孙进程，不开进程组
 * 就只杀得掉直接子进程。相应地，收尾放在 `finally` 里，连整个进程组一起 SIGKILL。
 *
 * 这套在父进程活着时是完整的。**父进程被强杀时不是**：detached 的子进程活下来，而它三条 stdio
 * 管道的读端随父进程一起消失。不处理 SIGPIPE 的程序会在写失败上空转 —— 实测 mac1 上两个
 * `amp --version` 各占满一个核，ppid 都变成 1；清干净后两个半小时又长出两个，同样各占一核。
 * 对照实验排除了「它自己就挂死」：手动跑 `amp --version` 12 秒内自己退出（还打了一行错）。
 *
 * 也就是说，缺的从来不是超时，而是**崩溃之后的那一半**。`finally` 只在我们还活着时有效。
 *
 * ## 判据（刻意保守，宁可漏杀不可错杀）
 *
 * 四条同时成立才动手：
 *
 * 1. `ppid === 1` —— 它的 spawner 已经不在了。活着的探测永远挂在我们下面。
 * 2. argv 恰好两个词，第二个是 `--version` —— 这是探测的**完整**命令行，不是某个恰好带
 *    `--version` 的长命令。
 * 3. argv[0] 的 basename 在**本次启动实际登记的探测命令**集合里 —— ❌ 不按关键词猜，
 *    不认不在册的二进制。
 * 4. 已经活了 ≥ 60 秒 —— 健康的 `--version` 是秒级的；跑满一分钟的必然是卡住的那种。
 *
 * ❌ 不要放宽到「所有 ppid=1 的用户进程」或「命令行里含 --version」：那会开始碰用户自己的东西。
 * ❌ 也不要靠环境变量打标记再扫：新版 macOS 上 `ps -E` 读不到别的进程的环境（实测为空）。
 */

const VERSION_FLAG = '--version'

/** 健康的 `--version` 是秒级的。给到 60 秒，跨过任何合理的冷启动。 */
export const PROBE_ORPHAN_MIN_AGE_SECONDS = 60

export interface ProcessSnapshotRow {
  pid: number
  ppid: number
  elapsedSeconds: number
  argv: string[]
}

/** `ps` 的 etime：`MM:SS` / `HH:MM:SS` / `D-HH:MM:SS`。解析不了返回 undefined（=不敢动它）。 */
export function parseElapsedSeconds(etime: string): number | undefined {
  const trimmed = etime.trim()
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(trimmed)
  if (!match) return undefined
  const [, days, hours, minutes, seconds] = match
  return (
    Number(days ?? 0) * 86400 +
    Number(hours ?? 0) * 3600 +
    Number(minutes) * 60 +
    Number(seconds)
  )
}

/**
 * 解析 `ps -axo pid=,ppid=,etime=,command=` 的输出。
 * 命令行按空白切分 —— 带空格的路径会被切碎，那种行因此过不了「恰好两个词」这一关，
 * 正好落在保守的一侧。
 */
export function parseProcessSnapshot(text: string): ProcessSnapshotRow[] {
  const rows: ProcessSnapshotRow[] = []
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 4) continue
    const pid = Number(parts[0])
    const ppid = Number(parts[1])
    const elapsedSeconds = parseElapsedSeconds(parts[2] ?? '')
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || elapsedSeconds === undefined) continue
    rows.push({ pid, ppid, elapsedSeconds, argv: parts.slice(3) })
  }
  return rows
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? path : path.slice(slash + 1)
}

/**
 * 从快照里挑出该收的孤儿。纯函数 —— 判据能被单测逐条钉住，不用真起进程。
 */
export function selectProbeOrphans(
  rows: readonly ProcessSnapshotRow[],
  probedCommands: readonly string[],
  minAgeSeconds: number = PROBE_ORPHAN_MIN_AGE_SECONDS,
): ProcessSnapshotRow[] {
  const known = new Set(probedCommands.map(basename).filter((name) => name.length > 0))
  if (known.size === 0) return []
  return rows.filter(
    (row) =>
      row.ppid === 1 &&
      row.elapsedSeconds >= minAgeSeconds &&
      row.argv.length === 2 &&
      row.argv[1] === VERSION_FLAG &&
      known.has(basename(row.argv[0] ?? '')),
  )
}

/** 注入点：让测试不用真起进程、也不用真杀东西。 */
export interface ProbeOrphanSweepDeps {
  snapshot(): Promise<string>
  kill(pid: number): void
  onSwept(rows: readonly ProcessSnapshotRow[]): void
}

/**
 * 跑一次清扫。返回收掉的条数。
 * 任何一步出错都只记不抛 —— 开机清扫失败不该拦住应用启动。
 */
export async function sweepProbeOrphans(
  probedCommands: readonly string[],
  deps: ProbeOrphanSweepDeps,
  minAgeSeconds: number = PROBE_ORPHAN_MIN_AGE_SECONDS,
): Promise<number> {
  const text = await deps.snapshot()
  const orphans = selectProbeOrphans(parseProcessSnapshot(text), probedCommands, minAgeSeconds)
  for (const row of orphans) {
    // 探测是 detached 起的 ⇒ 它自己就是组长，`-pid` 即整个组；组里可能还挂着它自己的孙进程。
    try {
      deps.kill(-row.pid)
    } catch {
      // 组已经没了或平台不认负 pid，退回只杀它本身。
      try {
        deps.kill(row.pid)
      } catch {
        // 它自己已经退了。
      }
    }
  }
  if (orphans.length > 0) deps.onSwept(orphans)
  return orphans.length
}

/**
 * 生产用的注入实现。
 * ❌ 只在 POSIX 上做事：判据里的 `ppid === 1`（被 init 收养）在 Windows 上没有对应语义。
 */
export function createProbeOrphanSweepDeps(
  logSwept: (rows: readonly ProcessSnapshotRow[]) => void,
): ProbeOrphanSweepDeps | undefined {
  if (process.platform === 'win32') return undefined
  return {
    async snapshot() {
      const { execFile } = await import('@gugu/core/local/childProcess')
      const { promisify } = await import('node:util')
      const run = promisify(execFile)
      // `-x` 才看得到没有控制终端的进程 —— 孤儿正是这种。
      const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,etime=,command='], {
        maxBuffer: 8 * 1024 * 1024,
      })
      return stdout
    },
    kill(pid) {
      process.kill(pid, 'SIGKILL')
    },
    onSwept: logSwept,
  }
}
