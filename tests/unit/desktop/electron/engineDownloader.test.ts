import { afterEach, describe, expect, test, vi } from 'vitest'
import { mkdirSync, existsSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  execWithStallWatch,
  dirTotalBytes,
  resolveBundledNpmInvocation,
  spawnKillableTree,
  DOWNLOAD_STALL_TIMEOUT_MS,
  STALL_KILL_ESCALATE_MS,
  type StallWatchDeps,
} from '../../../../apps/desktop/electron/engine-downloader'
const createdDirs: string[] = []
function freshDir(tag: string): string {
  const raw = join(tmpdir(), `gugu-dl-${tag}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(raw, { recursive: true })
  const dir = realpathSync(raw)
  createdDirs.push(dir)
  return dir
}
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const d of createdDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
describe('bundled npm invocation (#2459)', () => {
  test('uses the app-shipped npm CLI through the embedded Node runtime', () => {
    const invocation = resolveBundledNpmInvocation({ HTTPS_PROXY: 'http://proxy.invalid' })
    expect(invocation.command).toBe(process.execPath)
    expect(invocation.args).toHaveLength(1)
    expect(invocation.args[0]).toMatch(/node_modules[/\\]npm[/\\]bin[/\\]npm-cli\.js$/)
    expect(existsSync(invocation.args[0])).toBe(true)
    expect(invocation.env).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1',
      HTTPS_PROXY: 'http://proxy.invalid',
    })
  })
  test('fails loud when the packaged npm asset is absent', () => {
    expect(() => resolveBundledNpmInvocation({}, freshDir('missing-npm'), '/app/gugu.exe'))
      .toThrow(/随 App 交付的 npm CLI 缺失/)
  })
})
/**
 * stall 状态机的可控外界：第 n 次轮询读到多少字节由 bytesAt(n) 决定（与子进程写盘的快慢无关），
 * 子进程的退出/被杀由测试显式驱动。
 */
function fakeStallWorld(bytesAt: (poll: number) => number) {
  const kills: NodeJS.Signals[] = []
  let exited = false
  let polls = 0
  let onExit: ((err: Error | null, stdout: string) => void) | undefined
  const deps: StallWatchDeps = {
    spawn(_cmd, _args, _env, cb) {
      onExit = cb
      return {
        pid: 4242,
        hasExited: () => exited,
        killTree: (signal) => void kills.push(signal),
      }
    },
    readProgressBytes: async () => bytesAt(polls++),
  }
  return {
    deps,
    kills,
    /** 子进程终止并结算（真实现里 exitCode 先落定、execFile 回调随后到）。 */
    exit(err: Error | null = null, stdout = ''): void {
      exited = true
      onExit?.(err, stdout)
    },
    /** 只终止不结算：模拟「已退出但结算回调还在路上」的那段窗口。 */
    markExited(): void {
      exited = true
    },
  }
}
/** 记录 promise 是否已结算——用来断言「结算发生在子进程真正退出之后」。 */
function settledFlag(p: Promise<unknown>): { done: boolean } {
  const flag = { done: false }
  const mark = (): void => void (flag.done = true)
  p.then(mark, mark)
  return flag
}
/** 默认参数 = 生产实参（60s 阈值 / 1s 轮询）；虚拟时钟下按原尺寸驱动，不做任何压缩。 */
function watchWithFakeWorld(world: ReturnType<typeof fakeStallWorld>, onBytes?: (d: number) => void): Promise<string> {
  return execWithStallWatch('npm', ['install', 'stuck-pkg'], { env: {} }, '/progress', { deps: world.deps, onBytes })
}
describe('execWithStallWatch stall 检测 (#2004 §3)', () => {
  test('DOWNLOAD_STALL_TIMEOUT_MS 契约 = 60s（spec §3：连续 60 秒零字节进展才判定卡死）', () => {
    expect(DOWNLOAD_STALL_TIMEOUT_MS).toBe(60_000)
  })
  test('连续零字节进展满 60s → 杀树 + reject（不傻等子进程自然退出），且结算等到进程真正退出', async () => {
    vi.useFakeTimers()
    const world = fakeStallWorld(() => 0) // 进展目录全程 0 字节 = 「进程活着但半开连接零字节」的卡死。
    const p = watchWithFakeWorld(world)
    const settled = settledFlag(p)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(world.kills).toEqual([])
    expect(settled.done).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(world.kills).toEqual(['SIGTERM'])
    expect(settled.done).toBe(false)
    world.exit(new Error('Command failed: terminated'))
    await expect(p).rejects.toThrow(/下载卡死：连续 60s 零字节进展/)
  })
  test('SIGTERM 吞掉不退 → 5s 升级 SIGKILL；SIGKILL 也压不死 → 兜底结算并言明进程可能残留', async () => {
    vi.useFakeTimers()
    const world = fakeStallWorld(() => 0)
    const p = watchWithFakeWorld(world)
    const settled = settledFlag(p)
    await vi.advanceTimersByTimeAsync(61_000)
    expect(world.kills).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(STALL_KILL_ESCALATE_MS)
    expect(world.kills).toEqual(['SIGTERM', 'SIGKILL'])
    expect(settled.done).toBe(false)
    await vi.advanceTimersByTimeAsync(STALL_KILL_ESCALATE_MS)
    await expect(p).rejects.toThrow(/下载卡死.*；SIGKILL 后进程仍未退出，可能残留/)
  })
  test('字节持续增长 → 不误杀，且不设总时长上限（跑到阈值的 10 倍仍不杀），等子进程真正跑完', async () => {
    vi.useFakeTimers()
    let served = 0
    const world = fakeStallWorld(() => (served += 1024)) // 每轮都涨一点：慢网大文件的合法形态。
    const p = watchWithFakeWorld(world)
    await vi.advanceTimersByTimeAsync(10 * DOWNLOAD_STALL_TIMEOUT_MS) // 虚拟 10 分钟 = 阈值的 10 倍
    expect(world.kills).toEqual([]) // spec §3：只要字节还在动就继续等，没有总时长上限。
    world.exit(null, 'done-ok')
    await expect(p).resolves.toContain('done-ok') // stdout 原样返回（execFileSync 调用惯例）。
  })
  test('字节只降不涨（npm bookkeeping 波动）→ 不续命，仍按满 60s 零进展杀（假阴性防御）', async () => {
    vi.useFakeTimers()
    const world = fakeStallWorld((poll) => Math.max(0, 100_000 - poll * 1_000))
    const p = watchWithFakeWorld(world)
    const settled = settledFlag(p)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(world.kills).toEqual([]) // 下降不算进展，但也不提前判死。
    await vi.advanceTimersByTimeAsync(1_000)
    expect(world.kills).toEqual(['SIGTERM']) // 首轮基线之后整整 60s 未增长 → 判死，没被波动续命。
    expect(settled.done).toBe(false)
    world.exit(new Error('Command failed: terminated'))
    await expect(p).rejects.toThrow(/下载卡死/)
  })
  test('子进程正常失败（非零退出）→ reject 原始错误，不误判为 stall', async () => {
    vi.useFakeTimers()
    const world = fakeStallWorld(() => 0)
    const p = watchWithFakeWorld(world)
    world.exit(new Error('Command failed: exit code 7')) // 阈值前就退出，中间没有任何 tick。
    await expect(p).rejects.toThrow(/exit code 7/)
    expect(world.kills).toEqual([])
  })
  test('子进程已退出、结算回调还没到 → 轮询不补刀也不判 stall（静默收尾的成功不被误报成卡死）', async () => {
    vi.useFakeTimers()
    const world = fakeStallWorld(() => 0)
    const p = watchWithFakeWorld(world)
    world.markExited() // 已终止，但 execFile 的回调还在路上。
    await vi.advanceTimersByTimeAsync(2 * DOWNLOAD_STALL_TIMEOUT_MS)
    expect(world.kills).toEqual([]) // 不对已死进程补刀，也不冒出 stall 诊断。
    world.exit(null, 'quiet-success')
    await expect(p).resolves.toBe('quiet-success') // 按它真实的退出结算。
  })
  test('真子进程：判卡死后进程确实从操作系统里消失（默认进程边界 = 进程组杀树）', async () => {
    const progressDir = freshDir('stall-real-kill')
    let pid: number | undefined
    const p = execWithStallWatch(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 600000)'],
      { env: process.env },
      progressDir,
      {
        stallTimeoutMs: 150,
        pollIntervalMs: 30,
        deps: {
          readProgressBytes: dirTotalBytes,
          spawn(cmd, args, env, onExit) {
            const child = spawnKillableTree(cmd, args, env, onExit)
            pid = child.pid
            return child
          },
        },
      }
    )
    await expect(p).rejects.toThrow(/下载卡死/)
    expect(pid).toBeGreaterThan(0)
    let alive = true
    for (let i = 0; i < 250 && alive; i++) {
      try {
        process.kill(pid as number, 0)
        await new Promise((r) => setTimeout(r, 20))
      } catch (e) {
        expect((e as NodeJS.ErrnoException).code).toBe('ESRCH') // 只有「进程不存在」算死；EPERM 等要暴露
        alive = false
      }
    }
    expect(alive).toBe(false) // 真被杀死，不是仅 Promise 层面放弃。
  }, 20_000)
})
describe('下载活性外显 (#2136)', () => {
  test('execWithStallWatch onBytes：回报正增长 delta；增长→收缩→再增长 累计单调且收缩后仍推进（#2150 review）', async () => {
    vi.useFakeTimers()
    const readings = [1024 * 1024, 0, 512 * 1024, 512 * 1024]
    const world = fakeStallWorld((poll) => readings[Math.min(poll, readings.length - 1)])
    const deltas: number[] = []
    const p = watchWithFakeWorld(world, (d) => deltas.push(d))
    await vi.advanceTimersByTimeAsync(readings.length * 1_000) // 默认 1s 轮询 → 恰好走完四轮读数
    world.exit(null, '')
    await p
    expect(deltas).toEqual([1024 * 1024, 512 * 1024]) // 只报正增长：truncate 的收缩不回报，持平也不回报
    const cumulative: number[] = []
    deltas.reduce((acc, d) => { const next = acc + d; cumulative.push(next); return next }, 0)
    for (let i = 1; i < cumulative.length; i++) expect(cumulative[i]).toBeGreaterThan(cumulative[i - 1])
    expect(cumulative[cumulative.length - 1]).toBe(1024 * 1024 + 512 * 1024)
  })
})
