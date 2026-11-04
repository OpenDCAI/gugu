import { describe, expect, it, vi } from 'vitest'
import { agentsForOwner, archiveAgentRecord } from '@gugu/core/local/state/agentOwner'

describe('shared roster view', () => {
  it('a reader never fetches or retries a record excluded by the shared view', async () => {
    const { pullAgentInbox } = await import('@gugu/core/local/agent/agentInboxReader')
    const row = { gugu_user_id: 'archived', status: 'idle', cache: { sessionpage_owner_user_id: 'owner' } }
    const fetchUnread = vi.fn(async () => [])
    const deps = { accessToken: 'unused', fetchUnread, inject: vi.fn(async () => ({ verdict: 'not-now' as const })), recipientIsRegistered: (id: string) => agentsForOwner([row], 'owner').some(agent => agent.gugu_user_id === id) }
    await pullAgentInbox('archived', deps)
    expect(fetchUnread).toHaveBeenCalledOnce()
    archiveAgentRecord(row)
    expect(await pullAgentInbox('archived', deps)).toMatchObject({ pulled: 0, injected: 0, verdict: 'not-now' })
    expect(await pullAgentInbox('archived', deps)).toMatchObject({ pulled: 0, verdict: 'not-now' })
    expect(fetchUnread).toHaveBeenCalledOnce()
  })

  it('uses the same eligibility for desktop records and phone records, retaining archived bindings for history', () => {
    const desktop = { gugu_user_id: 'desktop', status: 'idle', cache: { sessionpage_owner_user_id: 'owner', emdash_session_id: 'task' } }
    const phone = { agentUserId: 'phone', ownerId: 'owner', status: 'idle', sessionId: 'phone-task' }
    const other = { ...desktop, gugu_user_id: 'other', cache: { sessionpage_owner_user_id: 'other' } }
    archiveAgentRecord(desktop); archiveAgentRecord(phone)
    expect(agentsForOwner([desktop, other], 'owner')).toEqual([])
    expect(agentsForOwner([phone], 'owner')).toEqual([])
    expect(agentsForOwner([desktop, other], 'owner', { includeArchived: true })).toEqual([desktop])
    expect(agentsForOwner([phone], 'owner', { includeArchived: true })).toEqual([phone])
    expect(desktop.cache.emdash_session_id).toBe('task')
  })
})
