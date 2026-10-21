// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentDisplayStatus, useAgentDisplayStatuses } from '../../../../apps/desktop/src/hooks/useAgentDisplayStatus'
import { createNode, createReactHarness } from '../../../support/testHarness'
import type { AgentPresenceState } from '../../../../apps/desktop/src/lib/agentPresenceStore'
import { presentAgentStatus } from '@gugu/core/shared/agentStatusPresentation'
const mocks = vi.hoisted(() => ({
  openAgentRuntime: vi.fn(),
  wakeAgent: vi.fn(),
  subscribeAgentPresence: vi.fn(),
  getAgentPresenceSnapshot: vi.fn(),
  listeners: [] as Array<(state: AgentPresenceState) => void>,
  unsubscribes: [] as Array<() => void>,
}))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({
  chatService: {
    openAgentRuntime: mocks.openAgentRuntime,
    wakeAgent: mocks.wakeAgent,
  },
}))
vi.mock('../../../../apps/desktop/src/lib/agentPresenceStore', () => ({
  subscribeAgentPresence: mocks.subscribeAgentPresence,
  getAgentPresenceSnapshot: mocks.getAgentPresenceSnapshot,
  // #3839 「从未观测过长什么样」由 store 单点定义,hook 从那里取 —— 所以 mock 也得给出这一条,
  // ❌ 不在判据里另写一份中性态字面量(那正是被删掉的 emptyState 副本)。
  neverObservedAgentPresence: (agentUserId: string) => presenceState({
    agentUserId,
    status: 'pending',
    deviceOnline: false,
    source: 'pending',
    lastSnapshotAt: null,
  }),
}))
let harness: ReturnType<typeof createReactHarness>
function presenceState(overrides: Partial<AgentPresenceState> = {}): AgentPresenceState {
  return {
    agentUserId: 'agent-1',
    status: 'idle',
    presentation: presentAgentStatus({ reading: null, reachability: 'online' }),
    reading: null,
    local: null,
    payload: null,
    deviceOnline: true,
    error: null,
    source: 'snapshot',
    lastUpdatedAt: Date.now(),
    lastSnapshotAt: Date.now(),
    lastEventAt: null,
    ...overrides,
  }
}
beforeEach(() => {
  harness = createReactHarness()
  mocks.listeners.length = 0
  mocks.unsubscribes.length = 0
  mocks.openAgentRuntime.mockReset()
  mocks.wakeAgent.mockReset()
  mocks.subscribeAgentPresence.mockReset()
  mocks.getAgentPresenceSnapshot.mockReset()
  mocks.getAgentPresenceSnapshot.mockReturnValue(presenceState())
  mocks.subscribeAgentPresence.mockImplementation((_id: string, listener: (s: AgentPresenceState) => void) => {
    mocks.listeners.push(listener)
    const unsubscribe = vi.fn()
    mocks.unsubscribes.push(unsubscribe)
    return unsubscribe
  })
})
afterEach(() => {
  harness.cleanup()
  vi.clearAllMocks()
})
describe('useAgentDisplayStatus', () => {
  it('reads the store snapshot for the initial status', async () => {
    mocks.getAgentPresenceSnapshot.mockReturnValueOnce(presenceState({ status: 'working' }))
    await harness.render(createNode(StatusProbe, { agentUserId: 'agent-1' }))
    await flush()
    expect(statusText()).toBe('working')
  })
  it('updates when the store pushes a new state', async () => {
    await harness.render(createNode(StatusProbe, { agentUserId: 'agent-1' }))
    await flush()
    expect(statusText()).toBe('idle')
    await act(async () => {
      mocks.listeners[0]?.(presenceState({ status: 'offline', deviceOnline: false }))
      await Promise.resolve()
    })
    expect(statusText()).toBe('offline')
  })
  it('unsubscribes from the store on unmount', async () => {
    await harness.render(createNode(StatusProbe, { agentUserId: 'agent-1' }))
    await flush()
    expect(mocks.unsubscribes).toHaveLength(1)
    harness.cleanup()
    expect(mocks.unsubscribes[0]).toHaveBeenCalled()
  })
  it('does not subscribe when agentUserId is missing', async () => {
    await harness.render(createNode(StatusProbe, { agentUserId: null }))
    await flush()
    expect(mocks.subscribeAgentPresence).not.toHaveBeenCalled()
    expect(statusText()).toBe('pending')
  })
})
describe('useAgentDisplayStatuses', () => {
  it('does not publish a new map when the initial snapshot is unchanged', async () => {
    const renders: number[] = []
    function RenderCountProbe({ agentUserIds }: { agentUserIds: string[] }) {
      renders.push(1)
      const statuses = useAgentDisplayStatuses(agentUserIds)
      return createNode('output', { 'data-testid': 'status' }, JSON.stringify(statuses))
    }
    await harness.render(createNode(RenderCountProbe, { agentUserIds: ['agent-1'] }))
    await flush()
    expect(statusText()).toBe('{"agent-1":"idle"}')
    expect(renders).toHaveLength(1)
  })
  it('does not expose the single-agent idle placeholder as a resolved group status', async () => {
    mocks.getAgentPresenceSnapshot.mockReturnValue(presenceState({
      source: 'pending',
      deviceOnline: false,
      lastSnapshotAt: null,
    }))
    await harness.render(createNode(StatusesProbe, { agentUserIds: ['agent-1'] }))
    await flush()
    expect(statusText()).toBe('{}')
    await act(async () => {
      mocks.listeners[0]?.(presenceState({
        source: 'pending',
        deviceOnline: false,
        lastSnapshotAt: null,
      }))
      await Promise.resolve()
    })
    expect(statusText()).toBe('{}')
    await act(async () => {
      mocks.listeners[0]?.(presenceState({ status: 'idle' }))
      await Promise.resolve()
    })
    expect(statusText()).toBe('{"agent-1":"idle"}')
  })
})
function StatusProbe({ agentUserId }: { agentUserId: string | null }) {
  const { status } = useAgentDisplayStatus(agentUserId)
  return createNode('output', { 'data-testid': 'status' }, status)
}
function StatusesProbe({ agentUserIds }: { agentUserIds: string[] }) {
  const statuses = useAgentDisplayStatuses(agentUserIds)
  return createNode('output', { 'data-testid': 'status' }, JSON.stringify(statuses))
}
function statusText(): string {
  return harness.container.querySelector('[data-testid="status"]')?.textContent ?? ''
}
async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}
