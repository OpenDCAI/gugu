import { expect, it } from 'vitest'
import { localQueuedInputs } from '../../../apps/desktop/src/mobile/agent-watch/local-queued-inputs'
import type { SessionInput } from '../../../apps/desktop/src/lib/sessionInputOutbox'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'

const input = (id: string, queued = true): SessionInput => ({ id, accountId: 'owner', deviceId: 'host',
  sessionId: 'session', text: `message ${id}`, createdAt: 1, queued, baseline: ['old'], afterTurnId: 'old-turn' })
const old: TranscriptTurn = { id: 'old-turn', seq: 1, initiator: 'user', outcome: { kind: 'done' }, items: [
  { kind: 'message', id: 'old', role: 'user', seq: 0, text: 'message local' },
] }

it('shows only durable queued inputs before the host responds and retains them across acknowledgement', () => {
  const local = input('local')
  const shown = localQueuedInputs([], [local, input('ordinary', false)], [], [old])
  expect(shown).toEqual([local])
  expect(localQueuedInputs(shown, [], [], [old])).toEqual([local])
  expect(localQueuedInputs(shown, [{ ...local, failure: { code: 'host-offline' } }], [], [old]))
    .toEqual([{ ...local, failure: { code: 'host-offline' } }])
})

it('hands off each id once to the host queue or its own transcript echo', () => {
  const one = input('one'), two = input('two')
  const shown = localQueuedInputs([], [one, two], [{ id: one.id }], [old])
  expect(shown).toEqual([two])
  const echo: TranscriptTurn = { id: 'new-turn', seq: 2, initiator: 'user', outcome: { kind: 'done' }, items: [
    { kind: 'message', id: 'two', role: 'user', seq: 0, text: two.text },
  ] }
  expect(localQueuedInputs(shown, [two], [], [old, echo])).toEqual([])
})

it('does not let one native echo consume two identical queued inputs on later renders', () => {
  const one = { ...input('one'), text: 'same' }, two = { ...input('two'), text: 'same' }
  const echo: TranscriptTurn = { id: 'new-turn', seq: 2, initiator: 'user', outcome: { kind: 'done' }, items: [
    { kind: 'message', id: 'one', role: 'user', seq: 0, text: 'same' },
  ] }
  const remaining = localQueuedInputs([one, two], [], [], [old, echo])
  expect(remaining.map(input => input.id)).toEqual(['two'])
  expect(localQueuedInputs(remaining, [], [], [old, echo]).map(input => input.id)).toEqual(['two'])
  expect(localQueuedInputs(remaining, [two], [], [old, echo]).map(input => input.id)).toEqual(['two'])
  const next: TranscriptTurn = { ...echo, id: 'next-turn', seq: 3, items: [
    { kind: 'message', id: 'two', role: 'user', seq: 0, text: 'same' },
  ] }
  expect(localQueuedInputs(remaining, [], [], [old, echo, next])).toEqual([])
})

it('does not consume B when A hands off to the host before its identical transcript echo arrives', () => {
  const a = { ...input('a'), text: 'same' }, b = { ...input('b'), text: 'same' }
  const local = localQueuedInputs([], [a, b], [], [old])
  const handedOff = localQueuedInputs(local, [b], [{ id: a.id }], [old])
  expect(handedOff.map(input => input.id)).toEqual(['b'])
  const echo: TranscriptTurn = { id: 'a-turn', seq: 2, initiator: 'user', outcome: { kind: 'done' }, items: [
    { kind: 'message', id: 'a', role: 'user', seq: 0, text: 'same' },
  ] }
  expect(localQueuedInputs(handedOff, [b], [], [old, echo]).map(input => input.id)).toEqual(['b'])
})

it('uses the native message identity across turn prefixes, without matching the words', () => {
  const own = input('11111111-1111-4111-8111-111111111111')
  const echo: TranscriptTurn = { id: 'native-turn', seq: 2, initiator: 'user', outcome: { kind: 'done' }, items: [
    { kind: 'message', id: `history:message:${own.id}`, role: 'user', seq: 0, text: 'the runtime rendered different text' },
  ] }
  expect(localQueuedInputs([own], [own], [], [old, echo])).toEqual([])
})

it('hands off an empty outbox to a runtime queue with a different id and the original client identity', () => {
  const single = input('client-single'), triple = input('client-triple')
  const shown = localQueuedInputs([], [single, triple], [], [old])
  const echo: TranscriptTurn = { id: 'provider-turn', seq: 2, initiator: 'user', outcome: { kind: 'done' }, items: [
    { kind: 'message', id: 'provider-single', role: 'user', seq: 0, text: single.text, _meta: { guguClientMessageId: single.id } },
  ] }
  expect(localQueuedInputs(shown, [], [{ id: 'runtime-triple', clientMessageId: triple.id }], [old, echo])).toEqual([])
})

it('does not use a renamed native receipt for a different input with the same text', () => {
  const a = { ...input('client-a'), text: 'same' }, b = { ...input('client-b'), text: 'same' }
  const echo: TranscriptTurn = { id: 'provider-turn', seq: 2, initiator: 'user', outcome: { kind: 'done' }, items: [
    { kind: 'message', id: 'provider-a', role: 'user', seq: 0, text: 'same', _meta: { guguClientMessageId: a.id } },
  ] }
  const remaining = localQueuedInputs([a, b], [], [], [old, echo])
  expect(remaining).toEqual([b])
  expect(localQueuedInputs(remaining, [], [], [old, echo])).toEqual([b])
})

it('does not invent an identity receipt when an older host only returns matching text', () => {
  const own = input('client')
  const echo: TranscriptTurn = { id: 'old-provider-turn', seq: 2, initiator: 'user', outcome: { kind: 'done' }, items: [
    { kind: 'message', id: 'old-provider-id', role: 'user', seq: 0, text: own.text },
  ] }
  expect(localQueuedInputs([own], [], [{ id: 'old-runtime-id' }], [old, echo])).toEqual([own])
})
