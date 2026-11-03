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
    { kind: 'message', id: 'native-two', role: 'user', seq: 0, text: two.text },
  ] }
  expect(localQueuedInputs(shown, [two], [], [old, echo])).toEqual([])
})

it('does not let one native echo consume two identical queued inputs on later renders', () => {
  const one = { ...input('one'), text: 'same' }, two = { ...input('two'), text: 'same' }
  const echo: TranscriptTurn = { id: 'new-turn', seq: 2, initiator: 'user', outcome: { kind: 'done' }, items: [
    { kind: 'message', id: 'native-one', role: 'user', seq: 0, text: 'same' },
  ] }
  const remaining = localQueuedInputs([one, two], [], [], [old, echo])
  expect(remaining.map(input => input.id)).toEqual(['two'])
  expect(localQueuedInputs(remaining, [], [], [old, echo]).map(input => input.id)).toEqual(['two'])
  expect(localQueuedInputs(remaining, [two], [], [old, echo]).map(input => input.id)).toEqual(['two'])
  const next: TranscriptTurn = { ...echo, id: 'next-turn', seq: 3, items: [
    { kind: 'message', id: 'native-two', role: 'user', seq: 0, text: 'same' },
  ] }
  expect(localQueuedInputs(remaining, [], [], [old, echo, next])).toEqual([])
})
