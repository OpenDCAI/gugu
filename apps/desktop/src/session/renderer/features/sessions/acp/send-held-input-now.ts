import type { AcpLiveSession } from '@renderer/lib/acp/acp-live-session'
import type { AcpChatStore } from './acp-chat-store'
import { releaseQueuedSessionInput, state } from '@/lib/sessionInputOutboxBridge'
import { withSessionInputDeadline } from '@/lib/sessionInputOutbox'

/** The old host queue and the new local queue may coexist immediately after an upgrade. */
export async function sendHeldInputNow(store: AcpChatStore, id: string, steers: boolean): Promise<void> {
  const session = store.session
  const own = state(), account = own.accountId, sender = own.queue
  const valid = () => own.valid() && own.accountId === account && own.queue === sender && store.session === session
  const transcript = store.chatState.transcript.state
  const turns = [...transcript.committedTurns, ...(transcript.activeTurnSnapshot ? [transcript.activeTurnSnapshot] : [])]
  if (!steers && session?.sessionState.current().queuedPrompts.some(input => !input.clientMessageId)) {
    // First hand over the exact ID, then use the original queue-front/cancel path. Cancelling first
    // would start an older hosted input before this selected input had even reached its host.
    const waiting = prioritizeHostedInput(session, id, valid)
    const result = withSessionInputDeadline(waiting.done).then(() => ({ ok: true as const }), error => ({ ok: false as const, error }))
    try {
      const input = await releaseQueuedSessionInput(store.runtimeSessionId, turns, id, false, valid)
      if (!input) return
      const outcome = await result
      if (!outcome.ok) throw outcome.error
    } finally { waiting.dispose() }
    return
  }
  if (!steers && session && store.affordances.isWorking) {
    const stopped = await session.cancelTurn()
    if (!stopped.success) throw stopped.error
  }
  await releaseQueuedSessionInput(store.runtimeSessionId, turns, id, steers, valid)
}

function prioritizeHostedInput(session: AcpLiveSession, id: string, valid: () => boolean) {
  let resolve!: () => void, reject!: (error: unknown) => void
  const done = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  let disposed = false, changing = false
  const started = () => session.activeTurn.current()?.items.some(item => item.kind === 'message' && item.role === 'user'
    && (item._meta?.guguClientMessageId === id || item.id === id || item.id.includes(id))) ?? false
  const check = () => {
    if (disposed || changing) return
    if (!valid()) { reject(new Error('Session input account changed')); return }
    if (started()) { resolve(); return }
    const hosted = session.sessionState.current().queuedPrompts.find(input => input.clientMessageId === id)
    if (!hosted) return
    changing = true
    void (async () => {
      const ids = session.sessionState.current().queuedPrompts.map(input => input.id)
      const reordered = await session.changeQueuePromptOrder([hosted.id, ...ids.filter(value => value !== hosted.id)])
      if (!reordered.success) throw reordered.error
      if (disposed || !valid()) throw new Error('Session input account changed')
      if (started()) { resolve(); return }
      // A live-model handoff can remove the queue row before its native echo. Never cancel that input itself.
      if (!session.sessionState.current().queuedPrompts.some(input => input.id === hosted.id)) { changing = false; return }
      const current = session.sessionState.current()
      if (current.lifecycle === 'working' || current.lifecycle === 'cancelling') {
        const stopped = await session.cancelTurn()
        if (!stopped.success) throw stopped.error
      }
      resolve()
    })().catch(reject)
  }
  const stopState = session.sessionState.onChange(check)
  const stopActive = session.activeTurn.onChange(check)
  const stopGone = session.sessionState.onGone(error => reject(error))
  check()
  return { done, dispose() { disposed = true; stopState(); stopActive(); stopGone(); resolve() } }
}
