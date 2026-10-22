/**
 * #113 这台机器的项目记到账号上:开机一次,之后项目或文件夹一变就再记一次(桌面与咕咕 server 同一份)。
 *
 *  · 变化往往一串一串来(挂一个文件夹 = 文件夹变了 + 显隐变了):攒 {@link SETTLE_MS} 再记,一次只记一份;
 *    记的途中又变了,记完再记一次。
 *  · 没登录 = 不记(登录态一变宿主会再叫一次)。记不上(断网、库拒了)= 过 {@link RETRY_MS} 再记,直到记上 ——
 *    账号上那份旧着,别的端看到的就是旧的,❌ 只喊一声就算了。
 *  · 记的是整份:库里没变就什么都不动(不推进账号 revision),所以多记一次无害。
 */
import { publishDeviceProjects, type DeviceProject, type DeviceProjectsRpcClient } from './deviceProjects'

export const SETTLE_MS = 1_000
export const RETRY_MS = 30_000

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
  let running = false
  let dirty = false
  let stopped = false

  const schedule = (ms: number) => {
    if (stopped || timer !== null) return
    timer = setTimer(() => {
      timer = null
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
    let retry = false
    try {
      const auth = await deps.getAuth()
      if (auth) {
        const deviceId = await deps.deviceId()
        if (!deviceId) throw new Error('this machine has no device id under the signed-in account yet')
        await publishDeviceProjects(deps.client(auth.accessToken), deviceId, await deps.records())
      }
    } catch (error) {
      retry = true
      deps.warn('device projects: publish failed, retrying', { error: String((error as Error)?.message ?? error), retryMs: RETRY_MS })
    } finally {
      running = false
    }
    if (dirty) schedule(SETTLE_MS)
    else if (retry) schedule(RETRY_MS)
  }

  return {
    notify() {
      if (stopped) return
      if (running) {
        dirty = true
        return
      }
      // 正在等重试的那一拍也换成马上(攒一下):有了新变化就不必再等 30 秒。
      if (timer !== null) {
        clearTimer(timer)
        timer = null
      }
      schedule(SETTLE_MS)
    },
    stop() {
      stopped = true
      if (timer !== null) clearTimer(timer)
      timer = null
    },
  }
}
