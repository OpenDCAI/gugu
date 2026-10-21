// @@@logging (#2382) - renderer 侧日志:回传主进程,和主进程日志同流、同脱敏、同落盘。
//
// 为什么要回传:渲染侧的 `console` 只活在 devtools 里 —— 用户机器上崩了,那些行拿不回来。回传之后它们
// 落在 `userData/logs/gugu-main.log`,scope 前缀 `renderer/`,一眼看得出来源。
//
// web 目标(GUGU_TARGET=web)没有 electronAPI → 退化打 console,行为与改动前一致(❌ 不静默吞掉)。
/** 必须与 electron/lib/logger.ts 的 RENDERER_LOG_CHANNEL 一致(单测有绊线守着:两边不同即红)。 */
export const RENDERER_LOG_CHANNEL = 'log:write'

let warnedOnce = false

type Level = 'debug' | 'info' | 'warn' | 'error'
type Fields = Record<string, unknown>

interface ElectronBridge {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
}

const bridge = (): ElectronBridge | null => {
  const api = (globalThis as { electronAPI?: ElectronBridge }).electronAPI
  return api && typeof api.invoke === 'function' ? api : null
}

/**
 * 有没有回传通道(= 跑在 Electron 里)。
 * 给**本身就在 console 钩子里**的调用方用:那种地方一旦落到 console 兜底,就会自己喂自己
 * (console.error → 钩子 → 回传兜底 → console.error → …)—— 递归到爆栈。它们必须先问这一句。
 */
export function hasRendererLogBridge(): boolean {
  return bridge() !== null
}

export interface RendererLogger {
  debug(fields: Fields, msg: string): void
  info(fields: Fields, msg: string): void
  warn(fields: Fields, msg: string): void
  error(fields: Fields, msg: string): void
}

/**
 * `const log = rendererLogger('chat/input')` → `log.warn({ chatId }, '发送失败')`。
 * 回传是 fire-and-forget:日志失败不该影响 UI 流程(❌ 抛给调用方)。
 */
export function rendererLogger(scope: string): RendererLogger {
  const emit = (level: Level) => (fields: Fields, msg: string): void => {
    const api = bridge()
    if (!api) {
      const method = level === 'debug' ? console.debug : level === 'info' ? console.info : level === 'warn' ? console.warn : console.error
      method(`[${scope}] ${msg}`, fields)
      return
    }
    void api.invoke(RENDERER_LOG_CHANNEL, { scope, level, msg, fields }).catch((error: unknown) => {
      // 回传失败不该拖累 UI(所以不抛),但**第一次**要响亮 —— 否则通道改名/没注册时,整条 renderer 证据链
      // 会无声消失,而它正是这套东西的核心用途(review 指出)。
      if (!warnedOnce) {
        warnedOnce = true
        console.warn(`[renderer-log] 回传失败,渲染层日志不会落盘:${String(error)}`)
      }
    })
  }
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') }
}
