// #7199 手机「健康」页:数据就在这台手机上(Health Connect),❌ 绕云端问自己。读不到分几种如实说,每种给下一步。
import type { HealthSummary } from '@gugu/core/shared/healthSummary'
import { nativeFailure, type NativeHealthStatus } from '../phone-device/nativePhoneActions'

export type PhoneHealthView =
  /** 不在咕咕安卓 App 里(网页版、iOS):这台设备上没有能读的健康数据。 */
  | { state: 'not-android' }
  /** 网页比安装包新:原生还没有健康这几个方法。 */
  | { state: 'old-app' }
  /** 没有 Health Connect(安卓 14 起系统自带)。 */
  | { state: 'unsupported' }
  /** Health Connect 里一类都没给咕咕。 */
  | { state: 'not-granted' }
  /** 给过、读的时候系统又不让读了。 */
  | { state: 'os-permission'; message: string }
  | { state: 'failed'; message: string }
  | { state: 'ok'; summary: HealthSummary }

/** 原生没有这个方法(Capacitor 的 UNIMPLEMENTED,与 phoneDeviceRuntime 认的同一种)。 */
function unimplemented(error: unknown): boolean {
  const raw = error as { code?: unknown; message?: unknown } | null
  return raw?.code === 'UNIMPLEMENTED' || /not implemented|No method \w+ found/i.test(String(raw?.message ?? ''))
}

export async function readPhoneHealthView(deps: {
  platform: string
  healthStatus: () => Promise<NativeHealthStatus>
  readSummary: (status: NativeHealthStatus) => Promise<HealthSummary>
}): Promise<PhoneHealthView> {
  if (deps.platform !== 'android') return { state: 'not-android' }
  let status: NativeHealthStatus
  try {
    status = await deps.healthStatus()
  } catch (error) {
    if (unimplemented(error)) return { state: 'old-app' }
    return { state: 'failed', message: nativeFailure(error).message }
  }
  if (!status.supported) return { state: status.old_app ? 'old-app' : 'unsupported' }
  if (status.granted_types.length === 0) return { state: 'not-granted' }
  try {
    return { state: 'ok', summary: await deps.readSummary(status) }
  } catch (error) {
    const failure = nativeFailure(error)
    return failure.code === 'os_permission' ? { state: 'os-permission', message: failure.message } : { state: 'failed', message: failure.message }
  }
}

/** 手机给的时间是带偏移的本地时间:时刻原样取「HH:MM」(与桌面健康页同一种写法)。 */
export function healthClock(iso: string): string {
  const match = /T(\d{2}:\d{2})/.exec(iso)
  return match ? match[1]! : iso
}

/** 页面开着时多久再读一次(与桌面同一个节奏)。 */
export const PHONE_HEALTH_REFRESH_MS = 5 * 60_000
