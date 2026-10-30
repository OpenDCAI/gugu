import { autorun, observable, runInAction } from 'mobx'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusView } from '@gugu/core/shared/agentStatus'

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ dataClient: { schema: () => ({ rpc }) } }))

import {
  getAgentPresenceSnapshot,
  refreshObservedAgentPresenceFromRevision,
  setLocalAgentStatus,
  setPresenceBusContext,
  subscribeAgentPresence,
  type AgentPresenceState,
} from '@/lib/agentPresenceStore'
import { observedAgentPresence } from '@/lib/agentPresenceMobx'
import { taskStatusPresentation } from '@/lib/taskAgentStatus'
import { sessionPresentation } from '@/mobile/agent-watch/watch-status'
import { sidebarStateGroup } from '@/session/renderer/features/sidebar/session-groups'
import type { AgentStatusPresentation } from '@gugu/core/shared/agentStatusPresentation'

let owner = 0
let revision = 0
let reading: AgentStatusView | null
let deviceStatus: 'online' | 'offline'
let archivedAt: string | null
const disposers: Array<() => void> = []

async function settle() {
  await vi.dynamicImportSettled()
}

beforeEach(() => {
  rpc.mockReset()
  reading = { status: 'working', detail: 'running' }
  deviceStatus = 'online'
  archivedAt = null
  revision = 0
  setPresenceBusContext({ currentUserId: `status-source-owner-${++owner}` })
  rpc.mockImplementation((_name: string, args: { p_agent_user_ids: string[] }) => ({
    data: { results: Object.fromEntries(args.p_agent_user_ids.map((id) => [id, {
      status: 'presence',
      presence: {
        agent_user_id: id,
        account_status: 'active',
        session_archived_at: archivedAt,
        desired_status: 'online',
        activity_status: reading?.status === 'working' ? 'running' : 'idle',
        agent_status: reading?.status ?? null,
        agent_status_detail: reading?.detail ?? null,
        device_id: 'status-source-host',
        device_status: deviceStatus,
        updated_at: new Date(Date.UTC(2026, 9, 29, 12, 0, ++revision)).toISOString(),
      },
    }])) },
    error: null,
  }))
})

afterEach(() => {
  while (disposers.length) disposers.pop()?.()
})

describe('one agent status source for React and MobX', () => {
  it('keeps sidebar sections and phone rows on the group/avatar snapshot despite link and directory contradictions', async () => {
    const linked = observable.box(false)
    const directory = observable.box<AgentStatusView>({ status: 'idle', detail: null })
    let avatar: AgentPresenceState | null = null
    let sidebar: AgentStatusPresentation | null = null
    let phone: AgentStatusPresentation | null = null
    let section: ReturnType<typeof sidebarStateGroup> = null
    disposers.push(subscribeAgentPresence('three-surfaces', (state) => { avatar = state }))
    disposers.push(autorun(() => {
      sidebar = taskStatusPresentation({ kind: 'agent', agentUserId: 'three-surfaces' })
      section = sidebarStateGroup(sidebar)
      phone = sessionPresentation({
        conversationId: 'remote-task', status: directory.get(), agentStatus: 'idle',
        agent: { userId: 'three-surfaces' }, unseen: false,
      }, linked.get())
    }))
    await settle()
    expect(sidebar).toBe(getAgentPresenceSnapshot('three-surfaces')?.presentation)
    expect(phone).toBe(getAgentPresenceSnapshot('three-surfaces')?.presentation)
    expect(avatar).toBe(getAgentPresenceSnapshot('three-surfaces'))
    expect(section).toBe('working')
    const requests = rpc.mock.calls.length
    for (const connected of [true, false, true, false]) {
      runInAction(() => { linked.set(connected); directory.set({ status: 'error', detail: null }) })
      expect(phone).toBe(sidebar)
      expect(phone).toMatchObject({ tone: 'running', animate: true })
      expect(section).toBe('working')
    }
    expect(rpc).toHaveBeenCalledTimes(requests)

    for (const [next, tone, bucket] of [
      [{ status: 'working', detail: 'parked' }, 'parked', 'working'],
      [{ status: 'needs_user', detail: 'approval' }, 'needs_user', 'needs-you'],
      [{ status: 'error', detail: null }, 'error', null],
      [{ status: 'idle', detail: null }, 'online', null],
    ] as const) {
      reading = next
      await refreshObservedAgentPresenceFromRevision([{ agent_user_id: 'three-surfaces' }])
      expect(phone).toBe(sidebar)
      expect(sidebar).toBe(getAgentPresenceSnapshot('three-surfaces')?.presentation)
      expect(avatar).toBe(getAgentPresenceSnapshot('three-surfaces'))
      expect(phone).toMatchObject({ tone })
      expect(section).toBe(bucket)
    }
    reading = { status: 'working', detail: 'running' }
    deviceStatus = 'offline'
    await refreshObservedAgentPresenceFromRevision([{ agent_user_id: 'three-surfaces' }])
    expect(phone).toBe(sidebar)
    expect(phone).toMatchObject({ tone: 'offline', animate: false })
    expect(section).toBeNull()
  })

  it('returns the canonical snapshot and follows the same host and reachability transitions', async () => {
    let reactSnapshot: AgentPresenceState | null = null
    let mobxSnapshot: AgentPresenceState | null = null
    disposers.push(subscribeAgentPresence('source-agent', (state) => { reactSnapshot = state }))
    disposers.push(autorun(() => { mobxSnapshot = observedAgentPresence('source-agent') }))
    await settle()
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(mobxSnapshot).toBe(getAgentPresenceSnapshot('source-agent'))
    expect(mobxSnapshot).toBe(reactSnapshot)
    expect(getAgentPresenceSnapshot('source-agent')?.presentation).toMatchObject({ tone: 'running', animate: true })

    for (const [nextReading, tone, animate] of [
      [{ status: 'working', detail: 'parked' }, 'parked', false],
      [{ status: 'needs_user', detail: 'approval' }, 'needs_user', false],
      [{ status: 'error', detail: null }, 'error', false],
      [{ status: 'idle', detail: null }, 'online', false],
    ] as const) {
      reading = nextReading
      await refreshObservedAgentPresenceFromRevision([{ agent_user_id: 'source-agent' }])
      expect(mobxSnapshot).toBe(getAgentPresenceSnapshot('source-agent'))
      expect(mobxSnapshot).toBe(reactSnapshot)
      expect(getAgentPresenceSnapshot('source-agent')?.presentation).toMatchObject({ tone, animate })
    }

    reading = { status: 'working', detail: 'running' }
    deviceStatus = 'offline'
    await refreshObservedAgentPresenceFromRevision([{ agent_user_id: 'source-agent' }])
    expect(mobxSnapshot).toBe(reactSnapshot)
    expect(getAgentPresenceSnapshot('source-agent')?.presentation).toMatchObject({ tone: 'offline', animate: false })

    deviceStatus = 'online'
    archivedAt = '2026-10-29T12:01:00Z'
    await refreshObservedAgentPresenceFromRevision([{ agent_user_id: 'source-agent' }])
    expect(mobxSnapshot).toBe(reactSnapshot)
    expect(getAgentPresenceSnapshot('source-agent')?.presentation.tone).toBe('archived')
    archivedAt = null
    await refreshObservedAgentPresenceFromRevision([{ agent_user_id: 'source-agent' }])
    expect(mobxSnapshot).toBe(reactSnapshot)
    expect(getAgentPresenceSnapshot('source-agent')?.presentation).toMatchObject({ tone: 'running', animate: true })
  })

  it('uses the local host overlay for every subscriber even when the cloud mirror differs', async () => {
    reading = { status: 'idle', detail: null }
    let snapshot: AgentPresenceState | null = null
    disposers.push(autorun(() => { snapshot = observedAgentPresence('local-source-agent') }))
    await settle()
    setLocalAgentStatus('local-source-agent', {
      sessionId: 'local-task', reading: { status: 'working', detail: 'running', running: true, background: null },
      unseen: false, reviewGate: null, providerBlocker: null, statusSourceFault: null,
    })
    expect(snapshot).toBe(getAgentPresenceSnapshot('local-source-agent'))
    expect(getAgentPresenceSnapshot('local-source-agent')?.presentation).toMatchObject({ tone: 'running', animate: true })
    await refreshObservedAgentPresenceFromRevision([{ agent_user_id: 'local-source-agent' }])
    // The store intentionally skips notifications for an unchanged projection.
    // Updating the same cloud mirror must not add another status source or render.
    expect(snapshot).toMatchObject({ presentation: getAgentPresenceSnapshot('local-source-agent')?.presentation })
    expect(getAgentPresenceSnapshot('local-source-agent')?.presentation.tone).toBe('running')
  })

  it('keeps an unobserved imperative read pending without starting its own request', async () => {
    expect(observedAgentPresence('never-observed-agent').presentation).toMatchObject({ tone: 'pending', animate: false })
    await settle()
    expect(rpc).not.toHaveBeenCalled()
    expect(getAgentPresenceSnapshot('never-observed-agent')).toBeNull()
  })

  it('does not borrow an identity-free task reading when an identified agent is pending', () => {
    const anonymous = { conversationId: 'new-task', agentStatus: null, status: { status: 'working', detail: 'running' }, unseen: false } as const
    expect(sessionPresentation(anonymous, true)).toMatchObject({ tone: 'running', animate: true })
    expect(sessionPresentation(anonymous, false)).toBeNull()
    expect(sessionPresentation({ ...anonymous, agent: { userId: 'pending-identity' } }, false))
      .toMatchObject({ tone: 'pending', animate: false })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('clears the old account on every observed surface and releases its subscription', async () => {
    let displayed: AgentStatusPresentation | null = null
    const stop = autorun(() => { displayed = taskStatusPresentation({ kind: 'agent', agentUserId: 'account-bound-agent' }) })
    disposers.push(stop)
    await settle()
    expect(displayed).toMatchObject({ tone: 'running' })
    const response = rpc.getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    rpc.mockImplementationOnce(async (...args) => { await gate; return response(...args) })
    setPresenceBusContext({ currentUserId: `status-source-owner-${++owner}` })
    expect(displayed).toMatchObject({ tone: 'pending', animate: false })
    release()
    await settle()
    expect(displayed).toBe(getAgentPresenceSnapshot('account-bound-agent')?.presentation)
    stop()
    const before = rpc.mock.calls.length
    reading = { status: 'idle', detail: null }
    await refreshObservedAgentPresenceFromRevision([{ agent_user_id: 'account-bound-agent' }])
    expect(rpc).toHaveBeenCalledTimes(before)
  })
})
