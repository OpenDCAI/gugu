import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import type { ConversationQueueTarget } from '@/components/chat/useConversationQueue'
import { changeConversationQueue } from '@/components/assistant/assistantTimelineClient'
import { releaseQueuedSessionInput, state } from '@/lib/sessionInputOutboxBridge'
import { sessionInputFailureText } from '@/lib/pendingSessionInput'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { phoneTimelineClient } from '../local-agent/phoneTimelineClient'

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
  const snapshot = await phoneTimelineClient.fetchSnapshot(target.deviceId, target.sessionId, 100)
  if (!current()) throw new Error('Session input account changed')
  const hosted = snapshot.queuedPrompts?.find(prompt => prompt.clientMessageId === id)
  if (hosted) {
    await changeConversationQueue(target.local, target.deviceId, target.sessionId, { kind: 'send-now', id: hosted.id, steers }, true)
  } else if (!snapshot.turns.some(turn => turn.items.some(item => item.kind === 'message' && item.role === 'user' && item._meta?.guguClientMessageId === id))) {
    throw new Error(sessionInputFailureText({ code: 'phone-unconfirmed' }))
  }
}
