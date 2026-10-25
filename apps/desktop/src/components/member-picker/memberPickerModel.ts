import type { Device } from '@gugu/core/shared/types/chat'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { getAgentTypeLabel, isAgentType, isCloudAgentMarked } from '@gugu/core/shared/enums/agentTypeModels'
import { deviceSessionsOf, type DeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import type { ContactSearchField } from '../../lib/contactSearch'
import { groupContacts } from '../../lib/contactsListSort'
import { partitionContactsByDevice, type ContactsDeviceSection } from '../contacts/contactsByDevice'

// 选成员(新建群聊与添加成员共用)的候选与来源。只读已经在手的三份:通讯录(getContacts)、跨设备任务目录、聊天列表。
// 一行的「最近」= 它那条任务最后一次交互与和它的聊天里较晚的那个。Agent 只按这一条排:不分父子、不置顶、不折叠。
// 来源 = 最近(7 天内,人和 Agent 混排)、人(首字母序)、每台设备(那台上的 Agent);人多时靠来源与搜索,❌ 一条竖列翻到底。

export const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export interface PickerEntry {
  contact: ContactUser
  /** 0 = 没打过交道。 */
  lastAt: number
  /** 任务标题与 Agent 名不同才有(名字就是任务标题的那些 Agent,❌ 重复一遍)。 */
  task: string | null
  project: string | null
}

export type PickerSource =
  | { key: 'recent'; kind: 'recent'; entries: PickerEntry[] }
  | { key: 'people'; kind: 'people'; entries: PickerEntry[] }
  | { key: string; kind: 'device'; section: ContactsDeviceSection; entries: PickerEntry[] }

export interface PickerModel {
  people: PickerEntry[]
  agents: PickerEntry[]
  sources: PickerSource[]
  lastAt: ReadonlyMap<string, number>
  /** 一行出现在哪些来源里(搜索时给左栏计数、按来源收窄)。 */
  sourcesOf: (id: string) => string[]
  searchFields: (contact: ContactUser) => [ContactSearchField, string | null][]
}

type AgentTask = { title: string; project: string | null; lastAt: number }

/**
 * 每个 Agent 在跨设备任务目录里的那条任务。桌面的目录只同步别的机器(useRemoteHostsBridge 滤掉本机),
 * 本机读它自己随心跳发布的摘要(deviceSessionsOf 没读到此刻的就是这一份)—— 同一种摘要行,最近动过的在前,有条数上限;上限外的更旧,本来就排在后面。
 */
export function agentTasks(devices: readonly Device[], live: Readonly<Record<string, DeviceSessions>>): Map<string, AgentTask> {
  const tasks = new Map<string, AgentTask>()
  for (const device of devices) {
    const { projects, sessions } = deviceSessionsOf(device, live)
    const projectName = new Map(projects.map((project) => [project.id, project.name]))
    for (const session of sessions) {
      const id = session.agent?.userId
      if (!id || tasks.has(id)) continue
      tasks.set(id, { title: session.title, project: projectName.get(session.projectId) || null, lastAt: (session.lastInteractedAt && Date.parse(session.lastInteractedAt)) || 0 })
    }
  }
  return tasks
}

const folderName = (path: string | null | undefined) => path?.split(/[\\/]/).filter(Boolean).pop() ?? null
const byRecent = (a: PickerEntry, b: PickerEntry) => b.lastAt - a.lastAt

export function pickerModel({ contacts, currentUserId, devices, live, recentChats, now, withPeople = true }: {
  contacts: ContactUser[]
  currentUserId: string | null
  devices: Device[]
  live: Readonly<Record<string, DeviceSessions>>
  recentChats: ReadonlyMap<string, number>
  now: number
  /** false = 这里不能拉人进来(项目群 / 没有邀请权限):人不进任何来源与搜索,「人」那一项由调用方说原因。 */
  withPeople?: boolean
}): PickerModel {
  const tasks = agentTasks(devices, live)
  const people: PickerEntry[] = []
  const agents: PickerEntry[] = []
  for (const contact of contacts) {
    const chatAt = recentChats.get(contact.id) ?? 0
    if (contact.type !== 'agent') {
      if (withPeople) people.push({ contact, lastAt: chatAt, task: null, project: null })
      continue
    }
    // @@@1761 云 agent 不进群;别人的 agent 只有公开的能邀请(通讯录本来只给自己的)。
    if (isCloudAgentMarked(contact) || !(contact.owner_user_id === currentUserId || contact.agent_public === true)) continue
    const task = tasks.get(contact.id)
    agents.push({
      contact,
      lastAt: Math.max(task?.lastAt ?? 0, chatAt),
      task: task && task.title !== contact.display_name ? task.title : null,
      project: task?.project ?? folderName(contact.project_path),
    })
  }
  const entryOf = new Map([...people, ...agents].map((entry) => [entry.contact.id, entry]))
  const sections = partitionContactsByDevice(agents.map((entry) => entry.contact), [], devices, currentUserId).sections.filter((section) => section.agents.length > 0)
  const sectionOf = new Map(sections.flatMap((section) => section.agents.map((agent) => [agent.id, section] as const)))
  const isRecent = (entry: PickerEntry) => entry.lastAt > now - RECENT_WINDOW_MS
  const sources: PickerSource[] = [
    { key: 'recent', kind: 'recent', entries: [...people, ...agents].filter(isRecent).sort(byRecent) },
    { key: 'people', kind: 'people', entries: groupContacts(people.map((entry) => entry.contact)).flatMap((group) => group.items.map((contact) => entryOf.get(contact.id)!)) },
    ...sections.map((section): PickerSource => ({ key: section.key, kind: 'device', section, entries: section.agents.map((agent) => entryOf.get(agent.id)!).sort(byRecent) })),
  ]
  return {
    people,
    agents,
    sources,
    lastAt: new Map([...entryOf].map(([id, entry]) => [id, entry.lastAt])),
    sourcesOf: (id) => {
      const entry = entryOf.get(id)
      if (!entry) return []
      const keys = isRecent(entry) ? ['recent'] : []
      const section = sectionOf.get(id)
      return entry.contact.type === 'agent' ? (section ? [...keys, section.key] : keys) : [...keys, 'people']
    },
    searchFields: (contact) => {
      const entry = entryOf.get(contact.id)
      if (!entry || contact.type !== 'agent') return []
      const section = sectionOf.get(contact.id)
      return [
        ['task', entry.task],
        ['project', entry.project],
        ['device', section?.displayLabel ?? null],
        ['type', isAgentType(contact.agent_type) ? getAgentTypeLabel(contact.agent_type) : null],
      ]
    },
  }
}

/** 一台设备里有不止一个项目时,项目作为这台设备里的一排筛选;一个项目就不出。 */
export function projectsOf(entries: PickerEntry[]): { name: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const entry of entries) if (entry.project) counts.set(entry.project, (counts.get(entry.project) ?? 0) + 1)
  return counts.size > 1 ? [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count) : []
}
