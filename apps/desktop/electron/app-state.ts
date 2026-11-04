import { readFileSync, renameSync, writeFileSync } from 'node:fs'

/**
 * 宿主自己的那一格小状态(windowTone、close-to-tray 提示),落成 userData 下的一个 JSON。
 *
 * 读:文件坏了(半截、被中断的零字节)不该让下一次启动起不来 —— 启动链在建窗口时就求值它,
 * 抛出去 = 每次启动都退出,且没有自愈路径。照「没写过」继续。
 * 写:先落临时文件再改名,别让一次中断留下半截文件(与 usage-sync 的水位同一套写法)。
 */
export function readStateFile(file: string): Record<string, unknown> {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    // 只有「还没写过」才按空;读不动(权限/占用这类 I/O 故障)照实抛,❌ 静默当默认值(评审)。
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function writeStateFile(file: string, state: Record<string, unknown>): void {
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(state), 'utf8')
  renameSync(temp, file)
}
