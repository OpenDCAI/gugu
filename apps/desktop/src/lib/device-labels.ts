// #6264 设备名字与机器上限的读数(从 chat.ts 拆出,chat.ts 有体量门禁)。
import { isIpLikeLabel } from '@gugu/core/shared/ipLikeLabel'
import {
  renameDevice as renameCoreDevice,
  recentMachineLimitRefusal as recentCoreMachineLimitRefusal,
  type DeviceRpcClient,
  type MachineLimitRefusalRpcClient,
} from '@gugu/core/cloud/devices'
import { identityDb } from './supabase'

/**
 * 本机那一行显示什么名字。@@@1749 self 快照的 label 是本机 hostname 硬编码(electron main),会盖掉用户改的名字,
 * 所以以云端行的 label 为准(rename_device 落库 + 触发器防心跳覆写)。例外:云端那一行的名字是从前拿主机名截的 IP(`192`),
 * 而本机现在叫得出名字 —— 用本机的,并把云端那行改过来(用户自己改过的名字不动)。
 */
export function resolveSelfDeviceLabel(self: { device_id: string; label: string }, cloudLabel: string | undefined): string {
  const ipLikeName = cloudLabel !== undefined && isIpLikeLabel(cloudLabel) && !isIpLikeLabel(self.label) && self.label.trim() !== ''
  if (ipLikeName) void correctIpLikeDeviceLabel(self.device_id, self.label)
  return ipLikeName ? self.label : cloudLabel ?? self.label
}

// 每个进程最多改一次:只改「从没被用户改过名」(label_customized_at 为空)、且名字长得像 IP 的那一行。
const correctedLabels = new Set<string>()
async function correctIpLikeDeviceLabel(deviceId: string, label: string): Promise<void> {
  if (correctedLabels.has(deviceId)) return
  correctedLabels.add(deviceId)
  try {
    const { data, error } = await identityDb
      .from('gugu_devices')
      .select('label, label_customized_at')
      .eq('device_id', deviceId)
      .maybeSingle()
    if (error || !data) return
    const row = data as { label: unknown; label_customized_at: unknown }
    if (row.label_customized_at || typeof row.label !== 'string' || !isIpLikeLabel(row.label)) return
    // @@@supabase-boundary narrow - rename_device RPC 走 identity schema。
    await renameCoreDevice(identityDb as unknown as DeviceRpcClient, deviceId, label)
  } catch {
    // 改不成就下次启动再试;名字照旧用本机算出来的那个显示。
    correctedLabels.delete(deviceId)
  }
}

/** 远程隧道那一段:since 之后有没有哪台 server 因为机器上限没登上。 */
export async function recentMachineLimitRefusal(sinceIso: string) {
  return await recentCoreMachineLimitRefusal(identityDb as unknown as MachineLimitRefusalRpcClient, sinceIso)
}
