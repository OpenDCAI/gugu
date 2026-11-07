// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { useTaskConversation, useTaskProjectChat } from '../../../apps/desktop/src/lib/taskConversation'
import { publishDirectoryDevices, retainDeviceSessions, updateDeviceSessions } from '../../../apps/desktop/src/session/shared/remote-sessions/session-directory'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
const task = { conversationId: 'task', projectId: 'project', chatId: 'private-chat' } as SessionpageSessionSummary
const machine = (id: string, chatId: string | null): Device => ({
  device_id: id, label: id, hostname: id, platform: 'linux', status: 'online', last_seen_at: '', is_online: true, capabilities: { terminals: [], runtimes: [] },
  projects: [{ localProjectId: 'project', chatId, name: 'Project', rootPath: '/project', createdAt: '', folders: [] }],
})

function Place({ deviceId }: { deviceId?: string }) {
  const conversation = useTaskConversation('task', deviceId)
  const project = useTaskProjectChat('task', deviceId)
  return <div data-conversation={conversation} data-project={project} />
}

beforeEach(() => {
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  publishDirectoryDevices([])
  retainDeviceSessions([])
})

it('uses the owning device project binding and reacts when that binding arrives or is removed', () => {
  act(() => {
    publishDirectoryDevices([machine('owner', null), machine('another', 'wrong-group')])
    updateDeviceSessions('owner', { sessions: [task], cached: false, loading: false, error: null })
    updateDeviceSessions('another', { sessions: [], cached: false, loading: false, error: null })
    root.render(<Place />)
  })
  expect(host.firstElementChild?.getAttribute('data-project')).toBeNull()
  expect(host.firstElementChild?.getAttribute('data-conversation')).toBe('private-chat')
  act(() => publishDirectoryDevices([machine('owner', 'project-group'), machine('another', 'wrong-group')]))
  expect(host.firstElementChild?.getAttribute('data-project')).toBe('project-group')
  expect(host.firstElementChild?.getAttribute('data-conversation')).toBe('private-chat')
  act(() => publishDirectoryDevices([machine('owner', null), machine('another', 'wrong-group')]))
  expect(host.firstElementChild?.getAttribute('data-project')).toBeNull()
})

it('honors an explicit device when two directory entries report the same session id', () => {
  act(() => {
    publishDirectoryDevices([machine('first', 'first-group'), machine('second', 'second-group')])
    for (const id of ['first', 'second']) updateDeviceSessions(id, { sessions: [task], cached: false, loading: false, error: null })
    root.render(<Place deviceId="second" />)
  })
  expect(host.firstElementChild?.getAttribute('data-project')).toBe('second-group')
})
