import type { Device } from '@gugu/core/shared/types/chat'
import { machineKeyOf } from '@gugu/core/shared/deviceMachines'
import type { ContactGroupChat, ContactUser } from '@gugu/core/shared/types/contacts'

// #5019 通讯录按设备分段(product spec「通讯录按设备分段」):会话页会话的 agent 和群是「这台电脑上的
// 文件夹」在社交侧的投影,归属是设备不是云。三句模型:账号有号、设备是电脑、会话是文件夹。
//
// 归属只看云端事实:identity.users.device_id 是 agent 出生时一次性绑死的(不可变),渲染层随 DisplayIdentity
// 一起拿到;「我的设备」列表由设备 store 给(RLS 只回自己的设备),命中 is_current_device 的就是本机。
// 群没有设备列 —— 群的设备 = 群里我自己 agent 的设备:项目群里的成员就是这个项目的会话 agent。
//
// ❌ 未知设备回落成「本机」:那正是 #1759 消掉的误导。设备表还没加载/网页版没有本机 → 归「unknown」,
//    以通用「Agent」段呈现,等设备表到了自然分开。

export type ContactsDeviceScope = 'local' | 'device' | 'cloud' | 'unknown'

export interface ContactsDeviceSection {
  /** 'local' | 'cloud' | 'unknown' | 设备 id */
  key: string
  scope: ContactsDeviceScope
  /** 设备段的标题来源:本机/咕咕云/通用「Agent」由调用方按 scope 取文案;其他设备用设备自己的名字。 */
  deviceLabel: string | null
  /**
   * 真正显示的设备名。设备名来自主机名,**很容易重名** —— 同一个人的两台 Mac 常常都叫
   * apple-macbook-pro(真机上实测一次列出四个同名分段,没法区分)。重名时补一截设备 id;
   * 不重名就是原名,❌ 给每个设备都挂一串 id。
   */
  displayLabel: string | null
  online: boolean
  agents: ContactUser[]
  groups: ContactGroupChat[]
}

export interface ContactsDevicePartition {
  /** 设备段,按「本机 → 其他设备(设备 store 顺序) → 咕咕云 → 未知」排;主段恒在,其余空则不出现。 */
  sections: ContactsDeviceSection[]
  /** 没有任何我的 agent 的群 = 云段的群(别人的群 / 手工建的纯人群)。 */
  cloudGroups: ContactGroupChat[]
  /** 主段的 key:有本机就是 'local',没有(网页版/设备表未到)就是 'unknown'。空态 CTA 挂在主段上。 */
  primaryKey: string
}

/** A folded device section still contains contacts; empty states use all partitions. */
export function contactsAreEmpty(people: readonly ContactUser[], agents: readonly ContactUser[], groups: readonly ContactGroupChat[]): boolean {
  return people.length === 0 && agents.length === 0 && groups.length === 0
}

export const CLOUD_DEVICE_PREFIX = 'cloud:'

// #4277 段按**电脑**归并,不按设备行(三句模型「设备是电脑」)。设备 id 由(机器, 账号, tier)派生(#523),同一台
// 电脑上正式版与测试版是两条设备行、两个 device_id;没有这一步归并,通讯录会把一台 Mac 显示成两段
// (真机:「本机」+「apple-macbook-pro gugu」并列,owner 定为 bug)。machine_id 缺席的老行退回按 device_id。
function sectionKeyFor(deviceId: string | null | undefined, devices: Device[]): { key: string; scope: ContactsDeviceScope; device: Device | null } {
  if (deviceId && deviceId.startsWith(CLOUD_DEVICE_PREFIX)) return { key: 'cloud', scope: 'cloud', device: null }
  const device = deviceId ? devices.find((d) => d.device_id === deviceId) ?? null : null
  if (!device) return { key: 'unknown', scope: 'unknown', device: null }
  const current = devices.find((d) => d.is_current_device) ?? null
  if (device.is_current_device || (current && machineKeyOf(current) === machineKeyOf(device))) {
    return { key: 'local', scope: 'local', device: current ?? device }
  }
  // 同一台电脑的几条设备行共用一段;段的名字/在线态取设备 store 里排在最前的那条(store 按最近活跃排)。
  const key = machineKeyOf(device)
  return { key, scope: 'device', device: devices.find((d) => machineKeyOf(d) === key) ?? device }
}

export function partitionContactsByDevice(
  agents: ContactUser[],
  groups: ContactGroupChat[],
  devices: Device[],
  currentUserId?: string | null,
): ContactsDevicePartition {
  const hasLocalDevice = devices.some((d) => d.is_current_device)
  const primaryKey = hasLocalDevice ? 'local' : 'unknown'
  const byKey = new Map<string, ContactsDeviceSection>()
  const ensure = (deviceId: string | null | undefined): ContactsDeviceSection => {
    const { key, scope, device } = sectionKeyFor(deviceId, devices)
    let section = byKey.get(key)
    if (!section) {
      section = { key, scope, deviceLabel: device?.label ?? null, displayLabel: device?.label ?? null, online: device?.is_online ?? false, agents: [], groups: [] }
      byKey.set(key, section)
    }
    return section
  }
  // 主段恒在:空着也要有「还没有 Agent + 新建」的落点。
  const primary = ensure(primaryKey === 'local' ? devices.find((d) => d.is_current_device)?.device_id : null)

  const agentDevice = new Map<string, string | null>()
  for (const agent of agents) {
    const belongsToAnotherUser = Boolean(currentUserId && agent.owner_user_id && agent.owner_user_id !== currentUserId)
    ensure(belongsToAnotherUser ? `${CLOUD_DEVICE_PREFIX}shared` : agent.device_id).agents.push(agent)
    // Only my agents give a project group device ownership. Somebody else's Agent remains a
    // cloud contact and must not make their shared group look like it belongs to their machine.
    if (!belongsToAnotherUser) agentDevice.set(agent.id, agent.device_id ?? null)
  }

  const cloudGroups: ContactGroupChat[] = []
  for (const group of groups) {
    // 群的设备 = 群里我第一个 agent 成员的设备(项目群的 agent 同属一个项目、同一台机器)。
    const member = (group.member_user_ids ?? []).find((id) => agentDevice.has(id))
    if (member === undefined) {
      cloudGroups.push(group)
      continue
    }
    ensure(agentDevice.get(member)).groups.push(group)
  }

  const order = (section: ContactsDeviceSection): number => {
    if (section.scope === 'local') return 0
    if (section.scope === 'device') return 1 + Math.max(0, devices.findIndex((d) => machineKeyOf(d) === section.key))
    if (section.scope === 'cloud') return 1 + devices.length + 1
    return 1 + devices.length + 2
  }
  const sections = [...byKey.values()]
    .filter((section) => section === primary || section.agents.length > 0 || section.groups.length > 0)
    .sort((a, b) => order(a) - order(b))

  // 同名设备消歧:只给真重名的那几个补 id,别的保持干净的原名。
  const labelCount = new Map<string, number>()
  for (const section of sections) {
    if (section.scope !== 'device' || !section.deviceLabel) continue
    labelCount.set(section.deviceLabel, (labelCount.get(section.deviceLabel) ?? 0) + 1)
  }
  for (const section of sections) {
    if (section.scope !== 'device' || !section.deviceLabel) continue
    if ((labelCount.get(section.deviceLabel) ?? 0) > 1) section.displayLabel = `${section.deviceLabel} · ${section.key.slice(0, 6)}`
  }

  return { sections, cloudGroups, primaryKey }
}
