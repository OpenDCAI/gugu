import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 崩溃分诊:把「进程真的坏了」和「网络/电源这类外部环境故障」分开。
 *
 * 起因 #4965:合盖睡眠、唤醒,一串 `net::ERR_*` 与超时里有一个没人接住,撞上 main.ts 的
 * `uncaughtException` → `process.exit(1)`,整个 app 就没了。用户视角是「合盖一下软件全退了」。
 * 网线被拔不是程序坏了,不该按崩溃处置 —— 这是本模块存在的唯一理由。
 *
 * fail loud 仍然是默认档,这里只开一道**窄**口子:
 * - 判据只认错误自身的形状(name / code / message),❌ 不看调用栈、❌ 不看模块来源;
 * - 被**自定义** Error 子类包过的一律判缺陷 —— 包装说明代码已经接手过这个错误,
 *   那时候还没接住,就是真缺陷,不是环境问题;
 * - 只有两种**透明包装**允许下探 cause:`TypeError: fetch failed`(undici 的固定形状)
 *   与 `AggregateError`(且要求每一个子错误都是环境故障)。多网卡/多地址时 Node 抛的就是它。
 * - 放行的每一条都必须落盘留痕(见 recordFatalSync),❌ 静默放过。
 */

/** Node/libuv 的网络类 errno。只收「链路层面连不上/断了」,❌ 收 EACCES、ENOENT 这种配置或代码问题。 */
const RECOVERABLE_ERRNO = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'ENETRESET',
  'EAI_AGAIN',
])
// ❌ EPIPE 不在名单里(owner 2026-09-04 拍板):它更常见的成因是自己往已关闭的流/子进程 stdin 写,
// 那是生命周期 bug 不是断网;真的对端断开会给出 ECONNRESET 这类更明确的码。宁可误杀。
// ❌ `Error: Channel closed`(Electron IPC 关闭期竞态)同样不纳入:它不是环境故障,是关闭路径没处理干净。
// 把它归进「网络断了」等于拿分诊去盖一个生命周期 bug。真在非关闭期出现,应去源头修那一处。

/** WHATWG fetch / AbortSignal 的超时与取消。断网时 `AbortSignal.timeout()` 抛的就是 TimeoutError。 */
const RECOVERABLE_ERROR_NAMES = new Set(['TimeoutError', 'AbortError'])

/**
 * Chromium 网络栈的错误串,形如 `net::ERR_CONNECTION_RESET`、`net::ERR_NETWORK_IO_SUSPENDED`
 * (后者正是 macOS 合盖睡眠时的专属码)。Electron 的 net 请求把它塞在 message 里。
 */
const CHROMIUM_NET_ERROR = /\bnet::ERR_[A-Z0-9_]+/

/** cause 链下探上限。够深到穿过 undici 的包装,又不至于在自引用的链上走远。 */
const MAX_CAUSE_DEPTH = 5

/** 崩溃记录的文件名。append-only,❌ 不随启动轮转 —— 上一次崩溃的现场必须还在。 */
export const CRASH_LOG_BASENAME = 'crash.log'

export type FatalVerdict = 'environment' | 'defect'

const errnoOf = (err: Error): string | null => {
  const code = (err as NodeJS.ErrnoException).code
  return typeof code === 'string' ? code : null
}

/** 只看这一层错误自身,不下探 cause。 */
const selfIsEnvironmentFault = (err: Error): boolean => {
  if (RECOVERABLE_ERROR_NAMES.has(err.name)) return true
  // 自定义子类(name 被改过)一律不算环境故障 —— 见文件头「被包装过的判缺陷」。
  if (err.name !== 'Error') return false
  const code = errnoOf(err)
  if (code && RECOVERABLE_ERRNO.has(code)) return true
  return CHROMIUM_NET_ERROR.test(err.message)
}

/** undici 的 `fetch()` 失败固定是 `TypeError: fetch failed`,真正的原因在 cause 里。 */
const isTransparentFetchWrapper = (err: Error): boolean =>
  err.name === 'TypeError' && err.message === 'fetch failed'

const isAggregate = (err: Error): err is AggregateError =>
  err.name === 'AggregateError' && Array.isArray((err as AggregateError).errors)

const isEnvironmentFault = (value: unknown, depth: number, seen: Set<unknown>): boolean => {
  if (depth > MAX_CAUSE_DEPTH) return false
  if (!(value instanceof Error)) return false
  if (seen.has(value)) return false // cause 自引用:见过就停,❌ 不再往下走
  seen.add(value)

  if (selfIsEnvironmentFault(value)) return true

  // 多地址/多网卡:Node 把每个地址的失败聚成 AggregateError。全是环境故障才算,空数组不算。
  if (isAggregate(value)) {
    const errors = (value as AggregateError).errors
    return errors.length > 0 && errors.every((inner) => isEnvironmentFault(inner, depth + 1, seen))
  }

  if (isTransparentFetchWrapper(value)) {
    return isEnvironmentFault((value as Error & { cause?: unknown }).cause, depth + 1, seen)
  }

  return false
}

/**
 * 这个未捕获错误是「外部环境故障」还是「程序缺陷」?
 * 拿不准一律 `defect` —— 误判成 environment 会把真崩溃咽下去,那是本模块最不能犯的错。
 */
export const classifyFatal = (err: unknown): FatalVerdict =>
  isEnvironmentFault(err, 0, new Set()) ? 'environment' : 'defect'

/**
 * 崩溃现场**同步**落盘。
 *
 * 为什么非同步不可:退出路径上 pino 是异步写,`process.exit(1)` 一执行就再也不会 flush ——
 * #4965 那次退出的堆栈正是这么丢的,事后只剩一个 exit code 1,根因查不动。
 * 又因为 `gugu-main.log` 会被下次启动轮转/覆盖,崩溃记录单独落一个 **append-only** 文件,
 * ❌ 不与主日志同文件。
 *
 * 目录由调用方给(同 logger 的约定:这个模块不认识 electron,单测里直接可用)。
 * 失败**不抛** —— 记不下来也不该反过来把退出路径本身搞崩。
 */
export const recordFatalSync = (params: {
  dir: string | null
  verdict: FatalVerdict
  source: 'uncaughtException' | 'unhandledRejection'
  err: unknown
  now?: () => Date
}): void => {
  const { dir, verdict, source, err } = params
  if (!dir) return
  try {
    const at = (params.now ?? (() => new Date()))().toISOString()
    const error = err instanceof Error ? err : null
    const line = JSON.stringify({
      at,
      pid: process.pid,
      source,
      verdict,
      name: error?.name ?? typeof err,
      message: error?.message ?? String(err),
      code: error ? ((error as NodeJS.ErrnoException).code ?? null) : null,
      stack: error?.stack ?? null,
      cause: error && 'cause' in error && error.cause instanceof Error
        ? { name: error.cause.name, message: error.cause.message }
        : null,
    })
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, CRASH_LOG_BASENAME), `${line}\n`)
  } catch {
    // 落盘失败就算了:此刻正在处理的已经是一个崩溃,❌ 不能再抛第二个。
  }
}
