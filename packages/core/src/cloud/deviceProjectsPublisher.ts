/**
 * #113 这台机器的项目记到账号上:开机一次,之后项目或文件夹一变就再记一次(桌面与咕咕 server 同一份)。
 *
 *  · 变化往往一串一串来(挂一个文件夹 = 文件夹变了 + 显隐变了):从头一个变化起攒 {@link SETTLE_MS} 再记
 *    (后来的变化不往后推,❌ 一直有变化就一直不记),一次只记一份;记的途中又变了,记完再记一次。
 *  · 没登录 = 不记(登录态一变宿主会再叫一次)。记不上(断网、库拒了、{@link PUBLISH_TIMEOUT_MS} 还没回话 ——
 *    作废那次请求)= 过 {@link RETRY_MS} 再记,直到记上:账号上那份旧着,别的端看到的就是旧的,❌ 只喊一声就算了。
 *  · 记上之后每 {@link REFRESH_MS} 再记一次:账号上那份也会在这台机器不知道的时候没了(设备行被收掉又登记回来,
 *    它的项目跟着删了),这台机器自己没有变化可报。记的是整份,库里没变就什么都不动(不推进账号 revision),多记一次无害。
 */
import { withBoundedOperation } from './boundedOperation'
import { publishDeviceProjects, type DeviceProject, type DeviceProjectsRpcClient } from './deviceProjects'

export const SETTLE_MS = 1_000
export const RETRY_MS = 30_000
export const PUBLISH_TIMEOUT_MS = 60_000
export const REFRESH_MS = 15 * 60_000

export type DeviceProjectsPublisherDeps = {
  getAuth: () => Promise<{ accessToken: string; userId: string } | null>
  /** 这台机器在当前账号下的设备 id(第一次问时先登记设备行,见 createLocalDeviceIdResolver)。 */
  deviceId: () => Promise<string | null>
  client: (accessToken: string) => DeviceProjectsRpcClient
  /** 这台机器此刻的项目(会话页后端读本地库)。 */
  records: () => Promise<DeviceProject[]>
  warn: (message: string, fields: Record<string, unknown>) => void
  setTimeout?: (run: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

export type DeviceProjectsPublisher = {
  /** 可能变了:攒一下再记。 */
  notify(): void
  stop(): void
}

export function createDeviceProjectsPublisher(deps: DeviceProjectsPublisherDeps): DeviceProjectsPublisher {
  const setTimer = deps.setTimeout ?? ((run, ms) => setTimeout(run, ms))
  const clearTimer = deps.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  let timer: unknown = null
  /** 等着的那一拍是攒变化(settle)、记不上之后的重试(retry),还是记上之后的定期再记(refresh)。 */
  let timerKind: 'settle' | 'retry' | 'refresh' | null = null
  let running = false
  let dirty = false
  let stopped = false

  const schedule = (kind: 'settle' | 'retry' | 'refresh', ms: number) => {
    if (stopped || timer !== null) return
    timerKind = kind
    timer = setTimer(() => {
      timer = null
      timerKind = null
      void run()
    }, ms)
  }

  const run = async () => {
    if (stopped) return
    if (running) {
      dirty = true
      return
    }
    running = true
    dirty = false
    let outcome: 'published' | 'signed-out' | 'failed' = 'failed'
    try {
      outcome = await withBoundedOperation(
        PUBLISH_TIMEOUT_MS,
        () => new Error(`publish did not finish within ${PUBLISH_TIMEOUT_MS} ms`),
        async (signal) => {
          const auth = await deps.getAuth()
          if (!auth) return 'signed-out' as const
          const deviceId = await deps.deviceId()
          if (!deviceId) throw new Error('this machine has no device id under the signed-in account yet')
          const records = await deps.records()
          signal.throwIfAborted()
          await publishDeviceProjects(deps.client(auth.accessToken), deviceId, records, signal)
          return 'published' as const
        },
      )
    } catch (error) {
      deps.warn('device projects: publish failed, retrying', { error: String((error as Error)?.message ?? error), retryMs: RETRY_MS })
    } finally {
      running = false
    }
    if (dirty) schedule('settle', SETTLE_MS)
    else if (outcome === 'failed') schedule('retry', RETRY_MS)
    else if (outcome === 'published') schedule('refresh', REFRESH_MS)
  }

  return {
    notify() {
      if (stopped) return
      if (running) {
        dirty = true
        return
      }
      // 已经在攒:照原来那一拍记(❌ 往后推)。在等重试 / 定期再记的那一拍换成马上(攒一下):有了新变化就不必再等。
      if (timerKind === 'settle') return
      if (timer !== null) {
        clearTimer(timer)
        timer = null
        timerKind = null
      }
      schedule('settle', SETTLE_MS)
    },
    stop() {
      stopped = true
      if (timer !== null) clearTimer(timer)
      timer = null
      timerKind = null
    },
  }
}
