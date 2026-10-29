// #6264 远程 SSH 的机器,在添加它的这台电脑上:这台电脑与它之间走 SSH(设备连接),所以在线与否也看这条连接。
// 别的电脑与手机上它照常列出、经咕咕云使用,在线读心跳(owner 2026-10-08 选 B,product spec)。
import type { Device } from '@gugu/core/shared/types/chat'
import type { SshLinkFailure, SshLinkState } from './sshLink'

/**
 * #6264 远程 SSH 的机器在不在线,只看这台电脑到它的 SSH 设备连接(❌ 看咕咕云心跳 —— 那是另一个服务的读数)。
 *  · 要先登录 / 指纹变了 → 不在线,sshLink = signInRequired(侧栏、会话、选择器、顶上卡片同一个说法);
 *  · 那台机器上没登这个账号 → 不在线(说「登录没了」);
 *  · 太旧 / 正在替它升级 → 在线,sshLink = outdated / updating(说真实状态「版本太旧」「正在更新」,❌ 永远「重连中」);
 *  · 连不上、被拒绝、没在跑、没装 → 仍算「在线、在重连」(被拒绝的原因由顶上那张卡片照实说):会话列表那条同步照旧按自己的节奏再试,一通就好。
 * 远程隧道的机器照旧读心跳。纯函数。
 */
export function sshLinkFacts(
  isSshMachine: boolean,
  problem: SshLinkFailure | null,
  cloudOnline: boolean,
): { isOnline: boolean; sshLink?: SshLinkState | null } {
  if (!isSshMachine) return { isOnline: cloudOnline }
  if (problem === 'signInRequired' || problem === 'hostKeyChanged') return { isOnline: false, sshLink: 'signInRequired' }
  if (problem === 'notSignedIn') return { isOnline: false, sshLink: null }
  if (problem === 'outdated' || problem === 'updating') return { isOnline: true, sshLink: problem }
  if (problem === 'waitingIdle') return { isOnline: true, sshLink: 'outdated' }
  if (problem && problem !== 'unmapped') return { isOnline: true, sshLink: 'unreachable' }
  return { isOnline: true, sshLink: null }
}

/** 设备列表里远程 SSH 的那几行:在线与否换成设备连接的读数(所有读 useDevicesStore 的面同一个说法)。 */
export function withSshLinkOnline<T extends Pick<Device, 'device_id' | 'is_online'>>(
  devices: readonly T[],
  sshMachineIds: ReadonlySet<string>,
  problems: ReadonlyMap<string, SshLinkFailure>,
): T[] {
  return devices.map((device) => {
    if (!sshMachineIds.has(device.device_id)) return device
    const online = sshLinkFacts(true, problems.get(device.device_id) ?? null, device.is_online).isOnline
    return online === device.is_online ? device : { ...device, is_online: online }
  })
}
