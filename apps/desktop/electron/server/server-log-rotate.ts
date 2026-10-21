/**
 * #6264 咕咕 server 自己的日志都有上限(Zed 远端日志曾涨到 95GB,之后改成 1MB 上限 + 轮转:zed#57042 → PR zed#57672)。
 *
 * 账号进程的日志本来就轮转(electron/lib/logger.ts)。这里管剩下两份:
 *  · supervisor.log:守护进程自己写的,写之前超过上限就整份挪成 .1(只留一份旧的);
 *  · service.log:兜底模式 / launchd 下所有进程的 stdout,由看门人或 launchd **持有 fd** 在写 ——
 *    改名挪不走它(那个 fd 还指着旧文件),只能照 logrotate 的 copytruncate:先把内容复制成 .1,再把原文件截成 0。
 *    写它的 fd 都是 O_APPEND 打开的(`>>`、fs.openSync 'a'、launchd),截断后接着从新的末尾写,不会出空洞。
 *
 * 开销:supervisor.log 每写一行多一次 fstat;service.log 由守护进程每 10 分钟 stat 一次。
 */
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

/** 超过上限就把整份挪成 `.1`(覆盖更早的那份)。给「只有自己在写、每次写都重新打开」的日志用。 */
export function rotateByRename(file: string, maxBytes = SERVER_LOG_MAX_BYTES): boolean {
  if (sizeOf(file) <= maxBytes) return false
  try {
    fs.renameSync(file, `${file}.1`)
    return true
  } catch {
    return false
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
