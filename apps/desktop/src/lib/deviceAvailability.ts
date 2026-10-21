import type { Device } from '@gugu/core/shared/types/chat'
import type { DeviceRowKind } from './deviceRowModel'

/**
 * #7199 助理 App「能力 · 设备」每台的「能不能随时调到」:
 * - 云电脑 = 24 小时可用:睡着时有事会被叫醒(管家),随时调得到;
 * - 手机 = 非全天可用:咕咕开着(含切到后台的「后台守着」)才调得到,被划掉就不行 —— 一期不接推送,
 *   所以没有「开了通知就 24 小时」这种说法;
 * - 电脑、服务器 = 不标(只写在线 / 离线):开着就在线,用不着另一层说法。
 */
export type DeviceAvailability = 'allDay' | 'notAllDay'

export function deviceAvailability(kind: DeviceRowKind, device: Pick<Device, 'capabilities'>): DeviceAvailability | null {
  if (kind === 'cloudComputer') return 'allDay'
  if (kind === 'phone' || (kind === 'this' && device.capabilities?.host_kind === 'phone')) return 'notAllDay'
  return null
}

/**
 * 这台登记了哪几组动作、此刻能用的是哪几组(从设备行上的动作清单读;本机电脑另有现读的状态,不走这里)。
 * 没登记清单(老版本咕咕、云电脑)= null。
 */
export function usableActionGroups(device: Pick<Device, 'capabilities'>): string[] | null {
  const actions = device.capabilities?.actions?.actions
  if (!actions) return null
  const groups: string[] = []
  for (const action of actions) if (action.available && !groups.includes(action.group)) groups.push(action.group)
  return groups
}
