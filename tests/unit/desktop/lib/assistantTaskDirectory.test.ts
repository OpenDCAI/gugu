import { afterEach, describe, expect, it } from 'vitest'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { device } from '../../../support/testHarness'
import { remoteWorkspaceDevices } from '../../../../apps/desktop/src/hooks/remoteWorkspaceDevices'
import { assistantTaskDirectory, assistantTaskDeviceLabel } from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-task-directory'
import { assistantTasks } from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-lineage'
import { liveDeviceSessions, removeDeviceSessions, retainDeviceSessions, subscribeDeviceSessions, updateDeviceSessions } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'

const session = (id: string, agent: string, parent: string | null = null): SessionpageSessionSummary => ({
  conversationId: id, agent: { userId: agent }, parentConversationId: parent, projectId: 'project',
  title: id, harness: 'pi', runtime: 'acp', agentStatus: 'idle', status: { status: 'idle', detail: 'done' },
  lastInteractedAt: '2026-10-26T04:25:00Z', supported: true,
})
const phone = (id: string, enabled = true) => device(id, [], { platform: 'android', capabilities: {
  host_kind: 'phone', terminals: [], runtimes: enabled ? ['pi'] : [], host_runtime_capability: enabled ? 1 : 0,
} })
function publish(id: string, sessions: SessionpageSessionSummary[]): void {
  updateDeviceSessions(id, { projects: [], sessions, cached: false, connected: true, loading: false, error: null })
}
afterEach(() => retainDeviceSessions([]))

describe('assistant task directory across execution devices', () => {
  it('includes computer, hosted-computer and phone descendants without adding phones to workspace pickers', () => {
    const devices = [device('desktop', [], { is_current_device: true }), device('hosted', []), phone('phone'), phone('stopped-phone', false), device('cloud:owner', [])]
    publish('hosted', [session('assistant-session', 'assistant'), session('hosted-task', 'hosted-agent', 'assistant-session')])
    publish('phone', [session('phone-task', 'phone-agent', 'assistant-session')])
    publish('stopped-phone', [session('old-phone-task', 'old-phone-agent', 'assistant-session')])
    const local = { loaded: true, error: null, sessions: [session('desktop-task', 'desktop-agent', 'assistant-session')] }
    const tasks = assistantTasks(assistantTaskDirectory(devices, liveDeviceSessions(), local), 'assistant', 'assistant-dm')
    expect(tasks.map((row) => row.summary.conversationId).sort()).toEqual(['desktop-task', 'hosted-task', 'old-phone-task', 'phone-task'])
    expect(remoteWorkspaceDevices(devices).map((row) => row.device_id)).toEqual(['hosted'])
    expect(assistantTaskDeviceLabel(devices, 'desktop')).toBeNull()
    expect(assistantTaskDeviceLabel(devices, 'phone')).toBe('phone')
    expect(assistantTaskDeviceLabel(devices, 'hosted')).toBe('hosted')
  })

  it('changes only the viewing-device subtitle when the same task directory is viewed on the phone', () => {
    const desktop = device('desktop', [], { label: 'My computer' })
    const currentPhone = { ...phone('phone'), is_current_device: true, label: 'My phone' }
    const devices = [desktop, currentPhone]
    expect(assistantTaskDeviceLabel(devices, 'phone')).toBeNull()
    expect(assistantTaskDeviceLabel(devices, 'desktop')).toBe('My computer')
  })

  it('treats separate device registrations on one physical computer as different viewing devices', () => {
    const devices = [
      device('current-tier', [], { is_current_device: true, machine_id: 'same-computer' }),
      device('other-tier', [], { label: 'Other channel', machine_id: 'same-computer' }),
    ]
    expect(assistantTaskDeviceLabel(devices, 'current-tier')).toBeNull()
    expect(assistantTaskDeviceLabel(devices, 'other-tier')).toBe('Other channel')
  })

  it('takes status transitions from the phone summary and does not present an offline working snapshot as live', () => {
    const devices = [phone('phone')]
    const working = { ...session('task', 'worker'), agentStatus: 'working', status: { status: 'working', detail: 'running' } }
    publish('phone', [working])
    expect(assistantTaskDirectory(devices, liveDeviceSessions())[0]).toMatchObject({ live: true, summary: { status: { status: 'working', detail: 'running' } } })
    publish('phone', [session('task', 'worker')])
    expect(assistantTaskDirectory(devices, liveDeviceSessions())[0]).toMatchObject({ live: true, summary: { status: { status: 'idle', detail: 'done' } } })
    publish('phone', [working])
    expect(assistantTaskDirectory([{ ...devices[0]!, is_online: false }], liveDeviceSessions())[0]?.live).toBe(false)
  })

  it('immediately stops treating a disconnected working snapshot as live while the heartbeat is online', () => {
    const devices = [device('computer', [])]
    publish('computer', [{ ...session('task', 'worker'), agentStatus: 'working', status: { status: 'working', detail: 'running' } }])
    expect(assistantTaskDirectory(devices, liveDeviceSessions())[0]?.live).toBe(true)
    updateDeviceSessions('computer', { connected: false })
    expect(devices[0]!.is_online).toBe(true)
    expect(assistantTaskDirectory(devices, liveDeviceSessions())[0]?.live).toBe(false)
  })

  it('keeps equal poll results referentially stable and only notifies on actual changes', () => {
    publish('phone', [session('task', 'worker')])
    const before = liveDeviceSessions()
    let notifications = 0
    const off = subscribeDeviceSessions(() => { notifications += 1 })
    publish('phone', [session('task', 'worker')])
    expect(liveDeviceSessions()).toBe(before)
    expect(notifications).toBe(0)
    const original = session('task', 'worker')
    publish('phone', [{ ...Object.fromEntries(Object.entries(original).reverse()) } as SessionpageSessionSummary])
    expect(notifications).toBe(0)
    updateDeviceSessions('phone', { connected: false })
    expect(notifications).toBe(1)
    off()
  })

  it('keeps phone summaries when a computer connection is removed', () => {
    publish('computer', [session('computer-task', 'computer-agent')])
    publish('phone', [session('phone-task', 'phone-agent')])
    removeDeviceSessions('computer')
    expect(liveDeviceSessions().computer).toBeUndefined()
    expect(liveDeviceSessions().phone?.sessions[0]?.conversationId).toBe('phone-task')
  })

  it('uses explicit assistant chat source links consistently and excludes the assistant and unrelated tasks', () => {
    const linked = { ...session('linked', 'worker'), activitySourceLinks: ['gugu-chat://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222'] }
    const rows = [session('own', 'assistant'), linked, session('unrelated', 'other')].map((summary) => ({ summary }))
    expect(assistantTasks(rows, 'assistant', '11111111-1111-4111-8111-111111111111').map((row) => row.summary.conversationId)).toEqual(['linked'])
  })
})
