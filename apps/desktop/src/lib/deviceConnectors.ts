import type { Device } from '@gugu/core/shared/types/chat'
import { deviceKind } from './deviceRowModel'
import { usableActionGroups } from './deviceAvailability'

export type OtherDeviceConnector = { device: Device; group: string }

/**
 * #7199 助理 App「连接应用 · 其他设备」那几行(owner 10-15「连接要分清在哪」):别的设备登记的每一组动作 = 一行
 * 「哪一项 · 经哪台」。那台上能用的(有一个动作可用)归「已授权」,登记了但没开的归「可用」(要去那台上连)。
 * 这台自己(「本机」那一段管)、它住的那台云端宿主(没有设备上的数据,也不给人看)、老的云设备行不在这里;
 * 没登记动作清单的设备(老版本咕咕)一行都不出。纯函数。
 */
export function otherDeviceConnectors(
  devices: readonly Device[],
  homeDeviceId: string | null,
): { authorized: OtherDeviceConnector[]; connectable: OtherDeviceConnector[] } {
  const authorized: OtherDeviceConnector[] = []
  const connectable: OtherDeviceConnector[] = []
  for (const device of devices) {
    const kind = deviceKind(device, homeDeviceId)
    if (kind === 'this' || kind === 'cloud' || kind === 'cloudComputer' || kind === 'phone') continue
    const actions = device.capabilities?.actions?.actions
    if (!actions) continue
    const usable = new Set(usableActionGroups(device) ?? [])
    const seen = new Set<string>()
    for (const action of actions) {
      if (seen.has(action.group)) continue
      seen.add(action.group)
      ;(usable.has(action.group) ? authorized : connectable).push({ device, group: action.group })
    }
  }
  return { authorized, connectable }
}
