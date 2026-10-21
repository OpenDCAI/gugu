import { spawnSync, type ChildProcess } from 'node:child_process'
import { expect } from 'vitest'
import { HEARTBEAT_MS } from './awaitCondition'

/**
 * 等**事实**,不等墙钟 (#4357 / #5428 / #5955)。
 *
 * 用例里「起一个子进程,等它做完第一步」的判据,从前各自带一个毫秒预算(5s / 10s / 15s / 20s)。
 * mac1 上那一步的耗时不由我们决定:macOS 对**刚创建的可执行文件**的首次 execve 收一道全机串行的
 * 安全检查,并发车道一多,同一个 spawn-helper 首次 PTY spawn 实测 2.8s–108s,而同一个 inode
 * 第二次只要 20–42ms(2026-09-22,负载 40–65)。预算与被测量同阶 ⇒ 红的位置与被测行为无关。
 *
 * 所以这里的等待**没有 deadline**,只有两种结局:
 * - 事实出现 ⇒ resolve;
 * - 产出事实的那个进程先死了 ⇒ 立刻 reject,带上退出码与信号(它再也产不出这个事实了)。
 * 真挂住(进程活着、永远不产出)时,唯一的上限是最外层 —— CI job 的 `timeout-minutes`。
 * 为了让那一刻看得出**卡在哪一步**,等待超过 {@link HEARTBEAT_MS} 仍未结束就往 stderr 报一行
 * `[awaiting-fact]`。这行只报告,不判定:它不会让任何东西变红或变绿。
 *
 * ❌ 别在这里加「最多等 N 秒」的参数。要证明「某件事没有发生」,就去等那个能证明它的事件
 * (进程退出、对端关闭),而不是等一段时间然后宣布它没发生。
 */

/** 等待多久之后开始报「还在等」。只影响日志,不影响判定。与浏览器侧(awaitCondition.ts)同一个值。 */
export { HEARTBEAT_MS }

function currentTestName(): string {
  try {
    return expect.getState().currentTestName ?? '(outside a test)'
  } catch {
    return '(outside a test)'
  }
}

/** promise 挂着期间每 {@link HEARTBEAT_MS} 报一行「还在等 <step>」;promise 本身原样返回。 */
export function awaitPending<T>(step: string, promise: Promise<T>): Promise<T> {
  const testName = currentTestName()
  const startedAt = Date.now()
  const heartbeat = setInterval(() => {
    const seconds = Math.round((Date.now() - startedAt) / 1000)
    process.stderr.write(`[awaiting-fact] ${testName} — ${step}: still pending after ${seconds}s\n`)
  }, HEARTBEAT_MS)
  heartbeat.unref()
  return promise.finally(() => clearInterval(heartbeat))
}

function exitDescription(child: ChildProcess): string | undefined {
  if (child.exitCode === null && child.signalCode === null) return undefined
  return `exit=${child.exitCode ?? 'null'} signal=${child.signalCode ?? 'none'}`
}

/**
 * 子进程**退出且 stdio 读尽**('close' 的语义)。'exit' 早于管道读完 —— 只等 'exit' 的调用方
 * 会读到截断的 stdout/stderr。已经 close 过就立刻给。
 */
function closed(child: ChildProcess): Promise<void> {
  const drained = [child.stdout, child.stderr].every((stream) => !stream || stream.readableEnded || stream.destroyed)
  if (exitDescription(child) && drained) return Promise.resolve()
  return new Promise((resolve) => child.once('close', () => resolve()))
}

/** 子进程退出、且它的 stdout/stderr 已读尽。 */
export function awaitExit(
  step: string,
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return awaitPending(
    step,
    new Promise((resolve, reject) => {
      child.once('error', (error) => reject(new Error(`${step}: ${error.message}`)))
      void closed(child).then(() => resolve({ code: child.exitCode, signal: child.signalCode }))
    }),
  )
}

/**
 * 反复读 `read()`,直到它给出一个值(非 undefined)。`producer` 是产出这个事实的进程:
 * 它一旦退出而事实还没出现,就立刻 reject —— 不再有任何人能让它出现。
 */
export function awaitFact<T>(
  step: string,
  read: () => T | undefined | Promise<T | undefined>,
  options: { producer?: ChildProcess; intervalMs?: number } = {},
): Promise<T> {
  const { producer, intervalMs = 20 } = options
  return awaitPending(
    step,
    (async () => {
      for (;;) {
        const value = await read()
        if (value !== undefined) return value
        const exited = producer && exitDescription(producer)
        if (exited) {
          // 退出早于管道读完:等 stdio 读尽后再读最后一次,读到了就算数。
          await closed(producer)
          const last = await read()
          if (last !== undefined) return last
          throw new Error(`${step}: the producing process exited (${exited}) before the fact appeared`)
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs))
      }
    })(),
  )
}

function parentPid(pid: number): number | undefined {
  const run = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' })
  const value = Number.parseInt(run.stdout?.trim() ?? '', 10)
  return Number.isInteger(value) ? value : undefined
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 等这些 pid 从进程表里消失(被收尸)。「没被收尸」本身不是一个会发生的事件,所以同时等那个**能证明
 * 收尸失败**的事件:进程被 init/launchd 收养(ppid 变成 1)—— 它的父进程已经死了、它自己还活着,
 * 这就是孤儿,当场响亮失败。只有「父进程还活着、就是不杀它」这一种没有事件,会挂到 job 上限、心跳指名。
 */
export function awaitReaped(step: string, pids: number[]): Promise<void> {
  if (process.platform === 'win32') throw new Error(`${step}: awaitReaped reads ppid via ps and is POSIX-only`)
  return awaitFact(step, () => {
    const alive = pids.filter(isAlive)
    if (alive.length === 0) return true
    const orphans = alive.filter((pid) => parentPid(pid) === 1)
    if (orphans.length > 0) throw new Error(`${step}: pid ${orphans.join(',')} was orphaned (ppid=1) instead of reaped`)
    return undefined
  }, { intervalMs: 100 }).then(() => undefined)
}
