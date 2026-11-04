import { describe, expect, it } from 'vitest'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import type { SessionInput } from '@/lib/sessionInputOutbox'
import { canReleasePhoneInput, phoneInputQueueIntent, phoneManualHostPrompts, phoneQueuedPrompts, phoneWaitingReceipts } from '@/mobile/agent-watch/phone-input-queue'
import { localQueuedInputs } from '@/mobile/agent-watch/local-queued-inputs'
import { projectPhonePendingInputs } from '@/mobile/agent-watch/phone-pending-inputs'

const input = (id: string, order: number): SessionInput => ({ id, accountId: 'owner', deviceId: 'host', sessionId: 'session',
  text: 'same words', createdAt: order, queued: true, sendQueue: { order } })
const turn = (done: boolean): TranscriptTurn => ({ id: 'turn', seq: 0, initiator: 'user', items: [], ...(done ? { outcome: { kind: 'done' as const } } : {}) })

describe('phone composer ownership', () => {
  it('stores a real queue decision for busy and pending sends, while an idle first send remains ordinary', () => {
    expect(phoneInputQueueIntent(false, [])).toEqual({ queued: false })
    expect(phoneInputQueueIntent(true, []).sendQueue).toBeDefined()
    expect(phoneInputQueueIntent(false, [input('already-held', 1)]).sendQueue).toBeDefined()
    expect(phoneInputQueueIntent(false, [{ ...input('in-flight', 1), queued: false, sendQueue: undefined }]).sendQueue?.afterInputId).toBe('in-flight')
  })

  it('shows only real held inputs as editable prompts in persistent order, including an edit reservation', () => {
    const first = input('first', 1)
    first.sendQueue!.edit = { draftText: 'changed draft', originalDraftText: 'keep my normal draft' }
    expect(phoneQueuedPrompts([input('second', 2), { ...input('legacy', 3), sendQueue: undefined }, first])).toEqual([
      { id: 'first', text: 'same words', queueEdit: first.sendQueue!.edit }, { id: 'second', text: 'same words', queueEdit: undefined },
    ])
    // True held rows are not retained by the old handoff cache after deletion or release.
    expect(localQueuedInputs([first], [first], [], [])).toEqual([])
  })

  it('never puts a sent ordinary input back into the composer when the host later reports it queued', () => {
    const hosted = [{ id: 'runtime', clientMessageId: 'sent', text: 'same words' }, { id: 'old-manual', text: 'manual runtime prompt' }]
    expect(phoneManualHostPrompts(hosted).map(prompt => prompt.id)).toEqual(['old-manual'])
    const receipts = phoneWaitingReceipts(hosted)
    expect(receipts).toMatchObject([{ messageId: 'sent', state: 'queued', kind: 'ordinary' }])
    const pending = projectPhonePendingInputs([], [], receipts, [])
    expect(pending.map(prompt => prompt.id)).toEqual(['sent'])
    const accepted = projectPhonePendingInputs(pending, [], [], [])
    expect(accepted.map(prompt => prompt.id)).toEqual(['sent'])
    const echo: TranscriptTurn = { ...turn(true), items: [{ kind: 'message', role: 'user', id: 'provider-message', seq: 0, text: 'same words', _meta: { guguClientMessageId: 'sent' } }] }
    expect(projectPhonePendingInputs(accepted, [], [], [echo])).toEqual([])
  })

  it('keeps multiple already-sent inputs in the transcript, distinct even when their text matches', () => {
    const receipts = phoneWaitingReceipts([{ id: 'host-a', clientMessageId: 'client-a', text: 'same words' }, { id: 'host-b', clientMessageId: 'client-b', text: 'same words' }])
    const pending = projectPhonePendingInputs([], [], receipts, [])
    expect(pending.map(prompt => prompt.id)).toEqual(['client-a', 'client-b'])
    const echo: TranscriptTurn = { ...turn(true), items: [{ kind: 'message', role: 'user', id: 'provider-message-a', seq: 0,
      text: 'same words', _meta: { guguClientMessageId: 'client-a' } }] }
    expect(projectPhonePendingInputs(pending, [], receipts, [echo]).map(prompt => prompt.id)).toEqual(['client-b'])
    const sender = ['client-a', 'client-b'].map(id => ({ ...input(id, 1), queued: false, sendQueue: undefined }))
    expect(projectPhonePendingInputs([], sender, receipts, [echo]).map(prompt => prompt.id)).toEqual(['client-b'])
  })

  it.each([
    [false, false, false, true, false], [true, true, false, true, false], [true, false, true, true, false],
    [true, false, false, false, false], [true, false, false, true, true],
  ])('requires a live foreground completion before draining (%s/%s/%s/%s)', (ready, working, stopping, done, allowed) => {
    expect(canReleasePhoneInput(ready, working, stopping, [turn(done)])).toBe(allowed)
  })
})
