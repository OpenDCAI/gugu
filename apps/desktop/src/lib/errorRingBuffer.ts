// @@@2314 反馈诊断快照的「最近报错」来源:内存环形缓冲(≤20 条,单条截 500 字)。
// 内存那份不落盘不外传;仅当用户主动提交反馈时,collectFeedbackDiagnostics 读走随快照上传——这是一次性
// 快照的组成部分,不是遥测(B 档持续埋点被 owner 否掉,见 #2314)。#2382 起同一批报错另外回传到**本机**
// 主进程日志文件(见下方 forwardToMainLog),仍然只在本机、不外传。

import { hasRendererLogBridge, rendererLogger } from './log'

export interface RecentError {
  at: string
  kind: 'error' | 'unhandledrejection' | 'console.error'
  message: string
}

const MAX_ENTRIES = 20
const MAX_MESSAGE = 500

const buf: RecentError[] = []

// @@@logging (#2382) - 同一批报错**顺手回传主进程日志**,落进 `userData/logs/gugu-main.log`(scope
// `renderer/error-ring`)。为什么值得加:环形缓冲只在内存里转,用户不提交反馈就等于没发生 —— 渲染层崩在
// 提交之前,证据就没了。落盘之后至少事后拿得到。内存快照照旧,两者不互相替代。
const forwardLog = rendererLogger('error-ring')
// 报错风暴(React 重渲染循环)能把这条通道打成刷屏 → 每 10s 最多转发 20 条;抑制了多少要**响亮**说一声,
// ❌ 不静默丢。
const FORWARD_WINDOW_MS = 10_000
const FORWARD_MAX = 20
let windowStartedAt = 0
let forwarded = 0
let suppressed = 0
let flushTimer: ReturnType<typeof setTimeout> | null = null

/** 把「抑制了 N 条」自己刷出去。❌ 不能等下一条报错来触发 —— 报错风暴的尾巴(崩溃前那段)最需要留痕。 */
function scheduleSuppressedFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    const missed = suppressed
    suppressed = 0
    if (missed) forwardLog.warn({ suppressed: missed }, `报错转发限流:抑制了 ${missed} 条`)
  }, FORWARD_WINDOW_MS)
}

/** 回传时附带的排障上下文(不进内存快照 —— #2314 的形状不动)。 */
interface ForwardContext {
  stack?: string
  source?: string
}

/** 从任意值里尽力取一段调用栈:`TypeError: Failed to fetch` 没有栈就等于查不下去(#2391 ④)。 */
function stackOf(value: unknown): string | undefined {
  if (value instanceof Error && value.stack) return value.stack.slice(0, 2000)
  if (Array.isArray(value)) {
    for (const v of value) {
      const s = stackOf(v)
      if (s) return s
    }
  }
  return undefined
}

function forwardToMainLog(kind: RecentError['kind'], message: string, ctx: ForwardContext = {}): void {
  // ❌ 没有回传通道(web 目标)时绝不能走 console 兜底:本函数就挂在 console.error 上,兜底会自己喂自己 → 爆栈。
  if (!hasRendererLogBridge()) return
  const now = Date.now()
  if (now - windowStartedAt > FORWARD_WINDOW_MS) {
    const missed = suppressed
    windowStartedAt = now
    forwarded = 0
    suppressed = 0
    if (missed) forwardLog.warn({ suppressed: missed }, '报错转发限流:上一个窗口抑制了若干条')
  }
  if (forwarded >= FORWARD_MAX) {
    suppressed += 1
    scheduleSuppressedFlush()
    return
  }
  forwarded += 1
  forwardLog.error({ kind, ...ctx }, message)
}

function toMessage(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function push(kind: RecentError['kind'], value: unknown, ctx: ForwardContext = {}): void {
  const message = toMessage(value).slice(0, MAX_MESSAGE)
  buf.push({ at: new Date().toISOString(), kind, message })
  if (buf.length > MAX_ENTRIES) buf.shift()
  forwardToMainLog(kind, message, { stack: ctx.stack ?? stackOf(value), source: ctx.source })
}

let installed = false

// 入口(main.tsx)尽早调用一次;幂等,StrictMode/热重载重复调用不叠钩。
export function installErrorRingBuffer(): void {
  if (installed) return
  installed = true
  // 带上 stack 与出错位置:`TypeError: Failed to fetch` 这种只有一句消息的报错,没有这两样就查不下去(#2391 ④)。
  window.addEventListener('error', (e) => push('error', e.message || e.error, {
    stack: stackOf(e.error),
    source: e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined,
  }))
  window.addEventListener('unhandledrejection', (e) => push('unhandledrejection', e.reason, { stack: stackOf(e.reason) }))
  const original = console.error.bind(console)
  console.error = (...args: unknown[]) => {
    // 先把原始输出交出去,再记账。React 的错误边界(componentDidCatch)正是经 console.error 报错的:
    // 这里若在 original 之前 push、而 push 自己抛(序列化 / 回传通道),抛的是边界 → React 卸载整棵树,
    // 「记录一次崩溃」变成「制造一次白屏」。记账失败只能吞,❌ 不能沿 console.error 再报 —— 那是自己喂自己(#5610 §2.5)。
    original(...args)
    try {
      // 栈从参数里的 Error 对象取(`console.error('失败:', err)` 是最常见的形态)
      push('console.error', args.map(toMessage).join(' '), { stack: stackOf(args) })
    } catch {
      // 记账通道坏了不该反噬报错方;原始输出已经出去了。
    }
  }
}

export function recentErrors(): RecentError[] {
  return [...buf]
}
