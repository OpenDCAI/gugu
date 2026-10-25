import { expect, it } from 'vitest'
// @ts-expect-error -- shared phone host helper is an untyped native ESM module.
import { stopPhoneSession } from '../../../apps/mobile/runtime/phone-session-stop.mjs'

it('waits for execution to finish before reading the final cancellation receipt', async () => {
  let active = true
  let read = false
  const ended = Promise.withResolvers<void>()
  const stopping = stopPhoneSession({
    cancel: async () => ({ cancelled: true }),
    running: () => active,
    sleep: () => ended.promise,
    snapshot: () => { read = true; return { session_id: 'child', status: 'idle' } },
  })
  await Promise.resolve()
  expect(read).toBe(false)
  active = false
  ended.resolve()
  expect(await stopping).toEqual({ session_id: 'child', status: 'idle', cancelled: true, settled: true })
})

it('reports stop_pending instead of a false final receipt when the executor cannot finish', async () => {
  let time = 0
  await expect(stopPhoneSession({
    cancel: async () => ({ cancelled: true }),
    running: () => true,
    now: () => time,
    sleep: async (ms: number) => { time += ms },
    timeoutMs: 40,
    snapshot: () => { throw new Error('no final state exists yet') },
  })).rejects.toMatchObject({ code: 'stop_pending' })
})

it('returns the observed state when stopping an already idle executor', async () => {
  expect(await stopPhoneSession({
    cancel: async () => ({ cancelled: false }),
    running: () => false,
    snapshot: () => ({ session_id: 'child', status: 'idle' }),
  })).toEqual({ session_id: 'child', status: 'idle', cancelled: false, settled: true })
})
