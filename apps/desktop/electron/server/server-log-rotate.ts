/** Append-safe rotation for keeper and launchd service stdout. Native Linux services use journald. */
import fs from 'node:fs'

/** 单份日志的上限。两份(当前 + .1)合计最多 2 倍。 */
export const SERVER_LOG_MAX_BYTES = 5 * 1024 * 1024
export const SERVICE_LOG_CHECK_MS = 10 * 60 * 1000

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/**
 * 超过上限就 copytruncate。复制失败(磁盘满)时照样截断 —— 丢掉旧日志,换回磁盘:
 * 日志把盘写满才是要防的那件事。
 */
export function rotateByCopyTruncate(file: string, maxBytes = SERVER_LOG_MAX_BYTES): boolean {
  if (sizeOf(file) <= maxBytes) return false
  try {
    fs.rmSync(`${file}.1`, { force: true })
    fs.copyFileSync(file, `${file}.1`)
  } catch {
    fs.rmSync(`${file}.1`, { force: true })
  }
  try {
    fs.truncateSync(file, 0)
    return true
  } catch {
    return false
  }
}
