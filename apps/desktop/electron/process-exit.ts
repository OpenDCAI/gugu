// Leaving the process when it must not linger: the native-leg reap (every process group Desktop owns), the fatal
// exception exit, and the stop on a lost installation lock. main wires these to its own legs and loggers.
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { killAllWorkersSync } from '@gugu/session-wire/worker'
import { signalProcessDescendantsSync } from '@gugu/session-core/acp/node'
import { killServerDescendantsSync } from './server/server-processes'

interface ExitLogger {
  info: (detail: Record<string, unknown>, message: string) => void
  error: (detail: Record<string, unknown>, message: string) => void
}

/** One native leg Desktop owns, reaped by name. */
export type NativeLeg = readonly [leg: string, run: () => void]

/**
 * 回收点:按「Desktop 拥有的原生腿」逐条同步收(host 进程组在最前,其余由 main 列出),加一条腿就在 main 的
 * 清单里加一行,❌ 不要再让某条腿只靠自己的 exit 钩子。某条腿收失败只记一笔,不挡后面的腿。
 *
 * @@@5163 回收点必须留下一条**同步**痕迹。用 logger 记不行 —— 它是异步写,而这里离进程真正死掉只剩几毫秒,
 * 那行日志永远 flush 不到盘(#4965 上吃过同一个亏)。所以 appendFileSync 一行:它在 kill(2) 之前落地,
 * 能回答「这个回收点有没有被调到」。
 */
export function createNativeLegReap(deps: { logDir: string; serverMode: boolean; logger: ExitLogger; legs: () => readonly NativeLeg[] }): (label: string) => void {
  return (label) => {
    const reap = (leg: string, run: () => void) => {
      try {
        run()
      } catch (err) {
        deps.logger.error({ err, label, leg }, 'native leg process-group reap failed')
      }
    }
    try {
      appendFileSync(join(deps.logDir, 'reap-probe.log'), `${new Date().toISOString()} reap-begin label=${label}\n`)
    } catch { /* 探针不许反噬关停 */ }
    deps.logger.info({ label }, 'native leg reap: begin')
    reap('host-processes', () => killAllWorkersSync(pids => deps.serverMode
      ? killServerDescendantsSync(pids) : signalProcessDescendantsSync(pids, 'SIGKILL')))
    for (const [leg, run] of deps.legs()) reap(leg, run)
    deps.logger.info({ label }, 'native leg reap: done')
    try {
      appendFileSync(join(deps.logDir, 'reap-probe.log'), `${new Date().toISOString()} reap-done  label=${label}\n`)
    } catch { /* 同上 */ }
  }
}

/**
 * uncaughtException。@@@4965 - 先同步落盘再决定去留:pino 是异步写,`process.exit(1)` 之后永远 flush 不到。
 * 合盖睡眠/断网抛出的 net::ERR_* 与超时不是「程序坏了」:fail loud 照旧(响亮记账 + 崩溃文件留痕),但❌ 不拿进程陪葬。
 */
export function createFatalExit<Verdict extends string>(deps: {
  classify: (err: unknown) => Verdict
  record: (entry: { verdict: Verdict; source: 'uncaughtException'; err: unknown }) => void
  logger: { error: (detail: Record<string, unknown>, message: string) => void }
  reap: (label: string) => void
  exit: (code: number) => void
}): (err: unknown) => void {
  return (err) => {
    const verdict = deps.classify(err)
    deps.record({ verdict, source: 'uncaughtException', err })
    if (verdict === 'environment') {
      deps.logger.error({ err }, '未捕获异常判为环境故障(网络/电源)— 已记账,进程继续')
      return
    }
    deps.logger.error({ err }, '未捕获异常 — 收引擎进程组后退出')
    deps.reap('uncaughtException')
    deps.exit(1) // fail loud:非零退出,别把崩溃咽下装没事
  }
}

/** A single-run server that no longer owns its installation lock stops: another one owns this home now. */
export function stopOnLostLock(deps: {
  singleRun: () => boolean
  ownsHomeLock: () => boolean | undefined
  logger: { error: (message: string) => void }
  reap: (label: string) => void
  exit: (code: number) => void
  exitCode: number
}): void {
  if (deps.singleRun() && deps.ownsHomeLock() === false) {
    deps.logger.error('Installation lock ownership was lost; stopping this server.')
    deps.reap('lock-lost')
    deps.exit(deps.exitCode)
  }
}
