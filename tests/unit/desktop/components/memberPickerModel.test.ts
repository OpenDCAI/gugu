import { describe, expect, it } from 'vitest'
import type { Device } from '../../../../packages/core/src/shared/types/chat'
import { IMPLICIT_SESSION_HOME_PROJECT_ID } from '../../../../packages/core/src/shared/sessionProject'
import { agentTasks, pickerModel, projectsOf, RECENT_WINDOW_MS } from '../../../../apps/desktop/src/components/member-picker/memberPickerModel'
import { searchContacts } from '../../../../apps/desktop/src/lib/contactSearch'
import { contact } from '../../../support/testHarness'

const NOW = Date.parse('2026-10-24T13:00:00Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const HOUR = 3_600_000
const device = (fields: Partial<Device>) => ({ status: 'online', is_online: true, ...fields }) as unknown as Device

// 本机:目录里没有它(桌面只同步别的机器),读它自己发布的摘要;别的机器在线读目录,离线读摘要。
const here = device({ device_id: 'dev-here', label: 'Chole', is_current_device: true, session_digest: [
  { conversationId: 's1', projectId: 'p1', projectName: 'gugu', title: 'Fix the input box', harness: 'claude', agentStatus: null, lastInteractedAt: iso(HOUR), supported: true, agentUserId: 'a1' },
] as never })
const linux = device({ device_id: 'dev-linux', label: 'Linux 1' })
const live = { 'dev-linux': { cached: false, loading: false, error: null, projects: [{ id: 'p2', name: 'work', path: '' }], sessions: [
  { conversationId: 's2', projectId: 'p2', title: 'Bench runner', harness: 'codex', runtime: 'acp', agentStatus: null, lastInteractedAt: iso(8 * 24 * HOUR), supported: true, agent: { userId: 'a2' } },
] } } as never

const contacts = [
  contact({ id: 'bob', display_name: 'Bob' }),
  contact({ id: 'alice', display_name: 'Alice' }),
  contact({ id: 'a1', display_name: 'Claude 7', type: 'agent', owner_user_id: 'me', device_id: 'dev-here', agent_type: 'claude-code' }),
  contact({ id: 'a2', display_name: 'Bench runner', type: 'agent', owner_user_id: 'me', device_id: 'dev-linux', agent_type: 'codex' }),
  contact({ id: 'a4', display_name: 'Claude 9', type: 'agent', owner_user_id: 'me', device_id: 'dev-here', project_path: 'C:\\work\\demo' }),
  contact({ id: 'cloud', display_name: 'Cloud', type: 'agent', owner_user_id: 'me', device_id: 'cloud:x' }),
  contact({ id: 'theirs', display_name: 'Theirs', type: 'agent', owner_user_id: 'someone' }),
]
const model = pickerModel({ contacts, currentUserId: 'me', devices: [here, linux], live, recentChats: new Map([['alice', NOW - 2 * 24 * HOUR]]), now: NOW })
const ids = (entries: { contact: { id: string } }[]) => entries.map((entry) => entry.contact.id)

describe('member picker model', () => {
  it('reads each agent’s task from the directory, and this machine from its own digest', () => {
    const tasks = agentTasks([here, linux], live)
    expect(tasks.get('a1')).toMatchObject({ title: 'Fix the input box', project: 'gugu' })
    expect(tasks.get('a2')).toMatchObject({ title: 'Bench runner', project: 'work' })
  })

  it('leaves out cloud agents and other people’s private agents', () => {
    expect(ids(model.agents).sort()).toEqual(['a1', 'a2', 'a4'])
  })

  it('has one source per device besides recent and people, each agent list newest first', () => {
    expect(model.sources.map((source) => source.kind)).toEqual(['recent', 'people', 'device', 'device'])
    expect(ids(model.sources[0].entries)).toEqual(['a1', 'alice']) // a2 is older than the window
    expect(ids(model.sources[1].entries)).toEqual(['alice', 'bob'])
    expect(ids(model.sources[2].entries)).toEqual(['a1', 'a4'])
    expect(ids(model.sources[3].entries)).toEqual(['a2'])
    expect(model.sourcesOf('a1')).toEqual(['recent', model.sources[2].key])
    expect(NOW - model.lastAt.get('a2')!).toBeGreaterThan(RECENT_WINDOW_MS)
  })

  it('keeps the task only when it says something the name does not, and falls back to the project folder', () => {
    const entry = (id: string) => model.agents.find((a) => a.contact.id === id)!
    expect(entry('a1')).toMatchObject({ task: 'Fix the input box', project: 'gugu' })
    expect(entry('a2')).toMatchObject({ task: null, project: 'work' })
    expect(entry('a4')).toMatchObject({ task: null, project: 'demo', lastAt: 0 })
    expect(projectsOf(model.sources[2].entries).map((p) => p.name).sort()).toEqual(['demo', 'gugu'])
    expect(projectsOf(model.sources[3].entries)).toEqual([])
  })

  it('finds agents by task, device and type, not only by name', () => {
    const search = (query: string) => searchContacts(query, { people: [], agents: ids(model.agents).map((id) => contacts.find((c) => c.id === id)!), groups: [], recentAt: model.lastAt, extraFields: model.searchFields })!
    expect(search('input').agents.map((hit) => [hit.item.id, hit.field])).toEqual([['a1', 'task']])
    expect(search('linux').agents.map((hit) => [hit.item.id, hit.field])).toEqual([['a2', 'device']])
    expect(search('codex').agents.map((hit) => hit.item.id)).toEqual(['a2'])
  })

  it('a task without a project shows no project, not the app’s own task-home folder or hidden project name', () => {
    const home = `${IMPLICIT_SESSION_HOME_PROJECT_ID}~dev-linux`
    const homeLive = { 'dev-linux': { cached: false, loading: false, error: null, projects: [{ id: home, name: '任务工作区', path: '' }], sessions: [
      { conversationId: 's9', projectId: home, title: 'Standalone task', harness: 'codex', runtime: 'acp', agentStatus: null, lastInteractedAt: iso(HOUR), supported: true, agent: { userId: 'a9' } },
    ] } } as never
    const homeContacts = [
      contact({ id: 'a9', display_name: 'Codex 3', type: 'agent', owner_user_id: 'me', device_id: 'dev-linux', project_path: '/root/.config/咕咕/task-home' }),
      contact({ id: 'a10', display_name: 'Claude 4', type: 'agent', owner_user_id: 'me', device_id: 'dev-here', project_path: 'C:\\Users\\me\\AppData\\Roaming\\咕咕\\task-home\\' }),
    ]
    const homeModel = pickerModel({ contacts: homeContacts, currentUserId: 'me', devices: [here, linux], live: homeLive, recentChats: new Map(), now: NOW })
    const entry = (id: string) => homeModel.agents.find((a) => a.contact.id === id)!
    expect(entry('a9')).toMatchObject({ task: 'Standalone task', project: null })
    expect(entry('a10')).toMatchObject({ project: null })
  })
})
