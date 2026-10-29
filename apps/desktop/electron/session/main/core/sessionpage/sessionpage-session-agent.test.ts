import { describe, expect, it, vi } from 'vitest'
import { countSessionAgents } from './sessionpage-session-agent'

const list = vi.hoisted(() => vi.fn())
vi.mock('@gugu/core', () => ({ listAgents: list }))

describe('project removal agent count', () => {
  it('includes parked bindings and counts identities once without inventing an identity for a task', async () => {
    list.mockResolvedValue([
      { gugu_user_id: 'active', cache: { emdash_session_id: 'task' } },
      { gugu_user_id: 'parked', cache: { sessionpage_parked_session_id: 'task' } },
      { gugu_user_id: 'active', cache: { emdash_session_id: 'task' } },
      { gugu_user_id: 'unrelated', cache: { emdash_session_id: 'other' } },
      { gugu_user_id: '', cache: { emdash_session_id: 'unbound' } },
    ])
    expect(await countSessionAgents(['task', 'unbound'], {})).toBe(2)
  })

  it('propagates an unreadable roster rather than reporting zero', async () => {
    list.mockRejectedValue(new Error('roster unavailable'))
    await expect(countSessionAgents(['task'], {})).rejects.toThrow('roster unavailable')
  })
})
