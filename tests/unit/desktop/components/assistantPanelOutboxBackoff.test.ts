// @vitest-environment jsdom
import { afterAll, expect, it, vi } from 'vitest'

/**
 * Saved App changes waiting for a personal assistant that does not exist (never opened, or removed) used to retry every
 * second forever: a drain that found no assistant counted as a success, reset the backoff and scheduled the next try in 1 s.
 * Measured on beta: 590 agent_provisions reads in 10 idle minutes. Now they wait for the assistant to appear.
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
const { reloadMyAssistant } = await import('../../../../apps/desktop/src/lib/myAssistant')
afterAll(() => { vi.useRealTimers(); window.localStorage.clear() })

it('with no assistant, a waiting notice is looked up once, not every second', async () => {
  await vi.advanceTimersByTimeAsync(3 * 60_000)
  expect(db.reads).toBe(1)
  expect(db.sent).toBe(0)
  expect(window.localStorage.getItem('gugu.assistant-panel.notices.v1:owner')).toContain('device-1')
})

it('[positive control] the moment the assistant appears, the waiting notice goes out', async () => {
  db.rows = [{ agent_user_id: 'assistant-1', device_id: 'device-1', member_key: 'assistant', phase: 'ready', created_at: '2026-10-27T00:00:00Z' }]
  reloadMyAssistant('owner')
  await vi.advanceTimersByTimeAsync(10)
  expect(db.sent).toBe(1)
  expect(JSON.parse(window.localStorage.getItem('gugu.assistant-panel.notices.v1:owner') ?? '[]')).toEqual([])
})
