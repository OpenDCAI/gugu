import { describe, expect, it } from 'vitest'
import { projectSessionPendingInput, sessionInputBaseline } from '@/lib/pendingSessionInput'
import { activeTurnWithPending } from '@session-chat/state/pending-prompt'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import type { HostPendingRow, SessionInput } from '@/lib/sessionInputOutbox'

const turn = (id: string, text: string, at = 10): TranscriptTurn => ({ id, seq: at, initiator: 'user', startedAt: at,
  items: [{ kind: 'message', id: `${id}:user`, seq: 0, role: 'user', text }] })
const old = turn('old', 'previous')
const input = (): SessionInput => ({ id: 'send', sessionId: 's', accountId: 'a', deviceId: null, text: 'hello',
  createdAt: 20, queued: false, ...sessionInputBaseline([old]) })
const host = (state: HostPendingRow['state']): HostPendingRow => ({ seq: 1, messageId: 'send', kind: 'ordinary', text: 'hello',
  preview: 'hello', sentAt: 20, state, failure: state === 'failed' ? 'delivery failed' : null })

describe('ordinary input transcript custody', () => {
  it('keeps the same input through sender acknowledgement before its native echo', () => {
    const sending = projectSessionPendingInput(null, [input()], [], [old])!
    expect(sending).toMatchObject({ id: 'send', delivery: { state: 'sending' } })
    const accepted = projectSessionPendingInput(sending, [], [], [old])!
    expect(accepted).toMatchObject({ id: 'send', text: 'hello', held: true, delivery: { state: 'accepted' } })
    expect(projectSessionPendingInput(accepted, [], [host('queued')], [old])?.delivery?.state).toBe('accepted')
    expect(projectSessionPendingInput(accepted, [], [], [old, turn('native', 'hello', 25)])).toBeNull()
  })

  it('does not duplicate a native echo that arrives before the acknowledgement', () => {
    const turns = [old, turn('native', 'hello', 25)]
    expect(projectSessionPendingInput(null, [input()], [host('dispatching')], turns)).toBeNull()
  })

  it('recognizes its echo after the anchor when the remote host clock is five seconds slow', () => {
    const sending = projectSessionPendingInput(null, [{ ...input(), createdAt: 10000 }], [], [old])!
    expect(projectSessionPendingInput(sending, [], [], [old, turn('native', 'hello', 5000)])).toBeNull()
  })

  it('does not acknowledge a second identical input with the first input echo', () => {
    const firstEcho = turn('first-echo', '好', 30)
    const second = { ...input(), id: 'second-send', text: '好', createdAt: 40, ...sessionInputBaseline([old, firstEcho]) }
    const sending = projectSessionPendingInput(null, [second], [], [old, firstEcho])!
    expect(sending).toMatchObject({ id: 'second-send', delivery: { state: 'sending' } })
    expect(projectSessionPendingInput(sending, [], [], [turn('older', '好', 1), old, firstEcho])?.id).toBe('second-send')
    expect(projectSessionPendingInput(sending, [], [], [old, firstEcho, turn('second-echo', '好', 50)])).toBeNull()
  })

  it('keeps the baseline and turn anchor when persistence renumbers a live display prefix', () => {
    const nativeId = '01a19c1a-43c7-7b70-82ba-1d17a9390881'
    const live = { ...turn('s:turn:6', '好'), items: [{ kind: 'message' as const, id: `s:turn:6:message:${nativeId}`, seq: 0, role: 'user' as const, text: '好' }] }
    const second = { ...input(), text: '好', ...sessionInputBaseline([old, live]) }
    const sending = projectSessionPendingInput(null, [second], [], [old, live])!
    const stored = { ...live, id: 's:turn:s6', items: [{ ...live.items[0], id: `s:turn:s6:message:${nativeId}` }] }
    expect(projectSessionPendingInput(sending, [], [], [old, stored])?.id).toBe(second.id)
    expect(projectSessionPendingInput(sending, [], [], [old, stored, turn('new-echo', '好', 1)])).toBeNull()
  })

  it('does not mistake paginated older history or an unrelated active turn for a receipt', () => {
    const sending = projectSessionPendingInput(null, [input()], [], [old])!
    const history = [turn('older', 'hello', 1), old, turn('elsewhere', 'another input', 21)]
    expect(projectSessionPendingInput(sending, [input()], [], history)?.id).toBe('send')
  })

  it('keeps the ordinary bubble visible when a native turn starts before its user echo', () => {
    const sending = projectSessionPendingInput(null, [input()], [], [old])!
    const active: TranscriptTurn = { id: 'new-turn', seq: 2, initiator: 'user', startedAt: 25, items: [] }
    expect(activeTurnWithPending(active, sending)?.items).toMatchObject([{ id: 'send', text: 'hello' }])
    expect(activeTurnWithPending(turn('native', 'hello', 25), sending)?.items).toHaveLength(1)
  })

  it('keeps failure and retry on the same input identity', () => {
    const failed = projectSessionPendingInput(null, [{ ...input(), failure: { code: 'send-failed', message: 'connection refused' } }], [], [old])!
    expect(failed).toMatchObject({ id: 'send', delivery: { state: 'failed', error: 'connection refused' } })
    expect(projectSessionPendingInput(failed, [input()], [], [old])).toMatchObject({ id: 'send', delivery: { state: 'sending' } })
    expect(projectSessionPendingInput(failed, [], [host('failed')], [old])).toMatchObject({ id: 'send', delivery: { state: 'failed' } })
  })

  it('leaves explicitly queued inputs in their existing queue', () => {
    expect(projectSessionPendingInput(null, [{ ...input(), queued: true }], [], [old])).toBeNull()
  })

  it('keeps an unknown host outcome visible without offering an unsafe resend', () => {
    const sending = projectSessionPendingInput(null, [input()], [], [old])!
    expect(projectSessionPendingInput(sending, [], [host('unknown')], [old])).toMatchObject({
      id: 'send', delivery: { state: 'unknown', retryable: false },
    })
  })
})
