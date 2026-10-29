import { describe, expect, it } from 'vitest'
import { latestAgentSessionRow } from '../../../../apps/desktop/src/mobile/agent-watch/useAgentSessionRow'

// The cloud browser card reads the agent's pending browser ask from this session: with several rows for one agent it must be
// the latest one (same rule as #658), not the first in directory order.
const row = (deviceId: string, conversationId: string, agent: string, lastInteractedAt?: string) =>
  ({ deviceId, session: { conversationId, agent: { userId: agent }, ...(lastInteractedAt ? { lastInteractedAt } : {}) } }) as never

describe("an agent's session row is its latest one", () => {
  it('takes the most recently used row, whichever device lists it first', () => {
    const rows = [row('mac', 'old', 'a', '2026-10-01T00:00:00Z'), row('mac', 'x', 'b', '2026-10-05T00:00:00Z'), row('server', 'new', 'a', '2026-10-03T00:00:00Z')]
    expect(latestAgentSessionRow(rows, 'a')).toMatchObject({ deviceId: 'server', session: { conversationId: 'new' } })
  })
  it('a row with no time loses to one with a time; none for the agent is null', () => {
    expect(latestAgentSessionRow([row('mac', 'undated', 'a'), row('mac', 'dated', 'a', '2026-10-01T00:00:00Z')], 'a')).toMatchObject({ session: { conversationId: 'dated' } })
    expect(latestAgentSessionRow([row('mac', 'x', 'b', '2026-10-01T00:00:00Z')], 'a')).toBeNull()
  })
})
