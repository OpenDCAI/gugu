import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantProvisionRow } from '@/lib/assistantProvision'

const reads = vi.hoisted(() => [] as Array<{ owner: string; finish: (rows: unknown[]) => void }>)
vi.mock('@/lib/supabase', () => ({
  identityDb: {
    from: () => ({ select: () => ({ eq: () => ({
      eq: (_field: string, owner: string) => new Promise(resolve => {
        reads.push({ owner, finish: rows => resolve({ data: rows, error: null }) })
      }),
    }) }) }),
  },
}))
vi.mock('@/store/auth', () => ({ useAuth: () => ({ user: null }) }))
const { isMyAssistant, reloadMyAssistant } = await import('@/lib/myAssistant')
const row = (phase: AssistantProvisionRow['phase']): AssistantProvisionRow => ({
  agent_user_id: 'same-agent', device_id: 'same-cloud', member_key: 'assistant', phase, created_at: '2026-10-24T00:00:00Z',
})

describe('assistant identity completion refresh', () => {
  beforeEach(() => { reads.length = 0 })

  it('re-reads the completed marker even when retry kept the same contact and device', async () => {
    reloadMyAssistant('completed-owner')
    reads[0]!.finish([row('failed')])
    await vi.waitFor(() => expect(isMyAssistant('completed-owner', 'same-agent')).toBe(false))
    await Promise.resolve()
    reloadMyAssistant('completed-owner')
    reads[1]!.finish([row('completed')])
    await vi.waitFor(() => expect(isMyAssistant('completed-owner', 'same-agent')).toBe(true))
  })

  it('coalesces completion refreshes during an older read instead of dropping them', async () => {
    reloadMyAssistant('inflight-owner')
    reloadMyAssistant('inflight-owner')
    reloadMyAssistant('inflight-owner')
    expect(reads).toHaveLength(1)
    reads[0]!.finish([row('failed')])
    await vi.waitFor(() => expect(reads).toHaveLength(2))
    expect(isMyAssistant('inflight-owner', 'same-agent')).toBe(false)
    reads[1]!.finish([row('completed')])
    await vi.waitFor(() => expect(isMyAssistant('inflight-owner', 'same-agent')).toBe(true))
    expect(reads).toHaveLength(2)
  })

  it('does not create an identity from a still-failed record or another owner', async () => {
    reloadMyAssistant('failed-owner')
    reloadMyAssistant('other-owner')
    expect(reads.map(read => read.owner)).toEqual(['failed-owner', 'other-owner'])
    reads[0]!.finish([row('failed')])
    reads[1]!.finish([row('completed')])
    await vi.waitFor(() => expect(isMyAssistant('other-owner', 'same-agent')).toBe(true))
    expect(isMyAssistant('failed-owner', 'same-agent')).toBe(false)
  })
})
