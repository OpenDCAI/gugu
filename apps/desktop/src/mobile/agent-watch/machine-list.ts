import type { Device } from '@gugu/core/shared/types/chat'
import { isAgentHostDevice, isPhoneDevice } from '@gugu/core/cloud/devices'
import { deviceMachines } from '@gugu/core/shared/deviceMachines'

/** Phone tasks use the phone host RPC; they do not expose the desktop session workspace pipe. */
export function workspaceDevices<T extends Device>(devices: readonly T[]): T[] {
  return devices.filter((device) => !isPhoneDevice(device))
}

/**
 * 创建目标列所有能运行 Agent 的机器,按机器归并。手机能运行 Agent 不代表它支持 workspace pipe。
 * 分组与代表行选择和设置、新建任务、原生动作发现共用 core。
 * 个人助理住的那台(云端宿主)**两种模式都不列**(product spec「它住在哪」,owner 10-15:用户只知道个人助理,
 * 不需要知道它住在哪;那台不接人开的任务):它派出的任务在「助理」App 的「任务」里,不在这张机器列表上。
 */
export function visibleMachines<T extends Device>(devices: readonly T[], isHome: (device: T) => boolean): T[] {
  return deviceMachines(devices.filter((device) => isAgentHostDevice(device) && !isHome(device))).map(machine => machine.device)
}

/** 目录保留停止宿主后的手机会话;没有会话的机器不会产生项目分区。 */
export function directoryMachines<T extends Device>(devices: readonly T[], isHome: (device: T) => boolean): T[] {
  // Profiles on one physical machine own distinct sessions. Only the create-device picker chooses a representative.
  return devices.filter((device) => !isHome(device))
}
