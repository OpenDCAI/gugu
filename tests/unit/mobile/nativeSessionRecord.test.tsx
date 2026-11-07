// @vitest-environment jsdom
import { act } from 'react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { NativeSessionRecord } from '@gugu/session-core/session-record/contract'
import { createReactHarness } from '../../support/testHarness'
import { useNativeSessionRecord } from '../../../apps/desktop/src/mobile/agent-watch/useNativeSessionRecord'
import { writeCachedNativeRecord } from '../../../apps/desktop/src/mobile/agent-watch/timeline-cache'
const scope = vi.hoisted(() => ({ read: vi.fn(), online: true, link: (_open: boolean) => {} }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({ machineRpc: () => ({ sessionTimeline: { sessionNativeRecord: scope.read } }),
  onLinkChange: (_id: string, listener: typeof scope.link) => { scope.link = listener; return () => {} } }))
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); scope.read.mockReset(); vi.useRealTimers() })
const record = (start: number, count: number, hasNewer = false): NativeSessionRecord => ({
  latestStoredSeq: hasNewer ? start + count + 60 : start + count - 1,
  turns: Array.from({ length: count }, (_, i) => ({ id: `s:turn:s${start + i}`, seq: start + i, initiator: 'user', items: [] })),
  nextCursor: start ? start : null, originTurnIds: [], activeTurn: null, hasNewer,
})
it('discards a cancelled old poll when the transport epoch changes during backoff', async () => {
  vi.useFakeTimers()
  scope.read.mockRejectedValueOnce(new Error('Host temporarily unavailable'))
  let state!: ReturnType<typeof useNativeSessionRecord>
  function Fixture() { state = useNativeSessionRecord('cancelled-poll-host', 'cancelled-poll', true, true); return null }
  await harness.render(<Fixture />)
  expect(scope.read).toHaveBeenCalledOnce()
  expect(state.error).toBeNull()
  await act(async () => { scope.link(false); await vi.advanceTimersByTimeAsync(0) })
  expect(state.error, 'cancelling an obsolete poll is not a failure of the current connection').toBeNull()
  scope.read.mockResolvedValue({ ok: true, value: record(940, 60) })
  await act(async () => { scope.link(true) })
  expect(state.ready).toBe(true)
  expect(state.error).toBeNull()
  expect(state.record?.turns.at(-1)?.seq).toBe(999)
})
it.each([false, true])('opens the latest page in one read instead of walking from the first unread (local=%s)', async local => {
  scope.read.mockImplementation(async (input: { tail?: boolean }) => ({ ok: true, value: input.tail ? record(940, 60) : record(0, 60, true) }))
  let state!: ReturnType<typeof useNativeSessionRecord>
  function Fixture() { state = useNativeSessionRecord('entry-host', `cold-tail-${local}`, true, true, local); return null }
  await harness.render(<Fixture />)
  await vi.waitFor(() => expect(state.record?.turns.at(-1)?.seq).toBe(999))
  expect(scope.read).toHaveBeenCalledExactlyOnceWith({ conversationId: `cold-tail-${local}`, tail: true })
  expect(state.record?.hasNewer).toBe(false)
  expect(state.ready).toBe(true)
})

it('shows an old cache immediately, replaces it with the tail, then preserves upward pagination during polling', async () => {
  vi.useFakeTimers()
  writeCachedNativeRecord({ deviceId: 'cached-tail-host', sessionId: 'cached-tail' }, record(0, 60, true))
  const latest = Promise.withResolvers<{ ok: true; value: NativeSessionRecord }>()
  scope.read.mockReturnValueOnce(latest.promise)
  let state!: ReturnType<typeof useNativeSessionRecord>
  function Fixture() { state = useNativeSessionRecord('cached-tail-host', 'cached-tail', true, true); return null }
  try {
    await harness.render(<Fixture />)
    expect(state.record?.turns[0]?.seq).toBe(0)
    expect(state.ready).toBe(false)
    expect(scope.read).toHaveBeenCalledExactlyOnceWith({ conversationId: 'cached-tail', tail: true })
    await act(async () => { latest.resolve({ ok: true, value: record(940, 60) }) })
    expect(state.record?.turns.map(turn => turn.seq)).toEqual(Array.from({ length: 60 }, (_, i) => 940 + i))
    scope.read.mockResolvedValueOnce({ ok: true, value: record(880, 60, true) })
    await act(async () => { await state.loadOlder() })
    expect(scope.read).toHaveBeenLastCalledWith({ conversationId: 'cached-tail', before: 940 })
    expect(state.record?.turns).toHaveLength(120)
    scope.read.mockResolvedValueOnce({ ok: true, value: record(970, 30) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(scope.read).toHaveBeenLastCalledWith({ conversationId: 'cached-tail', after: 970 })
    expect(state.record?.turns[0]?.seq).toBe(880)
    expect(state.record?.turns.at(-1)?.seq).toBe(999)
  } finally { vi.useRealTimers() }
})

it('retries the initial tail after failure instead of falling back to first-unread paging', async () => {
  vi.useFakeTimers()
  scope.read.mockRejectedValueOnce(new Error('Host temporarily unavailable'))
  let state!: ReturnType<typeof useNativeSessionRecord>
  function Fixture() { state = useNativeSessionRecord('retry-tail-host', 'retry-tail', true, true); return null }
  try {
    await harness.render(<Fixture />)
    expect(state.ready).toBe(false)
    expect(state.error).toBeNull()
    scope.read.mockResolvedValueOnce({ ok: true, value: record(940, 60) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(scope.read.mock.calls.map(([input]) => input)).toEqual([
      { conversationId: 'retry-tail', tail: true }, { conversationId: 'retry-tail', tail: true },
    ])
    expect(state.record?.turns.at(-1)?.seq).toBe(999)
    expect(state.ready).toBe(true)
  } finally { vi.useRealTimers() }
})

it('starts each enabled target with a tail read and keeps the old target response out', async () => {
  const late = Promise.withResolvers<{ ok: true; value: NativeSessionRecord }>()
  scope.read.mockReturnValueOnce(late.promise)
  let state!: ReturnType<typeof useNativeSessionRecord>
  function Fixture({ id, enabled }: { id: string; enabled: boolean }) { state = useNativeSessionRecord('switch-tail-host', id, enabled, true); return null }
  await harness.render(<Fixture id="old-tail" enabled />)
  scope.read.mockResolvedValueOnce({ ok: true, value: record(940, 60) })
  await harness.render(<Fixture id="new-tail" enabled={false} />)
  expect(scope.read).toHaveBeenCalledTimes(1)
  await harness.render(<Fixture id="new-tail" enabled />)
  await vi.waitFor(() => expect(state.ready).toBe(true))
  expect(scope.read).toHaveBeenLastCalledWith({ conversationId: 'new-tail', tail: true })
  await act(async () => { late.resolve({ ok: true, value: record(0, 1) }) })
  expect(state.record?.turns.at(-1)?.seq).toBe(999)
})

it('does not consume a failed initial tail intent when the reader requests an older cached page', async () => {
  vi.useFakeTimers()
  writeCachedNativeRecord({ deviceId: 'older-tail-host', sessionId: 'older-tail' }, record(600, 60, true))
  scope.read.mockRejectedValue(new Error('Initial tail failed'))
  let state!: ReturnType<typeof useNativeSessionRecord>
  function Fixture() { state = useNativeSessionRecord('older-tail-host', 'older-tail', true, true); return null }
  try {
    await harness.render(<Fixture />)
    await act(async () => { await vi.advanceTimersByTimeAsync(5100) })
    scope.read.mockResolvedValueOnce({ ok: true, value: record(540, 60, true) })
    await act(async () => { await state.loadOlder() })
    expect(scope.read).toHaveBeenLastCalledWith({ conversationId: 'older-tail', before: 600 })
    expect(state.record?.turns).toHaveLength(120)
    expect(state.ready).toBe(false)
    scope.read.mockResolvedValueOnce({ ok: true, value: record(940, 60) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(scope.read).toHaveBeenLastCalledWith({ conversationId: 'older-tail', tail: true })
    expect(state.record?.turns.at(-1)?.seq).toBe(999)
    expect(state.record?.turns).toHaveLength(60)
    expect(state.ready).toBe(true)
  } finally { vi.useRealTimers() }
})

it('keeps the reconnect tail intent after its first read fails', async () => {
  vi.useFakeTimers()
  scope.read.mockResolvedValueOnce({ ok: true, value: record(0, 60, true) })
  let state!: ReturnType<typeof useNativeSessionRecord>
  function Fixture() { state = useNativeSessionRecord('reconnect-tail-host', 'reconnect-tail', true, true); return null }
  try {
    await harness.render(<Fixture />)
    await act(async () => { scope.link(false) })
    scope.read.mockRejectedValueOnce(new Error('Reconnect read failed'))
    await act(async () => { scope.link(true) })
    expect(state.ready).toBe(false)
    scope.read.mockResolvedValueOnce({ ok: true, value: record(940, 60) })
    await act(async () => { await vi.advanceTimersByTimeAsync(600) })
    expect(scope.read.mock.calls.slice(1).map(([input]) => input)).toEqual([
      { conversationId: 'reconnect-tail', tail: true }, { conversationId: 'reconnect-tail', tail: true },
    ])
    expect(state.record?.turns.at(-1)?.seq).toBe(999)
  } finally { vi.useRealTimers() }
})
it('retains the structured missing-record code after bounded retry and clears it after a successful reload', async () => {
  vi.useFakeTimers()
  scope.read.mockResolvedValue({ ok: false, error: { code: 'record_not_found', message: 'Native record missing' } })
  let state!: ReturnType<typeof useNativeSessionRecord>
  function Fixture() { state = useNativeSessionRecord('recovery-host', 'missing-s', true, true); return null }
  await harness.render(<Fixture />)
  await act(async () => { await vi.advanceTimersByTimeAsync(5100) })
  expect(state.errorCode).toBe('record_not_found')
  expect(state.error).toBe('Native record missing')
  scope.read.mockResolvedValue({ ok: true, value: record(0, 1) })
  await act(async () => { await state.reload() })
  expect(state.errorCode).toBeNull()
  expect(state.error).toBeNull()
  vi.useRealTimers()
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

it('shows its cache without authorizing release until the current connection has been read', async () => {
  scope.read.mockResolvedValueOnce({ ok: true, value: record(0, 1) })
  let state!: ReturnType<typeof useNativeSessionRecord>
  function Fixture({ online }: { online: boolean }) { state = useNativeSessionRecord('queue-ready-host', 'fresh', true, online); return null }
  await harness.render(<Fixture online />)
  await vi.waitFor(() => expect(state.ready).toBe(true))
  await harness.render(<Fixture online={false} />)
  expect(state.record?.turns).toHaveLength(1)
  expect(state.ready).toBe(false)
  const pending = Promise.withResolvers<unknown>()
  scope.read.mockReturnValueOnce(pending.promise)
  await harness.render(<Fixture online />)
  expect(state.ready).toBe(false)
  await act(async () => { pending.resolve({ ok: true, value: record(0, 1) }) })
  expect(state.ready).toBe(true)
})

it('invalidates the connection epoch and ignores an older reply while reconnecting', async () => {
  scope.read.mockResolvedValueOnce({ ok: true, value: record(0, 1) })
  let state!: ReturnType<typeof useNativeSessionRecord>
  function Fixture() { state = useNativeSessionRecord('queue-epoch-host', 'epoch', true, true); return null }
  await harness.render(<Fixture />)
  await vi.waitFor(() => expect(state.ready).toBe(true))
  const older = Promise.withResolvers<unknown>(), fresh = Promise.withResolvers<unknown>()
  scope.read.mockReturnValueOnce(older.promise)
  let oldRead!: Promise<void>
  await act(async () => { oldRead = state.reload(); await Promise.resolve() })
  await act(async () => { scope.link(false) })
  expect(state.ready).toBe(false)
  scope.read.mockReturnValueOnce(fresh.promise)
  await act(async () => { scope.link(true) })
  await act(async () => { older.resolve({ ok: true, value: record(90, 2) }); await oldRead })
  expect(state.ready).toBe(false)
  expect(state.record?.turns).toHaveLength(1)
  await act(async () => { fresh.resolve({ ok: true, value: record(0, 3) }) })
  expect(state.ready).toBe(true)
  expect(state.record?.turns).toHaveLength(3)
})

it('keeps the displayed archive but withdraws release authority after a read failure', async () => {
  scope.read.mockResolvedValueOnce({ ok: true, value: record(0, 1) })
  let state!: ReturnType<typeof useNativeSessionRecord>
  function Fixture() { state = useNativeSessionRecord('queue-read-failure-host', 'failure', true, true); return null }
  await harness.render(<Fixture />)
  await vi.waitFor(() => expect(state.ready).toBe(true))
  vi.useFakeTimers()
  scope.read.mockRejectedValue(new Error('Connection lost'))
  let cause: unknown
  let completion!: Promise<void>
  await act(async () => { completion = state.reload().catch(error => { cause = error }) })
  expect(state.ready, 'release authority is withdrawn during backoff, not only after exhaustion').toBe(false)
  expect(state.record?.turns).toHaveLength(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(5100); await completion })
  expect((cause as Error).message).toBe('Connection lost')
  expect(state.ready).toBe(false)
})
