import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import type { ConversationQueueTarget } from '@/components/chat/useConversationQueue'
import { assistantTimelineClient, changeConversationQueue } from '@/components/assistant/assistantTimelineClient'
import { releaseQueuedSessionInput, state } from '@/lib/sessionInputOutboxBridge'
import { withSessionInputDeadline } from '@/lib/sessionInputOutbox'
import { sessionInputFailureText } from '@/lib/pendingSessionInput'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { phoneTimelineClient } from '../local-agent/phoneTimelineClient'
import type { SessionpageTimelineClient } from './use-timeline-session'

/** Pi's generic stop clears all hosted jobs; its original queue action interrupts only the foreground. */
export async function sendPhoneQueuedInputNow(target: ConversationQueueTarget, turns: readonly TranscriptTurn[], id: string, steers: boolean): Promise<void> {
  const own = state(), accountId = own.accountId, valid = own.valid, sender = own.queue
  if (!sender || !valid()) throw new Error('Session input outbox is not available for this account')
  const current = () => state().accountId === accountId && state().queue === sender && valid()
  const input = await releaseQueuedSessionInput(target.sessionId, turns, id, steers, current)
  if (!input) throw new Error(translateSessionMessage('acpFailure.editQueued'))
  const outbox = await sender
  await outbox.flush()
  if (!current()) throw new Error('Session input account changed')
  const pending = (await outbox.list()).find(row => row.id === id)
  if (pending) throw new Error(sessionInputFailureText(pending.failure ?? { code: 'phone-unconfirmed' }))
  if (steers) return
  await prioritizeHostedInput(target, id, target.phoneHost ? phoneTimelineClient : assistantTimelineClient(target.local), current)
}

/** Admission may finish before its runtime queue/native echo is published. Watch that exact identity. */
async function prioritizeHostedInput(target: ConversationQueueTarget, id: string, client: SessionpageTimelineClient, current: () => boolean): Promise<void> {
  let resolve!: () => void, reject!: (error: unknown) => void
  const done = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  const outcome = withSessionInputDeadline(done).then(() => ({ ok: true as const }), error => ({ ok: false as const, error }))
  let closed = false, checking = false, again = false, finished = false
  const finish = () => { finished = true; resolve() }
  const hasEcho = (snapshot: Awaited<ReturnType<SessionpageTimelineClient['fetchSnapshot']>>) => snapshot.turns.some(turn =>
    turn.items.some(item => item.kind === 'message' && item.role === 'user' && item._meta?.guguClientMessageId === id))
  const check = async () => {
    if (checking) { again = true; return }
    checking = true
    try {
      do {
        again = false
        if (closed || finished) return
        if (!current()) throw new Error('Session input account changed')
        const snapshot = await client.fetchSnapshot(target.deviceId, target.sessionId, 100)
        if (closed || finished) return
        if (!current()) throw new Error('Session input account changed')
        if (hasEcho(snapshot)) { finish(); return }
        const hosted = snapshot.queuedPrompts?.find(prompt => prompt.clientMessageId === id)
        if (hosted) {
          try { await changeConversationQueue(target.local, target.deviceId, target.sessionId, { kind: 'send-now', id: hosted.id, steers: false }, target.phoneHost) }
          catch (error) {
            // The exact input can naturally start while the queue action is crossing the link.
            if (!current() || !hasEcho(await client.fetchSnapshot(target.deviceId, target.sessionId, 100))) throw error
          }
          finish(); return
        }
      } while (again)
    } catch (error) { reject(error) }
    finally { checking = false }
  }
  const subscriptionId = `send-now:${crypto.randomUUID()}`
  const stopEvents = client.subscribeSessionEvents(target.deviceId, subscriptionId, () => { void check() })
  const stopErrors = client.subscribeSessionErrors?.(target.deviceId, subscriptionId, reject)
  const stopLink = client.onLinkChange(target.deviceId, open => { if (!open) reject(new Error(sessionInputFailureText({ code: 'phone-unconfirmed' }))) })
  try {
    await client.subscribeSession(target.deviceId, target.sessionId, subscriptionId, null)
    await check()
    const result = await outcome
    if (!result.ok) throw result.error
  } finally {
    closed = true; resolve(); stopEvents(); stopErrors?.(); stopLink()
    await client.unsubscribeSession(target.deviceId, subscriptionId)
  }
}
