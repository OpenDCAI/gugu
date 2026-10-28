import { describe, expect, it } from 'vitest'
import { latestSpokeAt, selectGroupRunningAgents } from '../../../../apps/desktop/src/lib/groupRunningTokenModels'

// owner 10-28: in a group's running bar the agent who spoke last in this timeline comes first.
const agents = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'idle' }]
const statuses = { a: 'working', b: 'working', c: 'working', idle: 'idle' } as const
const identities = { a: { owner_user_id: 'friend' }, b: { owner_user_id: 'me' }, c: { owner_user_id: 'me' }, idle: { owner_user_id: 'me' } }
const order = (spokeAt?: Record<string, number>) =>
  selectGroupRunningAgents({ agents, statuses: statuses as never, identities, currentUserId: 'me', spokeAt }).map((agent) => agent.id)

describe('the running bar orders by who spoke last here', () => {
  it('two running: the one that spoke later is in front, whoever joined first', () => {
    expect(order({ a: 1000, b: 2000 })).toEqual(['b', 'a', 'c'])
    expect(order({ a: 3000, b: 2000 })).toEqual(['a', 'b', 'c'])
  })
  it('one that has not spoken here comes after, own agents first among those, then member order', () => {
    expect(order({ a: 1000 })).toEqual(['a', 'b', 'c'])
    expect(order()).toEqual(['b', 'c', 'a'])
  })
  it('the latest message per sender counts; a thread is just its own timeline', () => {
    const thread = [
      { sender_user_id: 'a', created_at: '2026-10-28T05:00:00Z' },
      { sender_user_id: 'b', created_at: '2026-10-28T05:01:00Z' },
      { sender_user_id: 'a', created_at: '2026-10-28T05:02:00Z' },
      { sender_user_id: null, created_at: '2026-10-28T05:03:00Z' },
    ]
    expect(latestSpokeAt(thread)).toEqual({ a: Date.parse('2026-10-28T05:02:00Z'), b: Date.parse('2026-10-28T05:01:00Z') })
    expect(order(latestSpokeAt(thread))).toEqual(['a', 'b', 'c'])
  })
})
