import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// @@@run-tmp-root (#6272) — 每次 vitest 运行一个专属临时根,teardown 整个删掉。
// 用例 mkdtemp 后不删是常态(mac1 的用户 TMPDIR 因此堆到 82.8 万条 / 55GB,列一次目录 171s),
// 逐个补 cleanup 永远补不完;在这里把 TMPDIR/TMP/TEMP 指向运行专属目录,os.tmpdir()、
// mkdtemp 与测试 spawn 的子进程就都落进来,运行结束一次删净。
// 生效的前提:worker 的 env 是 pool 起跑时拷的 process.env(vitest 4 的 pool.ts),晚于 globalSetup。
//
// 路径要**短**:产品码在 tmpdir 下建 unix socket(gugu-cx/cx-<16hex>.sock、gugu-rv-<20>.sock,
// 连同分隔符 ≤34 字节),macOS 的 sun_path 上限 104。根 = <原 tmpdir>/gv/<pid36>,只比原值多 ≤8 字节
// (macOS 默认 ~49 → ~57;CI 槽 /tmp/gugu-ci/<slot> 23 → ~31)。
//
// 带 pid 的名字让「被 kill 的运行留下的根」可以回收:起跑时删掉 gv/ 下 pid 已不在的条目。
// 只读 gv/ 这一层,不遍历原 tmpdir 本身(那里可能堆着几十万条)。
const PARENT = 'gv'
const ROOT_ENV = 'GUGU_VITEST_TMP_ROOT'
// posix 的 os.tmpdir() 读 TMPDIR,win32 读 TEMP/TMP;三个一起指,子进程不论哪种读法都进同一个根。
const ENV_KEYS = [ROOT_ENV, 'TMPDIR', 'TMP', 'TEMP'] as const

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = 活着但属于别的用户。
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function sweepDeadRuns(parent: string): void {
  let names: string[]
  try {
    names = readdirSync(parent)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const name of names) {
    const pid = Number.parseInt(name, 36)
    if (!Number.isInteger(pid) || pid.toString(36) !== name) continue
    if (pid === process.pid || !pidAlive(pid)) rmSync(path.join(parent, name), { recursive: true, force: true })
  }
}

export default function vitestRunTmpRoot(): (() => void) | undefined {
  // globalSetup 按 project 各跑一次(同一进程)⇒ 第二次起沿用第一次的根,只由第一次负责删。
  // 嵌套的 vitest(用例 spawn 的)pid 不同,会在外层根里再开自己的一层。
  const root = process.env[ROOT_ENV]
  if (root && path.basename(root) === process.pid.toString(36)) return undefined

  const parent = path.join(tmpdir(), PARENT)
  sweepDeadRuns(parent)
  const own = path.join(parent, process.pid.toString(36))
  mkdirSync(own, { recursive: true })
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) process.env[key] = own

  return () => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    rmSync(own, { recursive: true, force: true, maxRetries: 5 })
  }
}
