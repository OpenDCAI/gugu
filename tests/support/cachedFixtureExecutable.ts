import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 按内容寻址地复用「测试用的可执行文件」,而不是每跑一次现铸一个。
 *
 * ## 为什么
 *
 * 2026-08-17 在 mac1 实测锁定:**macOS 执行一个「刚创建的、未签名的可执行文件」要付
 * ~500ms 的系统安全检查(syspolicyd / Gatekeeper 路径),而这个检查是全机串行的**,
 * 并发时线性排队。计时只覆盖 `spawn`→`'close'`、不含建文件:
 *
 * | 并发路数 | A:每次新建 | B:建一次重复执行(对照) |
 * |---|---|---|
 * | 1  | 505 ms  | 2.5 ms |
 * | 24 | 8116 ms | 2.7 ms |
 *
 * A 严格线性 ≈ 338ms × 并发数;**B 在同样 24 路并发下纹丝不动** —— 这条对照把
 * 「CPU / 内存争抢」彻底排除:同样的并发,只是不新建文件,就没有任何减速。
 *
 * mac1 是 16 槽 × 每槽多个 vitest worker,各铸各的;并发到 ~90 路时 A 组外推 ≈ 30s,
 * 于是「等另一个进程起来」的各种预算(测试自己的 10s/15s/20s、产品 `assertCodexExecutable`
 * 的 10s)被一并撞穿,表现为一批 flaky。见 issue #4918。
 *
 * ## 怎么用
 *
 * 把脚本正文里**随用例变化的路径**改成从环境变量读,正文本身就稳定了 ——
 * 同一份正文在所有 worker、所有 run 之间共用同一个 inode:
 *
 * ```ts
 * const bin = cachedFixtureExecutable('codex-fixture.mjs', SCRIPT)   // SCRIPT 不含每次都变的路径
 * await session.start(root, { env: { ...process.env, GUGU_FIXTURE_LEDGER: ledgerPath } })
 * ```
 *
 * ❌ 别把 `mkdtemp` 出来的路径拼进正文 —— 那等于每次都是新内容、新文件,这个缓存就白设了。
 *
 * ## 效力边界(别当成它包治)
 *
 * - 冷机器上**第一批**并发 worker 会同时看到「文件不存在」而各铸一个,那一批照旧付钱。
 *   缓存赢的是它们之后的所有人,以及后续每一次 run。
 * - 「同一 inode 跨进程 / 跨 run 也免检」2026-09-10 在 mac1 实测成立(负载 33 时:同一文件
 *   首次 514ms,之后新进程再执行 76–111ms,与裸 `node -e 0` 的 67ms 同量级;rename 也不重置)。
 *   同一时刻**新建**文件的首次执行是 3.1s / 10.4s / 11.1s —— 正好撞穿产品预检的 10s 预算。
 * - 只解决「铸文件」这一项成本。真正卡在别处的用例(如 @parcel/watcher 事件延迟)不归它管。
 *
 * ## 这道检查到底认什么(2026-09-10 mac1 对照,每组 5 个全新文件,负载 28,中位数)
 *
 * | 做法 | 首次执行 |
 * |---|---|
 * | 全新文件直接执行 | 470 ms |
 * | 同一个文件第二次执行 | 40 ms |
 * | 清掉扩展属性(`xattr -c`)再执行 | 1148 ms |
 * | ad-hoc 签名(`codesign -s -`)后执行 | 471 ms |
 * | 先 spawn、100ms 内 SIGKILL,再正常执行 | 1366 ms |
 * | 把同一份内容交给已经暖的 node 解释执行 | 41 ms |
 *
 * 三条结论,本模块的全部设计都从它们来:
 *
 * 1. **只有「这个 inode 之前被完整执行过」算数。** 签名、清扩展属性都不管用;抢跑更不行 ——
 *    在 execve 中途把进程杀掉,这笔钱不算付过,下次还得重付(所以 ❌ 不要用 spawn-then-kill 预热)。
 * 2. **它认的是被 execve 的那个文件,不是内容。** 同一份内容当参数喂给已经暖的解释器是免费的。
 * 3. rename 不重置(同 inode)。所以先写暂存名再 rename 的做法既安全又不丢暖。
 *
 * ## 由此:代价的单位是「每种内容、每台机器一次」,前提是存放处跨 job 跨槽
 *
 * 默认放 `tmpdir()` 下,本地够用。CI 上 `GUGU_FIXTURE_BIN_DIR` 由 setup-ci-slot 指到
 * **全机共用**的 `~/.gugu-ci-shared/fixture-bin`:
 *
 * - ❌ 放 TMPDIR:那目录每个 job 开头整个 rm -rf,缓存只活一个 job,每个 job 都在全机串行队列里
 *   重铸一遍 —— codex* / opencode-attach* 那一族「`--version` 未在 10000ms 内完成」假红的来源。
 * - ❌ 放槽私有 cache:16 个槽 = 16 份冷缓存,每份都得在某个 job 里现铸一次。#5360 就是这么红的:
 *   槽 06 的 fixture 铸于 job 开始后 50 秒,当场撞穿产品预检的 10s 预算。
 *
 * ## 还有:铸完不许直接交出去
 *
 * 光靠共用还剩一个洞 —— 新加一种 fixture 时,总有某一个 job 是第一个铸它的,那笔钱就落在那条
 * 用例的预算里。所以本模块的契约是:**返回的路径,首次执行费已经付过**。铸完当场同步跑一次,
 * 把钱付在这里(调用方在测试体内,没有墙钟预算),而不是留给产品的 `--version` 预检(预算 10s)。
 * 付完在旁边落一个 `.paid` 标记,之后所有调用直接跳过。没有标记就自己付一次 —— ❌ 不要改成
 * 「等别人付完」:等不到的情况(标记体系上线前就在缓存里的文件、付钱的进程中途死掉)会把每个 job
 * 白白拖满一个预算,而付一次已经暖的 inode 只要几十毫秒,比等便宜得多,并发时也不过是排在同一次
 * 检查后面。只在 CI(`GUGU_FIXTURE_BIN_DIR` 已设)这么做,本地不改行为、不拖慢。
 */

/** 缓存根。内容寻址 ⇒ 条目数被仓里 fixture 的**种类数**界住,不随 run 次数增长。 */
const CACHE_ROOT = process.env.GUGU_FIXTURE_BIN_DIR || join(tmpdir(), 'gugu-fixture-bin')

/**
 * 只在 CI 付首次执行费。与 CACHE_ROOT 在**同一处、同一时刻**读同一个变量:两处分别读会出现
 * 「缓存指向 CI 的共用目录、却因为变量后来被改掉而不付钱」这种半吊子状态。
 */
const PAY_FIRST_EXEC_TOLL = Boolean(process.env.GUGU_FIXTURE_BIN_DIR)

/**
 * 让这个 inode 完整走一次 execve,把 macOS 那道全机串行的首次执行检查付掉。
 * ❌ 不能用 spawn-then-kill 抄近路:上表 F 组证明杀在 execve 中途不算付过。
 *
 * 等的是它**退出**,不设墙钟上限(#4357):那道检查排多久不由我们决定(2026-09-22 负载 40–65 时
 * 新 inode 首次执行实测到 108s),从前的 20s 上限会在它没付完时把进程杀掉 —— 按上表那等于没付。
 * 所以约定:缓存里的 fixture 收到 `--version`、stdin 为空时必须自己退出(现有每一份都满足)。
 * 真有一份挂住,用例会停在这里,由 CI job 的上限收场,在飞心跳会指着这条用例。
 */
function payFirstExecToll(path: string): void {
  // 跑在一次性 scratch 目录里:fixture 常往自己的 cwd 写台账,别让它写进缓存目录或仓库。
  const scratch = mkdtempSync(join(tmpdir(), 'gugu-fixture-toll-'))
  try {
    spawnSync(path, ['--version'], { cwd: scratch, stdio: 'ignore' })
  } catch {
    // 跑不起来也没关系:execve 已经发生,钱就付过了。这里只关心那一次 execve,不关心退出码。
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  // 标记是**逐文件**的,不是逐摘要目录:同一份内容以两个名字落盘(codex 与 codex.exe)是两个
  // inode,各自要付各自的钱。
  writeFileSync(`${path}.paid`, '', { mode: 0o644 })
}

/** 幂等:有标记就什么都不做,没有就付一次并落标记。 */
function ensureFirstExecTollPaid(path: string): void {
  if (existsSync(`${path}.paid`)) return
  payFirstExecToll(path)
}

export function cachedFixtureExecutable(name: string, contents: string): string {
  const digest = createHash('sha256').update(contents).digest('hex').slice(0, 16)
  const dir = join(CACHE_ROOT, digest)
  const path = join(dir, name)
  if (existsSync(path)) {
    if (PAY_FIRST_EXEC_TOLL) ensureFirstExecTollPaid(path)
    return path
  }

  mkdirSync(dir, { recursive: true })
  // 先写暂存名再 rename:两个 worker 同时铸时,谁都不会看到半截文件。
  // 内容寻址保证两份暂存文件逐字节相同,所以谁赢都对。
  const staging = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}`
  writeFileSync(staging, contents, { mode: 0o755 })
  chmodSync(staging, 0o755)
  if (existsSync(path)) {
    // 别人已经铸好了。❌ 不要 rename 覆盖 —— 那会换掉 inode,把正在复用它的人重新推回
    // 「新建文件」那条慢路径上,正好抵消本模块的全部意义。
    rmSync(staging, { force: true })
    if (PAY_FIRST_EXEC_TOLL) ensureFirstExecTollPaid(path)
    return path
  }
  renameSync(staging, path)
  // rename 不换 inode,所以在这里付和在暂存名上付是同一笔;放在 rename 之后,别人一看到
  // 这个路径存在就能直接用,不会拿到一个「在场但还没付过钱」的文件。
  if (PAY_FIRST_EXEC_TOLL) ensureFirstExecTollPaid(path)
  return path
}
