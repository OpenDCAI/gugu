import { renumberStoredTurn } from '../../../../apps/desktop/electron/session/main/core/sessions/session-turn-identity'
import { describe, expect, it, vi } from 'vitest'
import { renderDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope'
import { loadPendingDeliveryHistory, projectSessionPendingDeliveries } from '@/lib/pendingSessionDeliveries'
import { activeTurnWithInputs, projectPendingMessages, type PendingMessageProjectionCache } from '@session-chat/state/pending-prompt'
import type { LifeView } from '@/session/shared/core/sessions/session-life'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { planConversationSegments } from '@session-chat/state/conversation-segments'
import { conversationOutput } from '@session-chat/state/conversation-process'

const envelope = (id: string, content = 'hello') => renderDeliveryEnvelope({ route: 'session-direct', from: 'Sender', fromType: 'agent', fromId: 'session:sender', messageId: `msg:${id}`, at: '2026-11-02 04:00 UTC-8', content })
const row = (id: string, seq: number, state: LifeView['pending']['items'][number]['state'] = 'queued') => ({ seq, messageId: id, text: envelope(id), preview: 'hello', kind: 'session-direct' as const, state, failure: null, sentAt: 10000 })
const view = (items: LifeView['pending']['items']): LifeView => ({ sessionId: 's', version: 1, kind: 'ready', stage: null, pending: { count: items.length, items }, hold: null, failure: null, lastExit: null, nativeSession: null })
const turn = (id: string, text: string): TranscriptTurn => ({ id, seq: 1, initiator: 'agent', startedAt: 5000, items: [{ kind: 'message', id: `${id}:native-user`, seq: 0, role: 'user', text }] })
const work = (id: string, at: number): Extract<TranscriptTurn['items'][number], { kind: 'execute-tool-call' }> => ({ kind: 'execute-tool-call', id, seq: at,
  toolCallId: id, title: id, status: 'done', at })
const segments = (record: TranscriptTurn) => planConversationSegments(record, true).filter(block => block.kind === 'segment')

describe('incoming delivery custody', () => {
  it('freezes the process before a mid-turn delivery while later tools belong below it', () => {
    const first: TranscriptTurn = { ...turn('running', 'initial question'), startedAt: 1000, items: [
      ...turn('running', 'initial question').items,
      ...Array.from({ length: 5 }, (_, i) => work(`before-${i}`, 2000 + i * 100)),
      { kind: 'message', id: 'reply-before', seq: 3000, role: 'assistant', text: 'first reply', at: 3000 },
    ] }
    const delivery = { ...row('inserted', 1), sentAt: 4000 }
    const inputs = projectSessionPendingDeliveries([], view([delivery]), [first])
    const initial = activeTurnWithInputs(first, null, inputs)!
    const later: TranscriptTurn = { ...first, items: [...first.items,
      ...Array.from({ length: 3 }, (_, i) => work(`after-${i}`, 5000 + i * 100)),
    ] }
    const nextInputs = projectSessionPendingDeliveries(inputs, view([delivery]), [later])
    const shown = activeTurnWithInputs(later, null, nextInputs)!
    const before = segments(initial)[0]!
    const [frozen, live] = segments(shown)
    expect(frozen).toEqual(before)
    expect(conversationOutput(frozen!.items).steps).toHaveLength(5)
    expect(conversationOutput(live!.items).steps).toHaveLength(3)
    expect(live).toMatchObject({ id: 'running:process@inserted', live: true, startedAt: 4000 })
    expect(shown.items.map(item => item.id)).toEqual([...first.items.map(item => item.id), 'inserted', 'after-0', 'after-1', 'after-2'])
    expect(later.items.some(item => item.id === 'inserted')).toBe(false)
    const committed = { ...later, endedAt: 9000, outcome: { kind: 'done' as const } }
    const settled = projectPendingMessages([committed], null, nextInputs)
    expect(settled.waiting).toEqual([])
    const closed = planConversationSegments(settled.committed[0]!, false).filter(block => block.kind === 'segment')
    expect(closed.map(segment => conversationOutput(segment.items).steps.length)).toEqual([5, 3])
    expect(closed[0]).toMatchObject({ endedAt: 4000, live: false })
  })

  it.each([true, false])('keeps the boundary after production storage renumbers turn/items (referenceId=%s)', withReference => {
    const id = 's:turn:6'
    const group = { kind: 'tool-group' as const, id: `${id}:group`, seq: 1, label: 'work', groupKind: 'read-batch' as const,
      status: 'running' as const, children: Array.from({ length: 5 }, (_, i) => work(`${id}:tool:before-${i}`, 2000 + i * 100)) }
    const first: TranscriptTurn = { ...turn(id, 'question'), ...(withReference ? { referenceId: 'source:this-run' } : {}), startedAt: 1000, items: [group] }
    const delivery = { ...row('inserted', 1), sentAt: 4000 }
    const inputs = projectSessionPendingDeliveries([], view([delivery]), [first])
    const later: TranscriptTurn = { ...first, endedAt: 9000, outcome: { kind: 'done' }, items: [{ ...group,
      children: [...group.children, ...Array.from({ length: 3 }, (_, i) => work(`${id}:tool:after-${i}`, 5000 + i * 100))] }] }
    // Store sequence differs from the runtime sequence; deleting an "s" prefix is insufficient.
    const stored = renumberStoredTurn(later, 's', 42)
    expect(stored.id).toBe('s:turn:s42')
    expect(stored.referenceId).toBe(first.referenceId)
    const refreshed = projectSessionPendingDeliveries(inputs, view([delivery]), [stored])
    const result = projectPendingMessages([stored], null, refreshed)
    expect(result.waiting).toEqual([])
    const closed = planConversationSegments(result.committed[0]!, false).filter(block => block.kind === 'segment')
    expect(closed.map(segment => conversationOutput(segment.items).steps.length)).toEqual([5, 3])
    expect(closed[0]).toMatchObject({ endedAt: 4000, live: false })
    expect(closed[1]).toMatchObject({ startedAt: 4000, endedAt: 9000, live: false })
    // A prior runtime used the same counter. Its persisted identity must not steal this boundary.
    const older = renumberStoredTurn({ ...later, ...(withReference ? { referenceId: 'source:older-run' } : {}), startedAt: 100 }, 's', 3)
    const withOlder = projectPendingMessages([older, stored], null, refreshed)
    expect(withOlder.committed[0]).toBe(older)
    expect(withOlder.waiting).toEqual([])
    expect(withOlder.committed[1]).toEqual(result.committed[0])
  })

  it('keeps simultaneous deliveries in queue order at the same captured boundary', () => {
    const initial: TranscriptTurn = { ...turn('running', 'question'), startedAt: 1000, items: [work('before', 2000)] }
    const a = { ...row('a', 1), sentAt: 4000 }, b = { ...row('b', 2), sentAt: 4500 }
    const inputs = projectSessionPendingDeliveries([], view([b, a]), [initial])
    const later = { ...initial, items: [...initial.items, work('after', 5000)] }
    const refreshed = projectSessionPendingDeliveries(inputs, view([a, b]), [later])
    const shown = activeTurnWithInputs(later, null, refreshed)!
    expect(shown.items.map(item => item.id)).toEqual(['before', 'a', 'b', 'after'])
    expect(segments(shown).map(segment => conversationOutput(segment.items).steps.length)).toEqual([1, 1])
    expect(segments(shown).at(-1)).toMatchObject({ startedAt: 4500, live: true })
  })

  it('does not advance the closed process clock when an earlier tool completes late', () => {
    const initial: TranscriptTurn = { ...turn('running', 'question'), startedAt: 1000,
      items: [{ ...work('before', 2000), status: 'running' }] }
    const delivery = { ...row('inserted', 1), sentAt: 4000 }
    const inputs = projectSessionPendingDeliveries([], view([delivery]), [initial])
    const original = segments(activeTurnWithInputs(initial, null, inputs)!)[0]!
    const later = { ...initial, items: [{ ...work('before', 2000), completedAt: 7000 }, work('after', 8000)] }
    const shown = activeTurnWithInputs(later, null, projectSessionPendingDeliveries(inputs, view([delivery]), [later]))!
    expect(segments(shown)[0]).toMatchObject({ startedAt: original.startedAt, endedAt: original.endedAt, live: false })
    expect(original.endedAt).toBe(4000)
    expect(segments(shown).map(segment => conversationOutput(segment.items).steps.length)).toEqual([1, 1])
  })

  it('splits a growing tool group at its captured child without losing native identities', () => {
    const group = { kind: 'tool-group' as const, id: 'group', seq: 1, label: 'work', groupKind: 'read-batch' as const,
      status: 'running' as const, children: [work('before', 2000)] }
    const initial: TranscriptTurn = { ...turn('running', 'question'), startedAt: 1000, items: [group] }
    const delivery = { ...row('inserted', 1), sentAt: 4000 }
    const inputs = projectSessionPendingDeliveries([], view([delivery]), [initial])
    const later = { ...initial, items: [{ ...group, children: [...group.children, work('after', 5000)] }] }
    const shown = activeTurnWithInputs(later, null, projectSessionPendingDeliveries(inputs, view([delivery]), [later]))!
    expect(segments(shown).map(segment => conversationOutput(segment.items).steps.map(item => item.id))).toEqual([['before'], ['after']])
    expect(shown.items.map(item => item.id)).toEqual(['group', 'inserted', 'group@inserted'])
    expect(later.items[0]!.children.map(item => item.id)).toEqual(['before', 'after'])
  })

  it('orders host messages by queue sequence, preserves the envelope, and leaves manual queue inputs alone', () => {
    const a = row('a', 1), b = row('b', 2)
    const result = projectSessionPendingDeliveries([], view([b, { ...row('manual', 0), kind: 'ordinary' }, a]), [])
    expect(result.map(input => input.id)).toEqual(['a', 'b'])
    expect(result[0]).toMatchObject({ text: a.text, received: true, delivery: { state: 'sending' } })
    expect(activeTurnWithInputs(null, null, result)?.items).toMatchObject([{ text: a.text }, { text: b.text }])
  })

  it('holds accepted-before-echo through a history prepend and replaces only the matching receipt', () => {
    const initial = projectSessionPendingDeliveries([], view([row('a', 1), row('b', 2)]), [])
    const accepted = projectSessionPendingDeliveries(initial, view([]), [turn('older', envelope('unrelated'))])
    expect(accepted.map(input => input.delivery?.state)).toEqual(['accepted', 'accepted'])
    const history = [turn('old', 'old input'), turn('first', envelope('a'))]
    expect(projectSessionPendingDeliveries(accepted, view([]), history).map(input => input.id)).toEqual(['b'])
    expect(projectSessionPendingDeliveries(accepted, view([]), [...history, turn('second', envelope('b'))])).toEqual([])
  })

  it('recognizes early native echoes despite slow host clocks, prefix renumbering, and identical message bodies', () => {
    const a = row('a', 1), b = row('b', 2)
    const native = turn('s:turn:6', a.text)
    const initial = projectSessionPendingDeliveries([], view([a, b]), [native])
    const projected = projectPendingMessages([], native, initial)
    expect(projected.waiting.map(input => input.id)).toEqual(['b'])
    expect(activeTurnWithInputs(projected.active, null, projected.waiting)?.items).toHaveLength(2)
    const stored = { ...native, id: 's:turn:s6', items: [{ ...native.items[0]!, id: 's:turn:s6:native-user' }] }
    expect(projectSessionPendingDeliveries(initial, view([{ ...a, state: 'accepted' }, b]), [stored]).map(input => input.id)).toEqual(['b'])
  })

  it('decorates the last real echo of unknown inbox receipts without duplicating or mutating history', () => {
    const a = { ...row('a', 1, 'unknown'), kind: 'inbox-batch' as const }
    const history = [turn('old-replay', a.text), turn('final-echo', a.text)]
    const inputs = projectSessionPendingDeliveries([], view([a]), history)
    const result = projectPendingMessages(history, null, inputs)
    expect(inputs[0]?.delivery).toMatchObject({ state: 'unknown', retryable: false })
    expect(projectSessionPendingDeliveries(inputs, null, history)[0]?.delivery).toMatchObject({ state: 'unknown', retryable: false })
    expect(result.waiting).toEqual([])
    expect(result.committed[0]).toBe(history[0])
    expect(result.committed[1]?.items[0]).toMatchObject({ sendStatus: { state: 'unknown', retryable: false } })
    expect(history[1]?.items[0]).not.toHaveProperty('sendStatus')
    const narrowed = projectSessionPendingDeliveries(inputs, view([a]), [])
    expect(narrowed[0]?.nativeEcho).toEqual({ turnId: history[1]!.id, itemId: history[1]!.items[0]!.id })
    expect(projectPendingMessages([], null, narrowed).waiting).toEqual([])
    expect(result.committed.flatMap(t => t.items)).toHaveLength(2)
    const accepted = projectSessionPendingDeliveries(inputs, view([{ ...a, state: 'accepted' }]), history)
    expect(accepted).toEqual([])
    expect(projectPendingMessages(history, null, accepted).committed).toBe(history)
  })

  it('retains unknown-before-history and startup failure without offering an unsafe unknown resend', () => {
    const unknown = projectSessionPendingDeliveries([], view([row('a', 1, 'unknown')]), [])
    expect(projectPendingMessages([], null, unknown).waiting).toHaveLength(1)
    const received = turn('echo', envelope('a'))
    expect(projectPendingMessages([received], null, unknown).waiting).toHaveLength(0)
    const failed = projectSessionPendingDeliveries([], { ...view([row('b', 2)]), hold: 'start-failed', kind: 'failed' }, [])
    expect(failed[0]?.delivery).toMatchObject({ state: 'failed', retryable: true })
    const stillUnknown = projectSessionPendingDeliveries(unknown, { ...view([row('a', 1, 'unknown')]), hold: 'start-failed', kind: 'failed' }, [])
    expect(stillUnknown[0]?.delivery).toMatchObject({ state: 'unknown', retryable: false })
  })

  it('reuses decorated committed turns while an unrelated active turn streams', () => {
    const item = row('a', 1, 'unknown'), history = [turn('old', item.text)]
    const inputs = projectSessionPendingDeliveries([], view([item]), history)
    const cache: PendingMessageProjectionCache = new WeakMap()
    const first = projectPendingMessages(history, null, inputs, cache)
    const second = projectPendingMessages(history, turn('current', 'Streaming'), inputs, cache)
    expect(second.committed[0]).toBe(first.committed[0])
  })
})


it('resolves unknown native echoes beyond a trimmed first page before publishing the initial transcript', async () => {
  const inputs = projectSessionPendingDeliveries([], view([row('a', 1, 'unknown'), row('b', 2, 'unknown')]), [])
  const newest = [turn('latest', 'Latest response')]
  const reads: number[] = []
  const result = await loadPendingDeliveryHistory(newest, 30, inputs, async before => {
    reads.push(before)
    return before === 30 ? { turns: [turn('b-echo', envelope('b'))], nextCursor: 20 }
      : { turns: [turn('a-echo', envelope('a'))], nextCursor: 10 }
  }, () => true)
  expect(reads).toEqual([30, 20])
  expect(result.cursor).toBe(10)
  const projected = projectPendingMessages([...result.turns, ...newest], null, inputs)
  expect(projected.waiting).toEqual([])
  expect(projected.committed.map(t => t.id)).toEqual(['a-echo', 'b-echo', 'latest'])
})


it('keeps a genuinely unconfirmed input at the tail only after the history cursor is exhausted', async () => {
  const inputs = projectSessionPendingDeliveries([], view([row('unconfirmed', 1, 'unknown')]), [])
  const result = await loadPendingDeliveryHistory([turn('latest', 'Other input')], 10, inputs,
    async () => ({ turns: [turn('old', 'Old input')], nextCursor: null }), () => true)
  expect(result.cursor).toBeNull()
  expect(projectPendingMessages(result.turns, null, inputs).waiting).toHaveLength(1)
  await expect(loadPendingDeliveryHistory([], 10, inputs,
    async () => ({ turns: [], nextCursor: 10 }), () => true)).rejects.toThrow('cursor did not advance')
})

it('adds no history request for ordinary sends or when unknown echoes are already in the first page', async () => {
  const read = async () => { throw new Error('Unexpected extra history request') }
  expect((await loadPendingDeliveryHistory([], 100, [], read, () => true)).pages).toBe(0)
  const input = projectSessionPendingDeliveries([], view([row('a', 1, 'unknown')]), [])
  expect((await loadPendingDeliveryHistory([turn('native', envelope('a'))], 100, input, read, () => true)).pages).toBe(0)
})

it('bounds the search and hands an out-of-budget receipt to its later native history exactly once', async () => {
  const inputs = projectSessionPendingDeliveries([], view([row('late', 1, 'unknown')]), [])
  let calls = 0
  const newest = [turn('latest', 'Latest question')]
  const bounded = await loadPendingDeliveryHistory(newest, 100, inputs, async before => {
    calls++
    return { turns: [turn(`page-${before}`, 'Unrelated question')], nextCursor: before - 1 }
  }, () => true)
  expect(calls).toBe(6)
  expect(bounded.reason).toBe('pages')
  expect(projectPendingMessages([...bounded.turns, ...newest], null, inputs).waiting).toHaveLength(1)
  const native = turn('late-native', envelope('late'))
  const landed = projectPendingMessages([native, ...bounded.turns, ...newest], null, inputs)
  expect(landed.waiting).toEqual([])
  expect(landed.committed.flatMap(t => t.items.filter(item => 'sendStatus' in item))).toHaveLength(1)
  const later = projectPendingMessages([turn('earlier-page', 'Earlier question'), ...landed.committed], null, inputs)
  expect(later.waiting).toEqual([])
  expect(later.committed.flatMap(t => t.items.filter(item => 'sendStatus' in item)).map(item => item.id)).toEqual([native.items[0]!.id])
})

it('does not merge a history page beyond the byte budget', async () => {
  const inputs = projectSessionPendingDeliveries([], view([row('a', 1, 'unknown')]), [])
  const result = await loadPendingDeliveryHistory([], 100, inputs,
    async () => ({ turns: [turn('old', 'Unrelated')], nextCursor: 99 }), () => true, { pages: 6, bytes: 1, milliseconds: 1500 })
  expect(result.reason).toBe('bytes')
  expect(result.pages).toBe(1)
  expect(result.turns).toEqual([])
  expect(result.cursor).toBe(100)
})

it('ends the supplemental read at its UI deadline without waiting for a slow host', async () => {
  vi.useFakeTimers()
  try {
    const inputs = projectSessionPendingDeliveries([], view([row('a', 1, 'unknown')]), [])
    let calls = 0
    const pending = loadPendingDeliveryHistory([], 100, inputs, () => { calls++; return new Promise(() => {}) }, () => true)
    await vi.advanceTimersByTimeAsync(1500)
    const result = await pending
    expect(result.reason).toBe('timeout')
    expect(result.milliseconds).toBe(1500)
    expect(result.turns).toEqual([])
    expect(calls).toBe(1)
  } finally { vi.useRealTimers() }
})


it('leaves plain human session-direct sends and manual queues out of the incoming projection', () => {
  const human = { ...row('human', 1), text: 'human input', kind: 'session-direct' as const }
  expect(projectSessionPendingDeliveries([], view([human]), [])).toEqual([])
  expect(projectSessionPendingDeliveries([], view([{ ...human, state: 'accepted' }]), [])).toEqual([])
  expect(projectSessionPendingDeliveries([], view([{ ...human, state: 'unknown' }]), [])[0]).toMatchObject({ received: false, delivery: { state: 'unknown' } })
})

it('finds a plain unknown receipt using the complete anchor context, without sender-host clock comparisons', () => {
  const anchor = turn('anchor', 'Earlier input')
  const input = { ...row('unknown-human', 1, 'unknown'), text: 'Next input' }
  const waiting = projectSessionPendingDeliveries([], view([input]), [anchor])
  const native = turn('native-next', input.text)
  const found = projectSessionPendingDeliveries(waiting, view([input]), [anchor, native])
  expect(found[0]?.nativeEcho).toEqual({ turnId: native.id, itemId: native.items[0]!.id })
  const projection = projectPendingMessages([anchor, native], null, found)
  expect(projection.waiting).toEqual([])
  expect(projection.committed[1]?.items[0]).toMatchObject({ sendStatus: { state: 'unknown' } })
  expect(projectSessionPendingDeliveries(found, view([]), [anchor, native])).toEqual([])
})

it('rechecks mutable active messages instead of caching an incomplete native envelope list', () => {
  const input = row('later', 1, 'unknown')
  const pending = projectSessionPendingDeliveries([], view([input]), [])
  const active = turn('active', envelope('earlier'))
  const cache: PendingMessageProjectionCache = new WeakMap()
  expect(projectPendingMessages([], active, pending, cache).waiting).toHaveLength(1)
  active.items.push({ ...turn('later-native', input.text).items[0]!, seq: 1 })
  const projection = projectPendingMessages([], active, pending, cache)
  expect(projection.waiting).toEqual([])
  expect(projection.active?.items[1]).toMatchObject({ sendStatus: { state: 'unknown' } })
})
