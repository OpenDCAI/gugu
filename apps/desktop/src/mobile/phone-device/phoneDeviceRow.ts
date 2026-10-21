// #7199 手机当设备 —— 这台手机写进 gugu_devices 的那一行(与桌面心跳同一张表、同一组列)。纯函数,可单测。
import type { DeviceActionsCapability } from '@gugu/core/shared/deviceActions'
import type { PhoneDeviceInfo } from './nativePhoneActions'

/** 包名推出档位:app.gugu.chat = production,app.gugu.chat.<x> = x(Beta 是 beta;同机并存的测试包各占一行)。 */
export function tierOfPackage(pkg: string): string {
  if (pkg === 'app.gugu.chat') return 'production'
  const prefix = 'app.gugu.chat.'
  return pkg.startsWith(prefix) && pkg.length > prefix.length ? pkg.slice(prefix.length) : 'production'
}

export function phoneLabel(info: PhoneDeviceInfo): string {
  if (info.device_name) return info.device_name
  const brand = info.brand ? info.brand.charAt(0).toUpperCase() + info.brand.slice(1) : ''
  return info.model.toLowerCase().startsWith(info.brand.toLowerCase()) ? info.model : `${brand} ${info.model}`.trim()
}

/** 设备行(与桌面心跳同一张表、同一组列;host_kind = phone 让「在哪跑」把它分出去)。 */
export function phoneDeviceRow(input: {
  deviceId: string
  userId: string
  installId: string
  info: PhoneDeviceInfo
  actions: DeviceActionsCapability
  nowIso: string
}) {
  const { info } = input
  return {
    device_id: input.deviceId,
    user_id: input.userId,
    label: phoneLabel(info),
    hostname: `${info.manufacturer} ${info.model}`.trim(),
    machine_id: input.installId,
    platform: 'android',
    tier: tierOfPackage(info.package),
    status: 'online',
    last_seen_at: input.nowIso,
    updated_at: input.nowIso,
    capabilities: {
      terminals: [],
      runtimes: [],
      host_runtime_capability: 0,
      host_kind: 'phone',
      os_name: info.rom ? `Android ${info.android} · ${info.rom}` : `Android ${info.android}`,
      ...(info.app_version ? { app_version: info.app_version } : {}),
      actions: input.actions,
    },
  }
}
