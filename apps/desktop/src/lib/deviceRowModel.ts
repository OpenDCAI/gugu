import type { Device } from '@gugu/core/shared/types/chat'
import type { DeviceServerUpdate } from '@gugu/core/shared/types/deviceHost'
import { serverMachineNotices, type ServerMachineNotice } from '@gugu/core/cloud/serverMachineHealth'
import { deviceAcceptsWork } from '@gugu/core/cloud/cloudComputer'
import { isPhoneDevice } from '@gugu/core/cloud/devices'
import type { DeviceBoundAgent } from './chat'

/**
 * #6264「设置 → 设备」一行要说清的几件事,从设备行 + 这台桌面记下的 SSH 映射推出来(纯函数,可单测)。
 * 每行:名字、系统、版本 + 可更新标记、最近在线、地址(可复制)、行内「需要更新」。老宿主不报的项一律按缺席处理,❌ 补默认值冒充事实。
 */

/**
 * 这是台什么机器:本机 / 别的电脑 / 咕咕 server / 咕咕云(7 月退役的旧云设备)/ 云电脑(#7199,平台托管的一台咕咕 server)/
 * 手机(#7199 手机当设备:只被调单个动作,不是运行位置)。
 * ❌ 把云电脑归进 'cloud':那是旧咕咕云,好几处选择器会把它滤掉。
 */
export type DeviceRowKind = 'this' | 'desktop' | 'server' | 'cloud' | 'cloudComputer' | 'phone'

/**
 * 这台是怎么连着的:经 SSH(这台桌面用 SSH 装上的)/ 别的电脑用 SSH 装上的、这里经云端 / 经云端 / 就是本机。
 */
export type DeviceConnection =
  | { via: 'this' }
  | { via: 'ssh'; address: string }
  | { via: 'sshElsewhere' }
  | { via: 'cloud' }

export type DeviceRowModel = {
  kind: DeviceRowKind
  /** 系统 · 架构,例如「Ubuntu 22.04.5 LTS · arm64」;都不知道时退回平台名。 */
  system: string | null
  version: string | null
  update: DeviceServerUpdate | null
  /** #6264 这台 server 有件事要人知道(版本对不上 / 磁盘快满 / 升级被退回),按要紧程度排;别的机器为空。 */
  notices: ServerMachineNotice[]
  connection: DeviceConnection
}

/** 平台标识(node 的 process.platform 与库里几种写法)→ 给人看的系统名。 */
export const PLATFORM_NAMES: Record<string, string> = {
  darwin: 'macOS',
  mac: 'macOS',
  macos: 'macOS',
  linux: 'Linux',
  win32: 'Windows',
  windows: 'Windows',
}

/**
 * cloudComputerId:管家 /state 给的 deviceId(认云电脑只靠它)。开通中 / 出错时那一行还没有 `cloud_computer`,
 * 设备页靠这个 id 照样认出它。
 */
export function deviceKind(device: Device, cloudComputerId?: string | null): DeviceRowKind {
  if (device.is_current_device) return 'this'
  if (device.platform === 'cloud' || device.device_id.startsWith('cloud:')) return 'cloud'
  if (device.cloud_computer || (cloudComputerId && device.device_id === cloudComputerId)) return 'cloudComputer'
  if (device.capabilities.host_kind === 'server') return 'server'
  if (isPhoneDevice(device)) return 'phone'
  return 'desktop'
}

export function deviceSystem(device: Device): string | null {
  if (device.platform === 'cloud') return null
  const os = device.capabilities.os_name ?? PLATFORM_NAMES[device.platform.toLowerCase()] ?? null
  const arch = device.capabilities.arch ?? null
  if (os && arch) return `${os} · ${arch}`
  return os ?? arch
}

export function deviceRowModel(device: Device, sshAddress: string | null, cloudComputerId?: string | null): DeviceRowModel {
  const kind = deviceKind(device, cloudComputerId)
  // 云电脑里跑的就是咕咕 server:版本、升级、要人知道的事照 server 说。
  const isServer = kind === 'server' || kind === 'cloudComputer'
  return {
    kind,
    system: deviceSystem(device),
    version: kind === 'cloud' ? null : device.capabilities.app_version ?? null,
    update: isServer ? device.capabilities.server_update ?? null : null,
    notices: serverMachineNotices(device.capabilities),
    connection: kind === 'this'
      ? { via: 'this' }
      : sshAddress
        ? { via: 'ssh', address: sshAddress }
        : kind === 'server' && device.capabilities.connect_via === 'ssh'
          ? { via: 'sshElsewhere' }
          : { via: 'cloud' },
  }
}

export type DeviceFilter = 'all' | 'online' | 'offline'

/**
 * 搜索 + 在线状态过滤。搜的是人会拿来找机器的那几样:名字、主机名、系统、SSH 地址。
 * 本机永远留在结果里之外 ❌ 不做特殊照顾 —— 搜不到就是搜不到,空结果有自己的提示。
 */
export function filterDevices(
  devices: readonly Device[],
  options: { query: string; filter: DeviceFilter; sshAddress: (deviceId: string) => string | null },
): Device[] {
  const query = options.query.trim().toLowerCase()
  return devices.filter((device) => {
    // #7199 休眠中的云电脑在「在线」那一格(休眠中 ≠ 离线)。
    if (options.filter === 'online' && !deviceAcceptsWork(device)) return false
    if (options.filter === 'offline' && deviceAcceptsWork(device)) return false
    if (!query) return true
    const haystack = [
      device.label,
      device.hostname,
      deviceSystem(device) ?? '',
      options.sshAddress(device.device_id) ?? '',
    ].join('\n').toLowerCase()
    return haystack.includes(query)
  })
}

/** 列表里除了本机还有没有别的机器。没有 ⇒ 空状态说明「添加一台机器能带来什么」。 */
export function hasOtherMachines(devices: readonly Device[]): boolean {
  return devices.some((device) => !device.is_current_device)
}

/** 移除 / 卸载确认页上「这台机器上你的智能体」那一块的状态。 */
export type BoundAgentsState = {
  agents: DeviceBoundAgent[]
  loading: boolean
  cascadeChecked: boolean
}

/** 还在查、或有智能体却没勾「连同删除」⇒ 确认按钮不放行(agent 无法脱离机器存在,❌ 静默连带删)。 */
export function boundAgentsBlock(state: BoundAgentsState): boolean {
  return state.loading || (state.agents.length > 0 && !state.cascadeChecked)
}
