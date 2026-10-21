import type { ChatItem, Device } from '@gugu/core/shared/types/chat'
import { i18n } from '@/i18n'
import { agentLocationText, resolveAgentLocation } from './agentRunningStatusModels'

// Derive a type tag for a chat row — design line 597–600.
// Groups → "群聊"; agents → 真实运行设备归属(咕咕云 / 设备名 / 本机)取代无脑「本机」(#1759);
// plain DM → no tag。
// @@@1759 老语义下 agent 只能在本机、「本机」是对的;现在有咕咕云 + 跨设备,按 peer_device_id 解析真实归属。
export function chatRowTag(chat: ChatItem, identity: { type: 'human' | 'agent'; device_id: string | null } | undefined, devices: Device[]): string | null {
  if (chat.kind === 'group') return i18n.t('chatList.rowTag.group', { ns: 'messaging' })
  if (chat.kind !== 'ai' && identity?.type !== 'agent') return null
  return agentDeviceTag(identity?.device_id ?? null, devices)
}

// agent 会话行的设备归属标签。cloud 前缀 → 咕咕云;命中本机设备 → 本机;其它命中 → 设备友好名;
// 未知(设备表尚未加载/查不到)→ 不显标签(而非回落假「本机」——正是 #1759 要消除的误导)。owner 自有
// agent 的设备恒在自己设备表内,未知仅出现在设备列表加载前的瞬时态,标签随即补上。
export function agentDeviceTag(deviceId: string | null, devices: Device[]): string | null {
  return agentLocationText(resolveAgentLocation(deviceId, devices), (key) => i18n.t(key, { ns: 'messaging' }))
}
