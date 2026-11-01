import { beforeEach, describe, expect, it, vi } from 'vitest'

const transport = vi.hoisted(() => ({ requests: [] as { url: string; method: string; body: unknown }[], rows: [] as unknown[], status: 200 }))
vi.mock('../../../../apps/desktop/src/lib/supabase', async () => {
  const { createClient } = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { identityDb: createClient('https://fixture.invalid', 'fixture-public-key', {
    db: { schema: 'identity' },
    accessToken: async () => 'fixture-access-token',
    global: { fetch: async (input, init) => {
      transport.requests.push({ url: String(input), method: init?.method ?? 'GET', body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify(transport.status === 200 ? transport.rows : { message: 'outcome read denied', code: '42501' }), {
        status: transport.status, headers: { 'content-type': 'application/json' },
      })
    } },
  }) }
})
import { readStoredAgentTurnFailures } from '../../../../apps/desktop/src/lib/storedAgentTurnFailures'

beforeEach(() => { transport.requests = []; transport.rows = []; transport.status = 200 })

describe('stored reply outcomes use one roster-independent request', () => {
  it('keeps URL and request body fixed as the local roster grows', async () => {
    for (const count of [1, 100, 1000]) {
      await readStoredAgentTurnFailures('conversation', 'thread', Array.from({ length: count }, (_, i) => `agent-${i}`))
    }
    expect(transport.requests).toHaveLength(3)
    for (const request of transport.requests) expect(request).toEqual({
      url: 'https://fixture.invalid/rest/v1/rpc/read_agent_turn_outcomes', method: 'POST',
      body: { p_chat_id: 'conversation', p_thread_root_id: 'thread' },
    })
  })
  it('projects only the local roster, retaining failures beyond the old 50-row window', async () => {
    transport.rows = Array.from({ length: 60 }, (_, i) => ({ id: `recent-${i}`, payload: { agent_user_id: `other-${i}` }, status: 'done' }))
    transport.rows.push({ id: 'older-failure', payload: { agent_user_id: 'current' }, status: 'error', error: 'weekly limit reached', completed_at: '2026-11-01T00:00:00Z' })
    const result = await readStoredAgentTurnFailures('conversation', null, ['current', 'other-0'])
    expect(result.failures.map(row => row.commandId)).toEqual(['older-failure'])
    expect(result.recovered).toEqual(['other-0'])
    expect(transport.requests[0]!.body).toEqual({ p_chat_id: 'conversation', p_thread_root_id: null })
  })
  it('surfaces an RPC failure without falling back to a table query', async () => {
    transport.status = 403
    await expect(readStoredAgentTurnFailures('conversation', null, ['current'])).rejects.toThrow('outcome read denied')
    expect(transport.requests).toHaveLength(1)
  })
})
