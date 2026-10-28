// @vitest-environment jsdom
import { afterAll, expect, it, vi } from 'vitest'

/**
 * Saved App changes waiting for a personal assistant that does not exist (never opened, or removed) used to retry every
 * second forever: a drain that found no assistant counted as a success, reset the backoff and scheduled the next try in 1 s.
 * Measured on beta: 590 agent_provisions reads in 10 idle minutes. Now there is nobody to tell, so they are dropped.
 */
const db = vi.hoisted(() => ({ rows: [] as unknown[], reads: 0, sent: 0 }))
vi.mock('@/lib/supabase', () => {
  const read = () => { db.reads += 1; return { data: db.rows, error: null, status: 200 } }
  const query = () => {
    const chain = { eq: () => chain, abortSignal: async () => read(), then: (ok: (value: unknown) => unknown) => Promise.resolve(read()).then(ok) }
    return { select: () => chain }
  }
  const rpc = () => ({ abortSignal: async () => { db.sent += 1; return { data: null, error: { code: '22023', message: 'skip' }, status: 400 } } })
  return { identityDb: { from: query, rpc }, chatDb: { rpc } }
})
vi.mock('@/lib/sessionPublication', () => ({ getRendererSession: () => ({ user: { id: 'owner' } }), observeRendererSession: () => () => {} }))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) }))

vi.useFakeTimers()
window.localStorage.setItem('gugu.assistant-panel.notices.v1:owner', JSON.stringify([
  { notice: { operationId: '6f9619ff-8b86-4011-b42d-00c04fc964ff', resource: 'devices', operation: 'edited', id: 'device-1', deviceId: 'device-1' } },
]))
await import('../../../../apps/desktop/src/components/assistant/assistant-panel-cloud')
afterAll(() => { vi.useRealTimers(); window.localStorage.clear() })

it('with no assistant, a waiting notice is looked up once and dropped, not re-read every second', async () => {
  await vi.advanceTimersByTimeAsync(3 * 60_000)
  expect(db.reads).toBe(1)
  expect(db.sent).toBe(0)
  expect(JSON.parse(window.localStorage.getItem('gugu.assistant-panel.notices.v1:owner') ?? '[]')).toEqual([])
})
