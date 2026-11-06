// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import type { NativeSessionRecord } from '@gugu/session-core/session-record/contract'
import { createReactHarness } from '../../support/testHarness'
import { useNativeSessionRecord } from '../../../apps/desktop/src/mobile/agent-watch/useNativeSessionRecord'
import { planHistorySync } from '../../../apps/desktop/src/components/assistant-ui/transcript-sync'

const rpc = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({
  machineRpc: () => ({ sessionTimeline: { sessionNativeRecord: rpc.read } }),
  onLinkChange: () => () => {},
}))
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { vi.useFakeTimers(); harness = createReactHarness() })
afterEach(() => { harness.cleanup(); rpc.read.mockReset(); vi.useRealTimers() })

const turn = (seq: number): TranscriptTurn => ({
  id: `poll:turn:s${seq}`, seq, initiator: 'user', outcome: { kind: 'done' },
  items: [{ kind: 'message', id: `reply:${seq}`, seq: 0, role: 'assistant', text: `Stored reply ${seq}` }],
})
function record(withNotice = false): NativeSessionRecord {
  const turns = Array.from({ length: 60 }, (_, seq) => turn(seq))
  if (withNotice) turns.push({
    ...turn(60), initiator: 'agent', items: [{
      kind: 'message', id: 'owner-notice', seq: 0, role: 'assistant', text: 'Please review',
      ownerNotification: { requestId: '11111111-1111-4111-8111-111111111111', requestHash: 'hash', sourceTurnId: turns[10]!.id },
    }],
  })
  return {
    turns, originTurnIds: turns.map(row => row.id), nextCursor: null,
    latestStoredSeq: turns.at(-1)!.seq, hasNewer: false,
    activeTurn: { id: 'active', seq: 61, initiator: 'user', items: [] },
  }
}
// Each RPC response reconstructs every object, including unchanged archive rows.
function wire(value: NativeSessionRecord, overlapOnly = false): NativeSessionRecord {
  const turns = overlapOnly ? value.turns.slice(-30) : value.turns
  return JSON.parse(JSON.stringify({ ...value, turns, originTurnIds: turns.map(row => row.id) }))
}
async function open(id: string, initial: NativeSessionRecord) {
  rpc.read.mockResolvedValueOnce({ ok: true, value: wire(initial) })
  let state!: ReturnType<typeof useNativeSessionRecord>
  function Fixture() { state = useNativeSessionRecord('polling-1961-host', id, true, true); return null }
  await harness.render(<Fixture />)
  expect(state.ready).toBe(true)
  return () => state
}
async function poll(next: NativeSessionRecord) {
  rpc.read.mockResolvedValueOnce({ ok: true, value: wire(next, true) })
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
}

it.each([false, true])('updates running output without reseeding unchanged history (owner notice=%s)', async withNotice => {
  const initial = record(withNotice)
  const state = await open(`active-${withNotice}`, initial)
  const previous = state().record!
  expect(previous.turns).toHaveLength(60)
  if (withNotice) expect(previous.turns[10]!.items.at(-1)!.id).toBe('owner-notice')
  await poll({ ...initial, activeTurn: { ...initial.activeTurn!, items: [
    { kind: 'message', id: 'running-reply', seq: 0, role: 'assistant', text: 'New running output' },
  ] } })
  expect(state().record!.activeTurn?.items).toHaveLength(1)
  expect(state().record!.turns).toEqual(previous.turns)
  expect(planHistorySync(previous.turns, state().record!.turns).op).toBe('none')
})

it('appends a newly committed turn without rebuilding the existing archive', async () => {
  const initial = record()
  const state = await open('append', initial)
  const previous = state().record!
  const committed = { ...turn(61), id: initial.activeTurn!.id }
  await poll({ ...initial, turns: [...initial.turns, committed], latestStoredSeq: 61, activeTurn: null })
  const plan = planHistorySync(previous.turns, state().record!.turns)
  expect(plan.op).toBe('append')
  if (plan.op === 'append') expect(plan.turns).toEqual([committed])
})

it('still replaces history when a stored reply actually changes', async () => {
  const initial = record()
  const state = await open('correction', initial)
  const previous = state().record!
  const corrected = { ...turn(50), items: [{ kind: 'message' as const, id: 'reply:50', seq: 0, role: 'assistant' as const, text: 'Corrected reply' }] }
  await poll({ ...initial, turns: initial.turns.map(row => row.seq === 50 ? corrected : row) })
  expect(planHistorySync(previous.turns, state().record!.turns).op).toBe('seed')
  expect(state().record!.turns[50]).toEqual(corrected)
})
