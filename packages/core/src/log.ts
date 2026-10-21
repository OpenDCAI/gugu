// @@@logging (#2382) - core 的日志出口。
//
// core 是 transport-agnostic 的:同一份代码跑在 Electron 主进程、cloud worker、脚本和单测里,所以它**不能**
// 直接 import 主进程那套 pino 基座(那会把 electron/文件路径的假设带进 core)。这里只定义**接口 + 注入点**:
// 宿主在启动时把自己的实现塞进来(主进程塞 pino 的 child logger),没人塞就退化成 console —— 与改动前行为一致,
// ❌ 不静默吞掉。
//
// 用法(core 内部):
//   const log = coreLogger('device-runtime')
//   log.warn({ commandId, err }, '投递结果回写失败')
export type CoreLogFields = Record<string, unknown>

export interface CoreLogger {
  debug(fields: CoreLogFields, msg: string): void
  info(fields: CoreLogFields, msg: string): void
  warn(fields: CoreLogFields, msg: string): void
  error(fields: CoreLogFields, msg: string): void
}

/** 宿主提供的工厂:给一个 scope,返回该 scope 的 logger。 */
export type CoreLoggerFactory = (scope: string) => CoreLogger

// 退化实现:没有宿主注入时打 console(和改动前一模一样的可见性,不多不少)。
const consoleFactory: CoreLoggerFactory = (scope) => {
  const emit = (level: 'debug' | 'info' | 'warn' | 'error') => (fields: CoreLogFields, msg: string) => {
    const method = level === 'debug' ? console.debug : level === 'info' ? console.info : level === 'warn' ? console.warn : console.error
    const hasFields = fields && Object.keys(fields).length > 0
    if (hasFields) method(`[${scope}] ${msg}`, fields)
    else method(`[${scope}] ${msg}`)
  }
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') }
}

let factory: CoreLoggerFactory = consoleFactory

/**
 * 宿主注入自己的实现(主进程在 initLogging 之后调一次)。返回撤销函数,单测用它还原。
 * 注入点是**全局**的:core 里的 logger 是懒取的(每次调用现取 factory),所以注入时机不必早于 import。
 */
export function setCoreLoggerFactory(next: CoreLoggerFactory | null): () => void {
  const previous = factory
  factory = next ?? consoleFactory
  return () => {
    factory = previous
  }
}

/** 取一个带 scope 的 logger。每次调用都现取当前 factory —— 宿主可以在任何时刻接管。 */
export function coreLogger(scope: string): CoreLogger {
  return {
    debug: (f, m) => factory(scope).debug(f, m),
    info: (f, m) => factory(scope).info(f, m),
    warn: (f, m) => factory(scope).warn(f, m),
    error: (f, m) => factory(scope).error(f, m),
  }
}
