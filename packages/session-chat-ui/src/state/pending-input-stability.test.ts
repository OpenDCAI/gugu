import { describe, expect, it } from 'vitest'
import { activeTurnWithPending, latestVisibleTurnId, pendingPromptLanded, type PendingPrompt } from './pending-prompt'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'

const previous: TranscriptTurn = { id: 'old', seq: 0, initiator: 'user', outcome: { kind: 'done' }, items: [
  { id: 'old-input', kind: 'message', role: 'user', seq: 0, text: '好' },
] }
const pending: PendingPrompt = { id: 'client-new', text: '好', held: true, baselineMessageIds: ['old-input'], afterTurnId: 'old', delivery: { state: 'receiving' } }

describe('sent input waiting for receiver', () => {
  it('keeps the sent input alongside an unrelated active foreground turn', () => {
    const active = { ...previous, id: 'unrelated', outcome: undefined }
    const shown = activeTurnWithPending(active, pending)!
    expect(shown.items.filter(item => item.kind === 'message').map(item => item.id)).toEqual(['old-input', 'client-new'])
    expect(active.items.map(item => item.id)).toEqual(['old-input'])
  })

  it('recognizes an exact client identity even when native text is normalized and host time is slow', () => {
    const echo: TranscriptTurn = { id: 'native', seq: 1, initiator: 'user', startedAt: 5000, items: [
      { id: 'native-id', kind: 'message', role: 'user', seq: 0, text: 'provider normalized input', _meta: { guguClientMessageId: pending.id } },
    ] }
    expect(pendingPromptLanded({ ...pending, sentAt: 10000 }, [previous, echo])).toBe(true)
    expect(activeTurnWithPending(echo, pending)?.items).toHaveLength(1)
    expect(pendingPromptLanded({ ...pending, id: 'different-client' }, [previous, echo])).toBe(false)
  })

  it('changes latest-visible ownership at the first pending frame, with the same empty-header visibility at echo', () => {
    expect(latestVisibleTurnId(null, [previous], null)).toBe('old')
    expect(latestVisibleTurnId(null, [previous], pending)).not.toBe('old')
    const echo = { ...previous, id: 'native-new', items: [{ ...previous.items[0]!, id: pending.id }] }
    expect(latestVisibleTurnId(echo, [previous], pending)).not.toBe('old')
    expect(latestVisibleTurnId(null, [previous], null, [pending])).not.toBe('old')
    expect(latestVisibleTurnId(null, [previous], null, [])).toBe('old')
  })
})
