import { describe, expect, it } from 'vitest'
import {
  AGENT_STATUS_LABELS,
  AGENT_STATUS_TONES,
  agentStatusColorVar,
  presentAgentStatus,
} from '../../../../packages/core/src/shared/agentStatusPresentation'
import {
  colorOfDisplayStatus,
  deriveAgentReachability,
  displayStatusOf,
  labelOfDisplayStatus,
  readingOfPresenceProjection,
} from '../../../../packages/core/src/shared/ui/agentConversationStatusModels'
import type { AgentStatusView } from '../../../../packages/core/src/shared/agentStatus'

const r = (status: AgentStatusView['status'], detail: AgentStatusView['detail'] = null): AgentStatusView => ({ status, detail })

// #6448 owner 2026-09-25 定的那张表:会话页、聊天、手机都调 presentAgentStatus,这里钉住表本身。
describe('presentAgentStatus — the one table', () => {
  it('running spins; parked is the same tone family, still', () => {
    expect(presentAgentStatus({ reading: r('working', 'running') })).toEqual({ tone: 'running', label: 'running', animate: true, emphasis: false })
    expect(presentAgentStatus({ reading: r('working') })).toMatchObject({ tone: 'running', animate: true })
    expect(presentAgentStatus({ reading: r('working', 'parked') })).toEqual({ tone: 'parked', label: 'parked', animate: false, emphasis: false })
  })

  it('needs you says what it waits on, and falls back to "needs your action"', () => {
    expect(presentAgentStatus({ reading: r('needs_user', 'approval') }).label).toBe('needsApproval')
    expect(presentAgentStatus({ reading: r('needs_user', 'question') }).label).toBe('needsAnswer')
    expect(presentAgentStatus({ reading: r('needs_user', 'plan') }).label).toBe('needsPlanReview')
    expect(presentAgentStatus({ reading: r('needs_user', 'dialog') }).label).toBe('needsAction')
    expect(presentAgentStatus({ reading: r('needs_user') })).toEqual({ tone: 'needs_user', label: 'needsAction', animate: false, emphasis: false })
  })

  it('done is bold only while unseen and never colored; idle reads "online" where reachability is known', () => {
    expect(presentAgentStatus({ reading: r('idle', 'done'), unseen: true })).toEqual({ tone: 'done', label: 'done', animate: false, emphasis: true })
    expect(presentAgentStatus({ reading: r('idle', 'done'), unseen: false })).toMatchObject({ tone: 'idle', label: 'idle', emphasis: false })
    expect(presentAgentStatus({ reading: r('idle', 'done'), reachability: 'online' })).toMatchObject({ tone: 'online', label: 'online' })
    expect(agentStatusColorVar('done')).toBeNull()
    expect(agentStatusColorVar('idle')).toBeNull()
  })

  it('no reading is "status unavailable" on the host, "online" in chat — never idle', () => {
    expect(presentAgentStatus({ reading: null })).toMatchObject({ tone: 'none', label: 'none' })
    expect(presentAgentStatus({ reading: null, reachability: 'online' })).toMatchObject({ tone: 'online', label: 'online' })
  })

  it('reachability outranks the reading', () => {
    for (const reachability of ['removed', 'offline', 'pending'] as const) {
      expect(presentAgentStatus({ reading: r('working', 'running'), reachability })).toMatchObject({ tone: reachability, label: reachability, animate: false })
    }
  })

  it('colors come from the --agent-tone-* tokens: orange / yellow / red', () => {
    expect(agentStatusColorVar('running')).toBe('var(--agent-tone-running)')
    expect(agentStatusColorVar('parked')).toBe('var(--agent-tone-running)')
    expect(agentStatusColorVar('needs_user')).toBe('var(--agent-tone-needs-user)')
    expect(agentStatusColorVar('error')).toBe('var(--agent-tone-error)')
  })

  it('every tone except needs_user has a same-named label (needs_user names its wait)', () => {
    for (const tone of AGENT_STATUS_TONES) {
      if (tone === 'needs_user') continue
      expect(AGENT_STATUS_LABELS as readonly string[]).toContain(tone)
    }
  })
})

describe('chat folds the presentation into its coarse status', () => {
  it('maps every tone', () => {
    expect(displayStatusOf('running')).toBe('working')
    expect(displayStatusOf('parked')).toBe('parked')
    expect(displayStatusOf('needs_user')).toBe('needs_user')
    expect(displayStatusOf('error')).toBe('error')
    for (const tone of ['done', 'idle', 'online', 'none'] as const) expect(displayStatusOf(tone)).toBe('idle')
    for (const tone of ['offline', 'removed', 'pending'] as const) expect(displayStatusOf(tone)).toBe(tone)
  })

  it('coarse label and color agree with the table', () => {
    expect(labelOfDisplayStatus('working')).toBe('running')
    expect(labelOfDisplayStatus('idle')).toBe('online')
    expect(labelOfDisplayStatus('needs_user')).toBe('needsAction')
    expect(colorOfDisplayStatus('working')).toBe('var(--agent-tone-running)')
    expect(colorOfDisplayStatus('idle')).toBe('var(--agent-tone-online)')
    expect(colorOfDisplayStatus('needs_user')).toBe('var(--agent-tone-needs-user)')
  })

  it('reachability: removed > device offline > owner intent', () => {
    // 设备可达、没有活会话仍是在线(收到消息会被宿主恢复,#6168):在不在线只看设备行与 owner 意图。
    const base = { accountStatus: 'active' as const, desiredStatus: 'online' as const, deviceOnline: true }
    expect(deriveAgentReachability(base)).toBe('online')
    expect(deriveAgentReachability({ ...base, accountStatus: 'removed' })).toBe('removed')
    expect(deriveAgentReachability({ ...base, deviceOnline: false })).toBe('offline')
    expect(deriveAgentReachability({ ...base, desiredStatus: 'offline' })).toBe('offline')
  })

  it('an old host with no reading still says "running" through its projection, and nothing else', () => {
    expect(readingOfPresenceProjection({ activityStatus: 'running' })).toEqual({ status: 'working', detail: 'running' })
    expect(readingOfPresenceProjection({ activityStatus: 'idle' })).toBeNull()
  })
})
