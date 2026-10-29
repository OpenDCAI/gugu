/**
 * 宿主上一次是怎么退出的:开机收残据此说清在跑的那一轮是被什么打断的(`settleAfterRestart`)。
 *
 * 有计划的退出先在数据目录里留一句:守护进程换版 / 自己升级之前写 `update`;进程自己走正常退出
 * (桌面 before-quit、server 收到 SIGTERM / SIGINT)时写 `restart`,已经有 `update` 就不改。
 * 开机读到就用它并删掉;读不到 = 上一次没走正常退出(崩溃、被杀、机器断电)。
 * 只用 node:fs:守护进程(没有数据库)与宿主进程都引它。写在退出路径上,所以同步写、出错不抛。
 */
import fs from 'node:fs'
import path from 'node:path'

export type ExitReason = 'update' | 'restart'
/** 开机时读到的:`unclean` = 上一次没留话。 */
export type LastExit = ExitReason | 'unclean'

const FILE = 'last-exit.json'

export function noteExitReason(dataDir: string, reason: ExitReason): void {
  try {
    const file = path.join(dataDir, FILE)
    if (reason === 'restart' && fs.existsSync(file)) return
    fs.writeFileSync(file, JSON.stringify({ reason, at: Date.now() }))
  } catch {
    // 留不下话只是开机时说得笼统一点,❌ 挡退出。
  }
}

/** 读上一次留的话并删掉(一次退出只说一次)。 */
export function takeLastExit(dataDir: string): LastExit {
  const file = path.join(dataDir, FILE)
  let reason: unknown = null
  try {
    reason = (JSON.parse(fs.readFileSync(file, 'utf8')) as { reason?: unknown }).reason
  } catch {
    reason = null
  }
  try {
    fs.rmSync(file, { force: true })
  } catch {
    // 删不掉下次再说一遍「重启」,不挡开机。
  }
  return reason === 'update' || reason === 'restart' ? reason : 'unclean'
}
