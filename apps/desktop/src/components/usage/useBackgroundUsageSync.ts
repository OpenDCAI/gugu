import { useEffect } from 'react'
import { canSyncLocalUsage, syncLocalUsage } from '../../lib/usage/sync'
import { rendererLogger } from '../../lib/log'

const log = rendererLogger('usage/background-sync')

const FIRST_DELAY_MS = 30_000
const INTERVAL_MS = 30 * 60_000

/**
 * 桌面端后台把本机用量送上云端(product spec「跨设备」):启动 30 秒后一次,之后每 30 分钟一次。
 * 这样在另一台设备(或手机)上打开用量页时,这台机器的数字最多晚半小时。
 * 失败只记日志:这是后台同步,下一轮会重试,❌ 不打扰人。
 */
export function useBackgroundUsageSync(userId: string | null, active: boolean): void {
  useEffect(() => {
    if (!userId || !active || !canSyncLocalUsage()) return
    const run = () => { syncLocalUsage().catch((e: unknown) => log.warn({ error: e instanceof Error ? e.message : String(e) }, 'background sync failed')) }
    const first = window.setTimeout(run, FIRST_DELAY_MS)
    const timer = window.setInterval(run, INTERVAL_MS)
    return () => { window.clearTimeout(first); window.clearInterval(timer) }
  }, [userId, active])
}
