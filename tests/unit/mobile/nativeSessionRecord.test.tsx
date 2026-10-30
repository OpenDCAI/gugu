// @vitest-environment jsdom
import { act } from 'react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { NativeSessionRecord } from '@gugu/session-core/session-record/contract'
import { createReactHarness } from '../../support/testHarness'
import { useNativeSessionRecord } from '../../../apps/desktop/src/mobile/agent-watch/useNativeSessionRecord'
const scope = vi.hoisted(() => ({ read: vi.fn(), online: true }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({ machineRpc: () => ({ sessionTimeline: { sessionNativeRecord: scope.read } }) }))
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); scope.read.mockReset() })
const record = (start: number, count: number, hasNewer = false): NativeSessionRecord => ({
  latestStoredSeq: hasNewer ? start + count + 60 : start + count - 1,
  turns: Array.from({ length: count }, (_, i) => ({ id: `s:turn:s${start + i}`, seq: start + i, initiator: 'user', items: [] })),
  nextCursor: start ? start : null, originTurnIds: [], activeTurn: null, hasNewer,
})
it('keeps archive identities while paging older and newer, and explicitly follows the tail after input', async () => {
  scope.read.mockResolvedValueOnce({ ok: true, value: record(60, 60, true) })
  let state!: ReturnType<typeof useNativeSessionRecord>
  function Fixture() { state = useNativeSessionRecord('host', 's', true, true); return null }
  await harness.render(<Fixture />)
  await vi.waitFor(() => expect(state.record?.turns[0]?.id).toBe('s:turn:s60'))
  scope.read.mockResolvedValueOnce({ ok: true, value: record(0, 60, true) })
  await act(async () => { await state.loadOlder() })
  expect(state.record?.turns).toHaveLength(120)
  expect(scope.read).toHaveBeenLastCalledWith({ conversationId: 's', before: 60 })
  scope.read.mockResolvedValueOnce({ ok: true, value: record(120, 60) })
  await act(async () => { state.loadNewer() })
  await vi.waitFor(() => expect(state.record?.turns).toHaveLength(180))
  expect(scope.read).toHaveBeenLastCalledWith({ conversationId: 's', after: 119 })
  scope.read.mockResolvedValueOnce({ ok: true, value: record(240, 60) })
  await act(async () => { state.followTail() })
  await vi.waitFor(() => expect(state.record?.turns[0]?.id).toBe('s:turn:s240'))
  expect(scope.read).toHaveBeenLastCalledWith({ conversationId: 's', tail: true })
})
it('ignores a late archive response after switching to another session', async () => {
  let finish!: (value: unknown) => void
  scope.read.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  let state!: ReturnType<typeof useNativeSessionRecord>
  function Fixture({ id }: { id: string }) { state = useNativeSessionRecord('host', id, true, true); return null }
  await harness.render(<Fixture id="s" />)
  scope.read.mockResolvedValueOnce({ ok: true, value: record(0, 1) })
  await harness.render(<Fixture id="other" />)
  await vi.waitFor(() => expect(state.record?.turns).toHaveLength(1))
  await act(async () => { finish({ ok: true, value: record(99, 4) }) })
  expect(state.record?.turns).toHaveLength(1)
})

it('removes reverted archive turns while serializing a simultaneous poll and paging request', async () => {
  vi.useFakeTimers()
  scope.read.mockResolvedValueOnce({ ok: true, value: record(0, 5) })
  let state!: ReturnType<typeof useNativeSessionRecord>
  function Fixture() { state = useNativeSessionRecord('host', 's', true, true); return null }
  try {
    await harness.render(<Fixture />)
    await act(async () => { await Promise.resolve() })
    expect(state.record?.turns).toHaveLength(5)
    let finish!: (value: unknown) => void
    scope.read.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    scope.read.mockResolvedValueOnce({ ok: true, value: record(0, 2) })
    await act(async () => { state.followTail(); finish({ ok: true, value: record(0, 2) }) })
    expect(state.record?.turns.map(turn => turn.seq)).toEqual([0, 1])
    expect(scope.read).toHaveBeenLastCalledWith({ conversationId: 's', tail: true })
  } finally { vi.useRealTimers() }
})
