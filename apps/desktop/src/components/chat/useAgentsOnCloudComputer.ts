import { useEffect, useMemo } from 'react'
import type { CloudComputerPresence } from '@gugu/core/shared/types/deviceHost'
import type { AgentStatusPresentation } from '@gugu/core/shared/agentStatusPresentation'
import type { AgentDisplayStatus, Device } from '@gugu/core/shared/types/chat'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { displayStatusOf } from '@gugu/core/shared/ui/agentConversationStatusModels'
import type { AgentCloudState } from '@/lib/agentReplyPending'
import { refreshCloudComputer } from '@/lib/cloudComputerStore'
import { useContactsStore } from '@/store/contactsContext'
import { useDevicesStore } from '@/store/devicesContext'

type ReclaimedAgents = ReadonlyMap<string, Exclude<CloudComputerPresence, 'awake'>>

// 逐行调用(通讯录两张列表、@ 候选、成员列表都一行一次,且都没有虚拟化):按两张表的引用共享派生,
// 一次更新整张列表只扫一遍 —— ❌ 每行各自 useMemo,那样 N 行 × 扫 N 个联系人。
const reclaimedCache = new WeakMap<readonly ContactUser[], WeakMap<readonly Device[], ReclaimedAgents>>()

function reclaimedAgentsOf(contacts: readonly ContactUser[], devices: readonly Device[]): ReclaimedAgents {
  let byContacts = reclaimedCache.get(contacts)
  if (!byContacts) reclaimedCache.set(contacts, (byContacts = new WeakMap()))
  const cached = byContacts.get(devices)
  if (cached) return cached
  const byDevice = new Map<string, Exclude<CloudComputerPresence, 'awake'>>()
  for (const device of devices) {
    if (device.cloud_computer === 'asleep' || device.cloud_computer === 'waking') byDevice.set(device.device_id, device.cloud_computer)
  }
  const out = new Map<string, Exclude<CloudComputerPresence, 'awake'>>()
  for (const contact of byDevice.size === 0 ? [] : contacts) {
    const presence = contact.type === 'agent' && contact.device_id ? byDevice.get(contact.device_id) : undefined
    if (presence) out.set(contact.id, presence)
  }
  byContacts.set(devices, out)
  return out
}

/**
 * #7199 自己的哪些 agent 在一台没醒着的云电脑上(agent id → 休眠中 / 正在唤醒)。它们读数是离线,但 ❌ 说「不在线」,
 * 也 ❌ 说「在休息」(owner 10-17:Agent 没有休息这回事)—— 消息照收,宿主有事自己醒。群里 @ 它时据此不出离线提示。
 */
export function useAgentsOnCloudComputer(): ReclaimedAgents {
  const { contacts } = useContactsStore()
  const { devices } = useDevicesStore()
  return reclaimedAgentsOf(contacts, devices)
}

/**
 * #7199 画状态前过的唯一一道映射(读数、可达模型、回收与计费都不动)。读数是「不在线」,可它住的是自己那台闲时收回着的
 * 云端宿主(管家说 asleep / waking、没报错):发给它的消息照收 —— 排一条 agent.deliver,管家见待领命令就叫醒宿主
 * (同 core `deviceAcceptsWork`:云电脑休眠中 ≠ 离线)。所以 ❌ 画睡团、❌ 说「不在线」,也 ❌ 说「在线」(宿主此刻
 * 确实没起来):不画状态 —— 头像是本体、不出状态字。出错时管家报 error、叫醒被拒时(管家仍说 asleep)由
 * cloudComputerStore.wakeRefused 摘掉那一行的 cloud_computer,都不再算收回着,照读数如实说;
 * 别人的 agent 住哪管家不告诉我们,照读数说。只用于画头像 / 写状态字;能不能发、提醒、在跑照旧读原读数。
 */
export function useShownAgentStatus() {
  const reclaimed = useAgentsOnCloudComputer()
  return useMemo(() => {
    const quiet = (agentUserId: string | null | undefined, status: AgentDisplayStatus | null | undefined) =>
      status === 'offline' && !!agentUserId && reclaimed.has(agentUserId)
    return {
      status: (agentUserId: string | null | undefined, status: AgentDisplayStatus | null | undefined): AgentDisplayStatus | undefined =>
        quiet(agentUserId, status) ? undefined : status ?? undefined,
      presentation: (agentUserId: string | null | undefined, presentation: AgentStatusPresentation | null | undefined): AgentStatusPresentation | null =>
        presentation && !quiet(agentUserId, displayStatusOf(presentation.tone)) ? presentation : null,
      /** 按 id 直接取读数的那一份(成员资料表):收回着的那几位缺席 = 不画。❌ 喂给缺席即「确认中」的(groupAgentDisplayStatus)。 */
      statuses: (statuses: Readonly<Record<string, AgentDisplayStatus>>): Record<string, AgentDisplayStatus> =>
        Object.fromEntries(Object.entries(statuses).filter(([agentUserId, status]) => !quiet(agentUserId, status))),
      /** 群的那一个汇总点:收回着的那几位不参与(只剩他们 = 不画点);读数原样交给汇总。 */
      members: <T extends string | { id: string }>(members: readonly T[] | undefined, statuses: Readonly<Record<string, AgentDisplayStatus>>): T[] | undefined =>
        members?.filter((member) => {
          const id = typeof member === 'string' ? member : member.id
          return !quiet(id, statuses[id])
        }),
    }
  }, [reclaimed])
}
export type ShownAgentStatus = ReturnType<typeof useShownAgentStatus>

/**
 * 打开和云电脑上的 agent 的私聊那一刻现问一次管家:两次轮询之间它可能刚睡下 / 刚被叫醒,库里那一行还没翻。
 * 别的 agent ❌ 问。
 */
export function useRefreshCloudComputerFor(agentUserId: string | null): void {
  const { contacts } = useContactsStore()
  const { cloudComputer } = useDevicesStore()
  const cloudDeviceId = cloudComputer?.snapshot?.deviceId ?? null
  const onCloud = !!agentUserId && !!cloudDeviceId && contacts.some((c) => c.id === agentUserId && c.device_id === cloudDeviceId)
  useEffect(() => {
    if (onCloud) void refreshCloudComputer().catch(() => undefined)
  }, [agentUserId, onCloud])
}

/**
 * #7199 这位 agent 住的云电脑此刻怎样(休息 / 正在醒 / 醒着,及管家说进入这一状态的时刻);不住在云电脑上 = null。
 * 读的是设备行上那一格(`useAgentsOnCloudComputer` 读的同一格),醒着的那一刻从管家的 /state 来。
 */
export function useAgentCloudState(agentUserId: string | null): AgentCloudState {
  const { contacts } = useContactsStore()
  const { devices, cloudComputer } = useDevicesStore()
  const snapshot = cloudComputer?.snapshot ?? null
  return useMemo(() => {
    if (!agentUserId) return null
    const deviceId = contacts.find((c) => c.id === agentUserId && c.type === 'agent')?.device_id
    const presence = deviceId ? devices.find((d) => d.device_id === deviceId)?.cloud_computer : undefined
    if (!presence) return null
    const since = snapshot && snapshot.deviceId === deviceId && snapshot.since ? Date.parse(snapshot.since) : NaN
    return { presence, since: Number.isFinite(since) ? since : null }
  }, [agentUserId, contacts, devices, snapshot])
}

/**
 * #7199 这位 agent 所在的那台咕咕 server(在线的才算):云浏览器小窗只问它。不是 server 上的 agent / 离线 = null。
 */
export function useAgentServerDevice(agentUserId: string | null): string | null {
  const { contacts } = useContactsStore()
  const { devices } = useDevicesStore()
  return useMemo(() => {
    if (!agentUserId) return null
    const deviceId = contacts.find((c) => c.id === agentUserId && c.type === 'agent')?.device_id
    if (!deviceId) return null
    const device = devices.find((d) => d.device_id === deviceId)
    if (!device || !device.is_online || device.is_current_device || device.capabilities?.host_kind !== 'server') return null
    return device.device_id
  }, [agentUserId, contacts, devices])
}
