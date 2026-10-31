import type { Device } from '@gugu/core/shared/types/chat'
import type { CloudComputerStoreState } from './cloudComputerStore'

/** Feature visibility is not readiness: a failed status request cannot enable cloud setup. */
export function canSetUpCloudAssistant(cloud: Pick<CloudComputerStoreState, 'available' | 'loadError'>): boolean {
  return cloud.available && cloud.loadError === null
}

type HomeRow = Pick<Device, 'device_id' | 'cloud_computer'> & { capabilities?: Pick<Device['capabilities'], 'assistant_home'> | null }

/**
 * #7199 个人助理住的那台云端宿主(实现上叫云电脑)。owner 10-15「用户只知道个人助理 Agent，甚至不需要知道它生活在哪儿。
 * 云设备通常不能创建任务，它就是个人助理的宿主机」:设备列表、选机器、「在哪跑」一律不列它(product spec
 * 「它住在哪:用户看不到」)。认它(三样任一):那台自己随心跳报的 `capabilities.assistant_home`(设备行一出现就有)、
 * 管家给的 deviceId(任何状态都在)、设备行上补的 `cloud_computer`(睡着 / 醒着时)。
 * 要叫醒它、读它家里东西的地方(助理 App、私聊的「在休息」)照旧读完整的设备表。
 */
export function isAssistantHome(device: HomeRow, homeDeviceId: string | null): boolean {
  return device.capabilities?.assistant_home === true || !!device.cloud_computer || (homeDeviceId !== null && device.device_id === homeDeviceId)
}

export function withoutAssistantHome<T extends HomeRow>(devices: readonly T[], homeDeviceId: string | null): T[] {
  return devices.filter((device) => !isAssistantHome(device, homeDeviceId))
}

/**
 * #7199 个人助理此刻住哪(owner 10-16:会员住云上、非会员住自己的电脑,升降级 = 搬家)。界面按这个说话:
 * 住云上 = 24 小时在(owner 10-17 ❌「休息中 / 叫醒它」,宿主收回着是后台资源的事);住电脑 = 那台开着它才在,❌ 说「云」、❌ 出「叫醒」。
 * `thisDevice` = 就是眼前这台(读写它家走本机,❌ 绕远程连自己);`known` = 设备表里找得到那一行(找不到 = 那台被移除了 / 表还没读到)。
 */
export type AssistantHomePlace =
  | { kind: 'cloud'; deviceId: string }
  | { kind: 'computer'; deviceId: string; thisDevice: boolean; label: string | null; online: boolean; known: boolean }

type PlaceRow = HomeRow & Pick<Device, 'label' | 'is_online' | 'is_current_device'>

export function assistantHomePlace(
  homeDeviceId: string | null | undefined,
  devices: readonly PlaceRow[],
  cloudDeviceId: string | null,
): AssistantHomePlace | null {
  if (!homeDeviceId) return null
  if (homeDeviceId === cloudDeviceId) return { kind: 'cloud', deviceId: homeDeviceId }
  const row = devices.find((device) => device.device_id === homeDeviceId)
  if (row && isAssistantHome(row, cloudDeviceId)) return { kind: 'cloud', deviceId: homeDeviceId }
  return {
    kind: 'computer',
    deviceId: homeDeviceId,
    thisDevice: row?.is_current_device === true,
    label: row?.label ?? null,
    online: row?.is_online === true,
    known: !!row,
  }
}
