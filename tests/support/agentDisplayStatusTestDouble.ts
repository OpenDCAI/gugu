import { vi } from 'vitest'
import { DEFAULT_AGENT_DISPLAY_STATUS } from '@gugu/core/shared/ui/agentConversationStatusModels'
import { presentAgentStatus, type AgentStatusPresentation } from '@gugu/core/shared/agentStatusPresentation'
import type { AgentPresencePayload } from '@gugu/core/cloud/agentPresenceProtocol'
import type { AgentDisplayStatus } from '@gugu/core/shared/types/chat'

const fakePayload: AgentPresencePayload = {
  agentUserId: 'agent-test',
  accountStatus: 'active',
  desiredStatus: 'online',
  activityStatus: 'idle',
  status: null,
  runtimeKind: null,
  runtimeLabel: null,
  agentType: 'claude-code',
  recentActions: [],
  lastActionAt: null,
  windowTitle: null,
  pid: null,
  deviceId: null,
  deviceStatus: 'online',
  hostRuntimeCapability: null,
  consecutiveDeliverFailures: 0,
  updatedAt: '2026-07-20T00:00:00.000Z',
}

/** 粗分类 → 真 store 会给出的那个 presentation(替身只知道粗分类;等你一律当「需要你处理」)。 */
export function presentationOfDisplayStatus(status: AgentDisplayStatus): AgentStatusPresentation {
  switch (status) {
    case 'working':
      return presentAgentStatus({ reading: { status: 'working', detail: 'running' }, reachability: 'online' })
    case 'parked':
      return presentAgentStatus({ reading: { status: 'working', detail: 'parked' }, reachability: 'online' })
    case 'needs_user':
      return presentAgentStatus({ reading: { status: 'needs_user', detail: null }, reachability: 'online' })
    case 'error':
      return presentAgentStatus({ reading: { status: 'error', detail: null }, reachability: 'online' })
    case 'idle':
      return presentAgentStatus({ reading: null, reachability: 'online' })
    case 'offline':
    case 'archived':
    case 'removed':
    case 'pending':
      return presentAgentStatus({ reading: null, reachability: status })
    case 'starting':
      return presentAgentStatus({ reading: null, reachability: 'online', lifecycle: 'starting' })
  }
}

const fakePresence = {
  agentUserId: 'agent-test',
  status: 'idle' as const,
  presentation: presentationOfDisplayStatus('idle'),
  reading: null,
  local: null,
  payload: fakePayload,
  deviceOnline: true,
  error: null,
  source: 'snapshot' as const,
  lastUpdatedAt: 0,
  lastSnapshotAt: 0,
  lastEventAt: null,
}

const statusOverrides = new Map<string, AgentDisplayStatus>()

export function setAgentDisplayStatusOverride(agentUserId: string, status: AgentDisplayStatus) {
  statusOverrides.set(agentUserId, status)
}

export function clearAgentDisplayStatusOverrides() {
  statusOverrides.clear()
}

export function useAgentDisplayStatus(agentUserId?: string | null) {
  const status = (agentUserId && statusOverrides.get(agentUserId)) || 'idle'
  const resolvedAgentUserId = agentUserId ?? 'agent-test'
  return {
    status,
    presence: {
      ...fakePresence,
      agentUserId: resolvedAgentUserId,
      status,
      presentation: presentationOfDisplayStatus(status),
      payload: {
        ...fakePayload,
        agentUserId: resolvedAgentUserId,
        accountStatus: status === 'removed' ? 'removed' as const : 'active' as const,
      },
    },
    waking: false,
    wake: vi.fn(),
    opening: false,
    openRuntime: vi.fn(),
  }
}

export function useAgentDisplayStatuses(): Record<string, typeof DEFAULT_AGENT_DISPLAY_STATUS> {
  return Object.fromEntries(statusOverrides)
}

export function useAgentRecentActivity(): Record<string, { actions: string[]; lastActiveAt: string | null }> {
  return {}
}
