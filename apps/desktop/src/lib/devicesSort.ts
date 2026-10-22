import type { Device } from '@gugu/core/shared/types/chat'
import { DEVICE_ONLINE_STALE_MS } from '@gugu/core/shared/enums/deviceModels'
import { isAgentHostDevice } from '@gugu/core/cloud/devices'
import { deviceAcceptsWork } from '@gugu/core/cloud/cloudComputer'

// #1749 设备列表排序（面板 + create-agent selector 共用单一事实源）：本机 → 其他在线 → 离线。
// 组内按 label 稳定排序，便于用户扫读。#7199 休眠中的云电脑排在在线那一组(休眠中 ≠ 离线)。
export function sortDevices(devices: readonly Device[]): Device[] {
  const rank = (d: Device): number => {
    if (d.is_current_device) return 0
    if (deviceAcceptsWork(d)) return 1
    return 2
  }
  return [...devices].sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    if (ra !== rb) return ra - rb
    return a.label.localeCompare(b.label)
  })
}

/**
 * 离线设备「N 天未上线」提示：帮用户认出重装换机后遗留的僵尸设备行（machine-id 变→旧行永离线）。
 * 在线设备返回 null（不显示天数）。不设硬「僵尸」阈值——只呈现天数由用户判断（设计决策）。
 */
export function deviceDaysOffline(device: Device, now = Date.now()): number | null {
  if (device.is_online) return null
  const last = new Date(device.last_seen_at).getTime()
  if (!Number.isFinite(last)) return null
  const elapsed = now - last
  // 刚过在线判定窗口不算「天」——不足一天显示 0（「今天」）。
  if (elapsed < DEVICE_ONLINE_STALE_MS) return 0
  return Math.floor(elapsed / (24 * 60 * 60 * 1000))
}

/** selector 门控：仅在线设备可选（离线可见但置灰不可选，见设计决策 Q5）；#7199 休眠中的云电脑照常可选，选了先叫醒。 */
export function isDeviceSelectable(device: Device): boolean {
  return deviceAcceptsWork(device)
}

/**
 * #7199 助理 App「能力 · 设备」的顺序:本机 → 接活的 → 离线,组内按名字。它住的那台云端宿主不在这一页
 * (owner 10-15「云电脑对用户完全不可见」,调用方先滤掉)。只给这一页用 —— 「在哪跑」等机器选择照旧 sortDevices(本机在前)。
 */
export function sortAssistantDevices(devices: readonly Device[]): Device[] {
  const rank = (d: Device): number => {
    if (d.is_current_device) return 1
    if (deviceAcceptsWork(d)) return 2
    return 3
  }
  return [...devices].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label))
}

/**
 * Action-only phones live in `phones`; a phone with a ready native host is also a run target
 * and lives in `machines`. The two collections never duplicate a device.
 */
export function partitionPhones(devices: readonly Device[], thisPhoneId: string | null): { machines: Device[]; phones: Device[] } {
  const machines: Device[] = []
  const phones: Device[] = []
  for (const device of devices) {
    const here = thisPhoneId !== null && device.device_id === thisPhoneId ? { ...device, is_current_device: true } : device
    if (isAgentHostDevice(here)) machines.push(here)
    else phones.push(here)
  }
  return { machines, phones }
}
