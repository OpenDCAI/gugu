import { describe, expect, it } from 'vitest'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { sessionPresentation, sessionReading } from '../../../apps/desktop/src/mobile/agent-watch/watch-status'
import { diffAlerts, statusMapOf } from '../../../apps/desktop/src/mobile/agent-watch/agent-watch-alerts'

const session = (fields: Partial<SessionpageSessionSummary>): SessionpageSessionSummary => ({
  conversationId: 'conversation-1',
  projectId: 'project-1',
  title: '分析下北京经济',
  harness: 'claude',
  runtime: 'acp',
  agentStatus: null,
  lastInteractedAt: '2026-09-25T00:00:00.000Z',
  supported: true,
  ...fields,
})

// #6448 手机与会话页、聊天同一张表(presentAgentStatus);手机只多一条:机器离线时不替它说「在跑」。
describe('phone session status', () => {
  it('reads the new host reading first, the old word only when the reading is absent', () => {
    expect(sessionReading(session({ agentStatus: 'needs_approval', status: { status: 'needs_user', detail: 'question' } })))
      .toEqual({ status: 'needs_user', detail: 'question' })
    expect(sessionReading(session({ agentStatus: 'needs_approval' }))).toEqual({ status: 'needs_user', detail: null })
    expect(sessionReading(session({ agentStatus: 'working', status: null }))).toBeNull()
  })

  it('a word outside the vocabulary is "status unavailable", not idle and not a crash', () => {
    expect(sessionReading(session({ agentStatus: 'thinking-hard' }))).toBeNull()
    expect(sessionPresentation(session({ agentStatus: 'thinking-hard' }), true)).toMatchObject({ tone: 'none', label: 'none' })
  })

  it('draws the table: waiting is needs-you (yellow tone), parked rests, done is bold only while unseen', () => {
    expect(sessionPresentation(session({ status: { status: 'needs_user', detail: 'approval' } }), true))
      .toMatchObject({ tone: 'needs_user', label: 'needsApproval' })
    expect(sessionPresentation(session({ status: { status: 'working', detail: 'parked' } }), true))
      .toMatchObject({ tone: 'parked', animate: false })
    expect(sessionPresentation(session({ status: { status: 'idle', detail: 'done' }, unseen: true }), true))
      .toMatchObject({ tone: 'done', emphasis: true })
    expect(sessionPresentation(session({ status: { status: 'idle', detail: 'done' }, unseen: false }), true))
      .toMatchObject({ tone: 'idle', emphasis: false })
  })

  it('an offline machine never claims running or running-in-background; the rest survives', () => {
    expect(sessionPresentation(session({ status: { status: 'working', detail: 'running' } }), false)).toBeNull()
    expect(sessionPresentation(session({ status: { status: 'working', detail: 'parked' } }), false)).toBeNull()
    expect(sessionPresentation(session({ status: { status: 'needs_user', detail: 'approval' } }), false))
      .toMatchObject({ tone: 'needs_user' })
    expect(sessionPresentation(session({ status: { status: 'error', detail: null } }), false)).toMatchObject({ tone: 'error' })
  })
})

const offScreen = () => false

describe('phone alerts speak the same words', () => {
  it('alerts only when the agent stops to ask you, with the wait it names (owner 10-30)', () => {
    const before = statusMapOf([session({ status: { status: 'working', detail: 'running' } })])
    expect(diffAlerts(before, [session({ status: { status: 'needs_user', detail: 'question' } })], offScreen))
      .toEqual([{ sessionId: 'conversation-1', title: '分析下北京经济', label: 'needsAnswer' }])
    expect(diffAlerts(before, [session({ status: { status: 'error', detail: null } })], offScreen)).toEqual([])
    expect(diffAlerts(before, [session({ status: { status: 'idle', detail: 'done' }, unseen: true })], offScreen)).toEqual([])
  })

  it('does not alert on parked, and a new wait on the same status is a new thing', () => {
    const running = statusMapOf([session({ status: { status: 'working', detail: 'running' } })])
    expect(diffAlerts(running, [session({ status: { status: 'working', detail: 'parked' } })], offScreen)).toEqual([])
    const approval = statusMapOf([session({ status: { status: 'needs_user', detail: 'approval' } })])
    expect(diffAlerts(approval, [session({ status: { status: 'needs_user', detail: 'approval' } })], offScreen)).toEqual([])
    expect(diffAlerts(approval, [session({ status: { status: 'needs_user', detail: 'question' } })], offScreen)).toHaveLength(1)
  })

  it('stays quiet for the session on screen', () => {
    const before = statusMapOf([session({ status: { status: 'working', detail: 'running' } })])
    expect(diffAlerts(before, [session({ status: { status: 'needs_user', detail: 'approval' } })], (id) => id === 'conversation-1')).toEqual([])
  })

  it('still understands an old host that only writes the old word', () => {
    const before = statusMapOf([session({ agentStatus: 'working' })])
    expect(diffAlerts(before, [session({ agentStatus: 'needs_approval' })], offScreen)[0]).toMatchObject({ label: 'needsAction' })
  })
})
