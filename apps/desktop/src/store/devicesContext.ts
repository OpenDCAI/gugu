import { createContext, useContext } from 'react'
import type { Device } from '@gugu/core/shared/types/chat'
import type { MachineLimitRefusal } from '@gugu/core/cloud/machineLimit'
import type { DeviceBoundAgent } from '../lib/chat'
import type { CloudComputerStoreState } from '../lib/cloudComputerStore'

// #1749 设备 store 的单一事实源：设置面板与 create-agent selector 都只订这里（列表 + 排序 + 实时在线 +
// rename/remove 动作）。设计见 docs/devices-abstraction-design.md。
export interface DevicesContextValue {
  /**
   * 账号名下的机器(已排序：本机 → 其他在线 → 离线,组内按 label)。设备列表、「在哪跑」、侧栏、
   * 各模块的机器选择、「agent 在哪台机器上」的标签都读它。
   */
  devices: Device[]
  /**
   * Action-only phones; a phone with an available agent host belongs to `devices`.
   * 设置 → 设备列它们;
   * 在手机上,这台手机自己那一行 is_current_device。可选:没接这一格的场合就没有手机。
   */
  phones?: Device[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  rename: (deviceId: string, label: string) => Promise<void>
  /** cascade=false 时若设备有绑定 agent 会 fail-loud（DEVICE_HAS_AGENTS）；UI 先列 agent 再让用户显式勾选级联。 */
  remove: (deviceId: string, options?: { cascade?: boolean }) => Promise<void>
  listBoundAgents: (deviceId: string) => Promise<DeviceBoundAgent[]>
  /**
   * #6264 since 之后这个账号有没有哪台咕咕 server 因为机器上限没登上(远程隧道那一段就地等时顺带问)。
   * 可选:没接这一格的场合(测试、只读面板)就不问。
   */
  recentMachineLimitRefusal?: (sinceIso: string) => Promise<(MachineLimitRefusal & { hostname: string | null }) | null>
  /**
   * #7199 这个账号的云电脑(管家的 /state)。哪一行是它、它睡没睡,已经补在 `devices` 那一行的 `cloud_computer` 上;
   * 这里是设置 → 设备那一块(开通进度、出错原因)要的整份。开、醒、关的动作在 lib/cloudComputerStore。
   * 可选:没接这一格的场合(测试、只读面板)就没有云电脑这一块。
   */
  cloudComputer?: CloudComputerStoreState
}

export const DevicesContext = createContext<DevicesContextValue>({
  devices: [],
  loading: false,
  error: null,
  refresh: async () => {},
  rename: async () => {},
  remove: async () => {},
  listBoundAgents: async () => [],
  cloudComputer: { available: false, snapshot: null, loadError: null, wakeRefused: null },
})

export function useDevicesStore(): DevicesContextValue {
  return useContext(DevicesContext)
}
