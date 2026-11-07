// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { createReactHarness } from '../../support/testHarness'
import { createNativeRecordReader } from '../../../apps/desktop/electron/session/main/core/session-timeline/native-record'
import { useNativeSessionRecord } from '../../../apps/desktop/src/mobile/agent-watch/useNativeSessionRecord'
import { projectPhonePendingInputs } from '../../../apps/desktop/src/mobile/agent-watch/phone-pending-inputs'
import { activeTurnWithInputs } from '@session-chat/state/pending-prompt'
import { splitActiveTurn } from '../../../apps/desktop/src/components/assistant-ui/transcript-sync'
import { sessionInputBaseline } from '../../../apps/desktop/src/lib/pendingSessionInput'
import type { SessionInput } from '../../../apps/desktop/src/lib/sessionInputOutbox'

const scope = vi.hoisted(() => ({ stored: vi.fn(), rpc: vi.fn() }))
vi.mock('../../../apps/desktop/electron/session/main/core/sessions/session-conversation-read', () => ({ nativeConversationUnread: () => [] }))
vi.mock('../../../apps/desktop/electron/session/main/core/sessions/owner-notification-state', () => ({ ownerNotificationEpoch: () => 0 }))
vi.mock('../../../apps/desktop/electron/session/main/core/session-timeline/native-attachment', () => ({ nativeAttachmentDataUrl: vi.fn() }))
vi.mock('../../../apps/desktop/electron/session/main/core/sessions/session-turn-store', () => ({ getStoredHistory: (...args: unknown[]) => scope.stored(...args) }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({
  machineRpc: () => ({ sessionTimeline: { sessionNativeRecord: scope.rpc } }), onLinkChange: () => () => {},
}))
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); scope.stored.mockReset(); scope.rpc.mockReset(); vi.useRealTimers() })

it.each([false, true])('retains own input while a preceding commit crosses a native page read (image=%s)', async image => {
  vi.useFakeTimers()
  const sid = `custody-race-${image}`
  const old: TranscriptTurn = { id: `${sid}:turn:s2537`, seq: 2537, initiator: 'user', outcome: { kind: 'done' }, items: [] }
  const preceding: TranscriptTurn = { id: `${sid}:turn:s2538`, seq: 2538, initiator: 'agent', outcome: { kind: 'done' }, items: [] }
  const input: SessionInput = { id: '12190000-1111-4111-8111-111111111111', accountId: 'fixture-owner', sessionId: sid, deviceId: 'fixture-host',
    text: 'Own submitted input', queued: false, createdAt: 1, ...sessionInputBaseline([old]),
    ...(image ? { files: [{ itemId: 'fixture-image', version: 1, name: 'fixture.jpg', mimeType: 'image/jpeg', sizeBytes: 5 }] } : {}) }
  const active: TranscriptTurn = { id: `${sid}:turn:2644`, seq: 2644, initiator: 'user', items: [
    { kind: 'message', id: `${sid}:turn:2644:message:native`, seq: 0, role: 'user', text: input.text, _meta: { guguClientMessageId: input.id },
      ...(image ? { attachments: [{ id: 'fixture-image', name: 'fixture.jpg', mimeType: 'image/jpeg' as const }] } : {}) },
  ] }
  let rows = [old], crossing = false
  const origins = new Map<string, string>()
  const reads: unknown[] = []
  scope.stored.mockImplementation(async ({ before, limit }: { before?: number; limit: number }) => {
    const turns = rows.filter(turn => before === undefined || turn.seq < before).slice(-limit)
    if (crossing && limit !== 1) { crossing = false; rows = [old, preceding] }
    return { turns, nextCursor: old.seq, originTurnIds: turns.map(turn => origins.get(turn.id) ?? `origin:${turn.seq}`) }
  })
  const reader = createNativeRecordReader({ readSession: () => ({ runtime: 'acp' }), activeTurn: () => active,
    withTimeline: async (_id, fn) => ({ ok: true, value: await fn({} as never) }) })
  scope.rpc.mockImplementation(async request => { reads.push(request); return reader.snapshot(request) })
  const harness = createReactHarness(); cleanups.push(() => harness.cleanup())
  let record!: ReturnType<typeof useNativeSessionRecord>
  function Fixture() { record = useNativeSessionRecord('fixture-host', sid, true, true); return null }
  await harness.render(<Fixture />)
  await act(async () => { await record.reload() })
  expect(record.ready).toBe(true)
  let pending = projectPhonePendingInputs([], [input], [], [old])
  const project = () => {
    const turns = [...(record.record?.turns ?? []), ...(record.record?.activeTurn ? [record.record.activeTurn] : [])]
    pending = projectPhonePendingInputs(pending, [], [], turns)
    const split = splitActiveTurn(turns)
    const shown = activeTurnWithInputs(split.active, pending[0] ?? null, pending.slice(1), split.settled)
    return [...split.settled, ...(shown ? [shown] : [])].flatMap(turn => turn.items).some(item => item.kind === 'message' && item._meta?.guguClientMessageId === input.id)
  }
  expect(project()).toBe(true)
  expect(pending).toEqual([]) // the displayed native identity has taken custody
  crossing = true
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  const afterCrossing = project()
  expect(record.record?.hasNewer).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(reads.at(-1)).toEqual({ conversationId: sid, after: old.seq })
  expect(record.record?.turns.map(turn => turn.seq)).toEqual([old.seq, preceding.seq])
  expect(record.record?.hasNewer).toBe(false)
  for (let second = 0; second < 16; second++) await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  console.info(JSON.stringify({ image, afterCrossing, after17Seconds: project(), activePresent: !!record.record?.activeTurn,
    hasNewer: record.record?.hasNewer, reads: reads.slice(0, 4), finalRead: reads.at(-1) }))
  expect(afterCrossing, 'native page refresh must not withdraw the already-visible user input while its round is running').toBe(true)
  expect(project(), 'polling must restore the submitted input without leaving and re-entering').toBe(true)

  // Catch up across several bounded pages, then hand custody to the committed native identity exactly once.
  const backlog: TranscriptTurn[] = Array.from({ length: 125 }, (_, index) => ({ ...preceding,
    id: `${sid}:turn:s${2539 + index}`, seq: 2539 + index }))
  const committed = { ...active, id: `${sid}:turn:s2664`, seq: 2664, outcome: { kind: 'done' as const } }
  origins.set(committed.id, active.id)
  rows = [old, preceding, ...backlog, committed]
  for (const lastSeq of [2569, 2629, 2664]) {
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(record.record?.turns.at(-1)?.seq).toBe(lastSeq)
    expect(project()).toBe(true)
  }
  expect(reads.slice(-2)).toEqual([{ conversationId: sid, after: 2569 }, { conversationId: sid, after: 2629 }])
  expect(record.record?.hasNewer).toBe(false)
  expect(record.record?.activeTurn).toBeNull()
  expect(record.record?.turns.map(turn => turn.seq)).toEqual(Array.from({ length: 128 }, (_, index) => old.seq + index))
  expect(record.record?.turns.flatMap(turn => turn.items).filter(item => item.kind === 'message' && item._meta?.guguClientMessageId === input.id)).toHaveLength(1)
})
