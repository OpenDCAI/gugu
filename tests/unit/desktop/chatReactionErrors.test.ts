// @vitest-environment jsdom
import { createClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const { from } = vi.hoisted(() => ({ from: vi.fn() }))
vi.mock('../../../apps/desktop/src/lib/supabase', () => ({
  chatDb: { from, rpc: vi.fn() }, identityDb: { from: vi.fn() }, dataClient: { storage: {} },
  getCurrentAuthUserId: vi.fn(), syncSchemaClientSession: vi.fn(),
}))
const { chatService } = await import('../../../apps/desktop/src/lib/chat')
beforeEach(() => from.mockReset())

describe('reaction database failures', () => {
  it.each(['read', 'insert', 'delete'])('surfaces a rejected %s instead of resolving successfully', async (stage) => {
    const error = { message: `Reaction ${stage} denied`, code: '42501' }
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const fail = stage === 'read' || method !== 'GET'
      return new Response(JSON.stringify(fail ? error : stage === 'delete' ? [{ id: 'reaction' }] : []), {
        status: fail ? 403 : 200, headers: { 'content-type': 'application/json' },
      })
    })
    const client = createClient('http://127.0.0.1:54321', 'test-anon-key', { global: { fetch }, auth: { persistSession: false, autoRefreshToken: false } }).schema('chat')
    from.mockImplementation((table: string) => client.from(table))
    await expect(chatService.toggleReaction('message', 'user', '👍')).rejects.toMatchObject(error)
    expect(fetch).toHaveBeenCalledTimes(stage === 'read' ? 1 : 2)
  })
})
