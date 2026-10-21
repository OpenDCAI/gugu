// 远程隧道:渲染层 ↔ 主进程的契约(主进程那一头见 electron/server/tunnel-machines.ts,整体见 core/cloud/remoteTunnel.ts)。
//
// 渲染层知道账号名下有哪些机器、哪台在线、哪台的中转通着;主进程负责真的连过去(frpc 访问端 + ssh)。
// 连通了的机器与远程 SSH 的机器同一套:设备连接、终端、浏览器、端口。

import type { Device } from '@gugu/core/shared/types/chat'
import type { RemoteHostDevice } from '../session/shared/remote-hosts'

export const TUNNEL_MACHINES_CHANNELS = {
  /** 此刻要连的那些机器(invoke,TunnelWant[]):在线、中转通着、这台电脑没有它的 SSH 映射。不在单子上的收掉。 */
  want: 'tunnel-machines:want',
  /** 现在的状态(invoke,→ TunnelState)。 */
  state: 'tunnel-machines:state',
  /** 主进程 → 渲染层:状态变了(event,TunnelState)。 */
  changed: 'tunnel-machines:changed',
} as const

export type TunnelWant = { deviceId: string; label: string }

/**
 * 连不上的原因(界面照实说):
 *  unsupported = 那台机器的咕咕 server 太旧 / 没起远程隧道;relayDown = 那台机器连不上中转;
 *  visitorFailed = 这台电脑连不上中转;sshFailed = 中转通了、SSH 进不去;local = 这台电脑缺东西;
 *  unreachable = 经咕咕云问不到它。
 */
export type TunnelProblem = 'unsupported' | 'relayDown' | 'visitorFailed' | 'sshFailed' | 'local' | 'unreachable'

export type TunnelState = { ready: string[]; problems: Record<string, TunnelProblem> }

/** 要不要经远程隧道连它:别的机器、在线、它报了中转通着、这台电脑没有它的 SSH 映射。纯函数。 */
export function wantsTunnel(
  device: Pick<Device, 'device_id' | 'is_online' | 'is_current_device' | 'capabilities'>,
  sshMachines: ReadonlySet<string>,
): boolean {
  return (
    device.is_current_device !== true &&
    device.is_online &&
    device.capabilities?.tunnel_relay === 'frp' &&
    !sshMachines.has(device.device_id)
  )
}

/**
 * 远程隧道此刻怎样(见 RemoteHostDevice.tunnel):这一端连不了(手机 / 网页)、远程 SSH 的机器、离线的、已连通的 = 缺席;
 * 那台机器没报中转通着 = off;其余 = 连不上的原因,没有原因 = 正在连。纯函数。
 */
export function tunnelFacts(
  device: Pick<Device, 'device_id' | 'is_online' | 'is_current_device' | 'capabilities'>,
  sshMachines: ReadonlySet<string>,
  tunnels: TunnelState,
  canOpen: boolean,
): Pick<RemoteHostDevice, 'tunnel'> {
  if (!canOpen || sshMachines.has(device.device_id) || !device.is_online || tunnels.ready.includes(device.device_id)) return {}
  if (!wantsTunnel(device, sshMachines)) return { tunnel: 'off' }
  return { tunnel: tunnels.problems[device.device_id] ?? 'connecting' }
}
