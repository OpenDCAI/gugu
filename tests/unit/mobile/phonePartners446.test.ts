import { describe, expect, it } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import type { DeviceProject } from '@gugu/core/shared/types/deviceProject'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import {
  newProjectPath,
  partnerFriends,
  partnerProjects,
  projectAgents,
  projectAgentTarget,
  projectNameProblem,
  projectSessions,
  runningCount,
} from '../../../apps/desktop/src/mobile/partners/partnersModel'

function project(localProjectId: string, name: string, createdAt: string, chatId: string | null): DeviceProject {
  return { localProjectId, name, rootPath: `/work/${name}`, createdAt, chatId, folders: [] }
}

function device(deviceId: string, projects: DeviceProject[], is_online?: boolean): Pick<Device, 'device_id' | 'projects'> & Partial<Pick<Device, 'is_online'>> {
  return { device_id: deviceId, projects, is_online }
}

function contact(id: string, fields: Partial<ContactUser> = {}): ContactUser {
  return { id, display_name: id, avatar: null, bio: null, type: 'human', ...fields }
}

function session(conversationId: string, projectId: string, fields: Partial<SessionpageSessionSummary> = {}): SessionpageSessionSummary {
  return { conversationId, projectId, title: conversationId, harness: 'claude', runtime: 'acp', agentStatus: null, lastInteractedAt: null, supported: true, ...fields }
}

// 手机「伙伴」(owner 10-26,OpenDCAI/gugu#446):项目记在账号上、不归哪台机器;朋友 = 人 + 别人的 agent。
describe('partnerProjects', () => {
  it('merges the local projects bound to one group across machines into one project', () => {
    const projects = partnerProjects([
      device('mac', [project('p-mac', 'gugu', '2026-10-02T00:00:00.000Z', 'chat-gugu')], true),
      device('server', [project('p-server', 'gugu-server', '2026-10-01T00:00:00.000Z', 'chat-gugu')], false),
    ])
    expect(projects).toHaveLength(1)
    // 名字与封面跟桌面侧栏合并那一行的同一个(groupRowOrder:连着的那台先于离线的);建的时间取最早那台。
    expect(projects[0]).toMatchObject({ key: 'chat-gugu', chatId: 'chat-gugu', name: 'gugu', coverId: 'p-mac', createdAt: '2026-10-01T00:00:00.000Z' })
    expect(projects[0].members).toEqual([{ deviceId: 'mac', localProjectId: 'p-mac' }, { deviceId: 'server', localProjectId: 'p-server' }])
  })

  it('keeps a project without a group as its own row, keyed by machine and local id', () => {
    const projects = partnerProjects([device('mac', [project('p1', 'notes', '2026-10-01T00:00:00.000Z', null)])])
    expect(projects.map((row) => row.key)).toEqual(['mac:p1'])
    expect(projects[0].chatId).toBeNull()
  })

  it('lists projects in creation order, not by activity', () => {
    const projects = partnerProjects([
      device('mac', [
        project('late', 'late', '2026-10-20T00:00:00.000Z', 'c-late'),
        project('early', 'early', '2026-09-01T00:00:00.000Z', 'c-early'),
      ]),
      device('server', [project('mid', 'mid', '2026-10-05T00:00:00.000Z', null)]),
    ])
    expect(projects.map((row) => row.name)).toEqual(['early', 'mid', 'late'])
  })

  it('takes the earliest project for name and cover when the machines are equally reachable', () => {
    const [merged] = partnerProjects([
      device('a', [project('pa', 'second', '2026-10-02T00:00:00.000Z', 'c')]),
      device('b', [project('pb', 'first', '2026-10-01T00:00:00.000Z', 'c')]),
    ])
    expect(merged).toMatchObject({ name: 'first', coverId: 'pb' })
  })
})

describe('partnerFriends', () => {
  it('is people plus other owners’ agents, never my own agents', () => {
    const me = 'me'
    const friends = partnerFriends(
      [contact('张三'), contact('my-agent', { type: 'agent', owner_user_id: me })],
      [contact('their-agent', { type: 'agent', owner_user_id: 'someone' }), contact('mine-again', { type: 'agent', owner_user_id: me })],
      me,
    )
    expect(friends.map((friend) => friend.id).sort()).toEqual(['their-agent', '张三'].sort())
  })

  it('does not list one person twice', () => {
    const friends = partnerFriends([contact('a')], [contact('a', { type: 'agent', owner_user_id: 'x' })], 'me')
    expect(friends).toHaveLength(1)
  })

  it('orders by how the name reads', () => {
    const friends = partnerFriends([contact('c', { display_name: '周' }), contact('a', { display_name: '陈' }), contact('b', { display_name: '林' })], [], 'me')
    expect(friends.map((friend) => friend.display_name)).toEqual(['陈', '林', '周'])
  })
})

describe('project address book', () => {
  const group = { member_user_ids: ['me', 'agent-b', 'someone-else', 'agent-a'] }
  const mine = new Map([['agent-a', contact('agent-a', { type: 'agent', owner_user_id: 'me' })], ['agent-b', contact('agent-b', { type: 'agent', owner_user_id: 'me' })]])

  it('lists my agents in the group in the group’s order, then agents only seen in this project’s sessions', () => {
    const sessions = [
      { deviceId: 'mac', session: session('s1', 'p', { agent: { userId: 'agent-a' }, title: 'old', lastInteractedAt: '2026-10-01T00:00:00Z' }) },
      { deviceId: 'server', session: session('s2', 'p', { agent: { userId: 'agent-a' }, title: 'fix login', lastInteractedAt: '2026-10-03T00:00:00Z' }) },
      { deviceId: 'mac', session: session('s3', 'p', { agent: { userId: 'fresh' }, title: 'brand new' }) },
    ]
    const agents = projectAgents(group, mine, sessions)
    expect(agents.map((agent) => agent.id)).toEqual(['agent-b', 'agent-a', 'fresh'])
    expect(agents.find((agent) => agent.id === 'agent-a')?.work).toBe('fix login')
    expect(agents.find((agent) => agent.id === 'fresh')?.contact).toBeNull()
    // 点 Agent 打开的就是这一条:它在这里最近那条会话,连同它在哪台机器上。
    expect(agents.find((agent) => agent.id === 'agent-a')?.latest).toMatchObject({ deviceId: 'server', session: { conversationId: 's2' } })
    expect(agents.find((agent) => agent.id === 'agent-b')?.latest).toBeNull()
  })

  // owner 10-28 手机试用:点项目里的一个会话,进的是项目群 + @,不是那条会话(与 #665 合并)。
  it('opens the agent’s latest session in this project, and the group only for an agent with no session here', () => {
    const sessions = [
      { deviceId: 'mac', session: session('s1', 'p', { agent: { userId: 'agent-a' }, title: 'old', lastInteractedAt: '2026-10-01T00:00:00Z' }) },
      { deviceId: 'phone', session: session('s2', 'p', { agent: { userId: 'agent-a' }, title: 'fix login', lastInteractedAt: '2026-10-03T00:00:00Z' }) },
    ]
    const agents = projectAgents(group, mine, sessions)
    expect(projectAgentTarget(agents.find((agent) => agent.id === 'agent-a')!)).toEqual({ kind: 'session', deviceId: 'phone', session: sessions[1]!.session })
    expect(projectAgentTarget(agents.find((agent) => agent.id === 'agent-b')!)).toEqual({ kind: 'group' })
  })

  it('gathers each machine’s sessions of this project only', () => {
    const sessions = projectSessions(
      { members: [{ deviceId: 'mac', localProjectId: 'p-mac' }, { deviceId: 'server', localProjectId: 'p-server' }] },
      (deviceId) => deviceId === 'mac'
        ? [session('a', 'p-mac', { status: { status: 'working', detail: 'running' } }), session('b', 'other')]
        : [session('c', 'p-server')],
    )
    expect(sessions.map(({ session: row }) => row.conversationId)).toEqual(['a', 'c'])
    expect(runningCount(sessions)).toBe(1)
  })

})

describe('new project', () => {
  it('makes a new empty folder named after the project in the machine’s projects directory', () => {
    expect(newProjectPath('/Users/me/Documents', '咕咕')).toBe('/Users/me/Documents/咕咕')
    expect(newProjectPath('/Users/me/Documents/', 'x')).toBe('/Users/me/Documents/x')
  })

  it('takes the same names the computer’s 新建项目 takes', () => {
    expect(projectNameProblem('  ')).toBe('empty')
    expect(projectNameProblem('a/b')).toBe('invalid')
    expect(projectNameProblem('..')).toBe('invalid')
    expect(projectNameProblem('新项目')).toBeNull()
  })
})
