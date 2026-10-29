import type { Device } from '@gugu/core/shared/types/chat'
import type { ContactGroupChat, ContactUser } from '@gugu/core/shared/types/contacts'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { displayName, groupContacts } from '@/lib/contactsListSort'
import { safePathSegment } from '@/session/shared/path-name'
import { groupRowOrder, type GroupLayoutProject } from '@/session/renderer/features/projects/stores/project-group-layout'

/**
 * 「伙伴」里的一个项目(OpenDCAI/gugu#446):项目记在账号上、不归哪台机器(spec「项目」)。各台机器上绑着同一个群的
 * 本地项目是同一个项目,合成一行;还没绑群的各自一行。
 */
export type PartnerProject = {
  /** 群 id;还没绑群 = `机器:本地项目`。 */
  key: string
  chatId: string | null
  name: string
  /** 最早那台建它的时间(ISO):列表按它排,位置固定。 */
  createdAt: string
  /** 封面按它取色:同电脑侧栏合并那一行代表的那个本地项目。 */
  coverId: string
  members: { deviceId: string; localProjectId: string }[]
}

export function partnerProjects(devices: readonly (Pick<Device, 'device_id' | 'projects'> & Partial<Pick<Device, 'is_online' | 'is_current_device'>>)[]): PartnerProject[] {
  const byKey = new Map<string, { key: string; chatId: string | null; rows: (GroupLayoutProject & { name: string; createdAt: string })[]; members: PartnerProject['members'] }>()
  for (const device of devices) {
    for (const project of device.projects ?? []) {
      const key = project.chatId ?? `${device.device_id}:${project.localProjectId}`
      const entry = byKey.get(key) ?? { key, chatId: project.chatId, rows: [], members: [] }
      entry.members.push({ deviceId: device.device_id, localProjectId: project.localProjectId })
      entry.rows.push({
        id: project.localProjectId, name: project.name, createdAt: project.createdAt,
        machine: device.is_current_device ? null : device.device_id, online: device.is_online === true,
      })
      byKey.set(key, entry)
    }
  }
  return [...byKey.values()]
    .map(({ key, chatId, rows, members }) => {
      // 名字与封面跟桌面侧栏合并那一行的同一个(groupRowOrder);排序按最早那台建它的时间,位置固定。
      const [row] = [...rows].sort(groupRowOrder)
      const createdAt = rows.reduce((earliest, r) => (r.createdAt < earliest ? r.createdAt : earliest), row!.createdAt)
      return { key, chatId, name: row!.name, createdAt, coverId: row!.id, members }
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key))
}

/** 朋友 = 加过的人 + 群里遇到的别人的 agent(owner 10-26「别人那 agent 就是朋友」);我自己的 agent 不是朋友。按读音排。 */
export function partnerFriends(contacts: readonly ContactUser[], sharedGroupAgents: readonly ContactUser[], myId: string | null): ContactUser[] {
  const byId = new Map<string, ContactUser>()
  for (const contact of contacts) if (contact.type !== 'agent') byId.set(contact.id, contact)
  for (const agent of sharedGroupAgents) if (agent.owner_user_id && agent.owner_user_id !== myId) byId.set(agent.id, agent)
  return groupContacts([...byId.values()]).flatMap((section) => section.items)
}

export function matchesQuery(text: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  return !q || text.toLowerCase().includes(q)
}

/** 这个项目各台机器上的会话。 */
export function projectSessions(
  project: Pick<PartnerProject, 'members'>,
  sessionsOf: (deviceId: string) => readonly SessionpageSessionSummary[],
): { deviceId: string; session: SessionpageSessionSummary }[] {
  return project.members.flatMap((member) =>
    sessionsOf(member.deviceId).filter((session) => session.projectId === member.localProjectId).map((session) => ({ deviceId: member.deviceId, session })))
}

export type ProjectAgent = {
  id: string
  /** 通讯录里还没有它(刚开出来)= null,名字用它在做的事。 */
  contact: ContactUser | null
  /** 它在这个项目里最近做的那件事。 */
  work: string | null
  /** 那件事的会话(点这一行打开它);只在群里、这个项目里还没有会话 = null。 */
  latest: { deviceId: string; session: SessionpageSessionSummary } | null
}

/** 点项目通讯录里一个 agent 去哪:它在这里有会话 ⇒ 那条会话自己的页;没有 ⇒ 项目群。 */
export type ProjectAgentTarget =
  | { kind: 'session'; deviceId: string; session: SessionpageSessionSummary }
  | { kind: 'group' }

/**
 * owner 10-28 手机试用:「在伙伴 项目里选择一个会话 居然不是会话聊天页 而是群聊页 加@」。
 * 一个 agent 一行,行上写的是它在这里最近那件事 —— 点它就进那条会话,❌ 进项目群。
 */
export function projectAgentTarget(agent: Pick<ProjectAgent, 'latest'>): ProjectAgentTarget {
  return agent.latest ? { kind: 'session', deviceId: agent.latest.deviceId, session: agent.latest.session } : { kind: 'group' }
}

/**
 * 项目通讯录「Agent」:我在这个项目里的 agent —— 项目群里我的 agent,加上这个项目的会话里有、群里还没有的。
 * 顺序固定(群里的先后,再是会话里多出来的),❌ 按状态排;副标题是它在这里最近那件事的标题,点它打开那条会话。
 */
export function projectAgents(
  group: Pick<ContactGroupChat, 'member_user_ids'> | null,
  myAgents: ReadonlyMap<string, ContactUser>,
  sessions: readonly { deviceId: string; session: SessionpageSessionSummary }[],
): ProjectAgent[] {
  const latest = new Map<string, { deviceId: string; session: SessionpageSessionSummary }>()
  for (const row of sessions) {
    const agentId = row.session.agent?.userId
    if (!agentId) continue
    const seen = latest.get(agentId)
    if (!seen || (row.session.lastInteractedAt ?? '') > (seen.session.lastInteractedAt ?? '')) latest.set(agentId, row)
  }
  const ids = [...(group?.member_user_ids ?? []).filter((id) => myAgents.has(id))]
  for (const { session } of sessions) {
    const agentId = session.agent?.userId
    if (agentId && !ids.includes(agentId)) ids.push(agentId)
  }
  return ids.map((id) => {
    const row = latest.get(id) ?? null
    return { id, contact: myAgents.get(id) ?? null, work: row?.session.title ?? null, latest: row }
  })
}

export function agentName(agent: ProjectAgent): string {
  return agent.contact ? displayName(agent.contact) : agent.work ?? agent.id
}

/** 封面的鲜灰:这个项目此刻有几个 agent 在干活。 */
export function runningCount(sessions: readonly { session: SessionpageSessionSummary }[]): number {
  return sessions.filter(({ session }) => session.status?.status === 'working').length
}

/** 新项目的文件夹:默认是那台机器默认项目目录下、跟项目同名的一个新的空文件夹。 */
export function newProjectPath(defaultDirectory: string, name: string): string {
  return `${defaultDirectory.replace(/[\\/]+$/, '')}/${name}`
}

/** 项目名就是新文件夹的名字:同电脑「新建项目」那一条(safePathSegment 原样认得它才行)。 */
export function projectNameProblem(name: string): 'empty' | 'invalid' | null {
  const trimmed = name.trim()
  if (!trimmed) return 'empty'
  return safePathSegment(trimmed, '') === trimmed ? null : 'invalid'
}
