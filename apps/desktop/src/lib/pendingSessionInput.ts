import { pendingPromptLanded, type PendingPrompt } from '@session-chat/state/pending-prompt'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { i18n } from '@/i18n'
import { messageForUser } from './userFacingError'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import type { HostPendingRow, SessionInput, SessionInputFailure } from './sessionInputOutbox'

export function sessionInputBaseline(turns: readonly TranscriptTurn[]): Pick<SessionInput, 'baseline' | 'afterTurnId'> {
  return { baseline: turns.flatMap(turn => turn.items.flatMap(item => item.kind === 'message' && item.role === 'user' ? [item.id] : [])),
    afterTurnId: turns.at(-1)?.id }
}

export function sessionInputFailureText(failure: SessionInputFailure): string {
  if (failure.code === 'send-failed') return messageForUser(failure.message)
  const key = { 'host-offline': 'hostOffline', 'host-not-ready': 'hostNotReady',
    'phone-unconfirmed': 'phoneUnconfirmed', 'no-acknowledgement': 'noAcknowledgement' }[failure.code]
  return i18n.t(`message.sendStatus.failure.${key}`, { ns: 'messaging' })
}

/** A short attempt status; custody is determined by the retained sender row, never this label. */
export function sessionInputWaitingReason(failure: SessionInputFailure): string {
  const key = failure.code === 'host-offline' ? 'transcript.waitingHostOffline'
    : failure.code === 'host-not-ready' ? 'transcript.waitingHostNotReady'
    : failure.code === 'send-failed' ? 'transcript.waitingSendInterrupted' : 'transcript.waitingAcknowledgement'
  return translateSessionMessage(key)
}

/** One ordinary input follows sender custody, host custody and its native echo without changing its row. */
export function projectSessionPendingInput(previous: PendingPrompt | null, sender: readonly SessionInput[],
  host: readonly HostPendingRow[], turns: readonly TranscriptTurn[]): PendingPrompt | null {
  if (sender.some(row => row.id === previous?.id && row.admission === 'rejected')) previous = null
  const ordinary = sender.filter(row => row.admission !== 'rejected' && row.queued === false && !row.sendQueue)
  const terminal = previous?.delivery?.state === 'failed' || previous?.delivery?.state === 'unknown'
  const input = ordinary.find(row => !previous?.delivery || row.id === previous.id)
    ?? (terminal ? ordinary.find(row => row.id !== previous?.id) : undefined)
  let prompt: PendingPrompt | null = input ? {
    id: input.id, text: input.text, sentAt: input.createdAt, baselineMessageIds: input.baseline, afterTurnId: input.afterTurnId,
    attachments: input.files?.map(file => ({ id: file.itemId, name: file.name, href: `gugu-file://${file.itemId}?v=${file.version}`, kind: file.mimeType.startsWith('image/') ? 'image' : 'file' })),
    held: true, delivery: input.failure ? { state: 'waiting', retryable: false, reason: sessionInputWaitingReason(input.failure), error: sessionInputFailureText(input.failure) } : { state: 'sending' },
  } : previous?.delivery && !(previous.delivery.state === 'failed' && previous.delivery.retryable === true)
    ? { ...previous, held: true, delivery: { state: 'receiving' } } : null
  if (!prompt) return null
  const promptId = prompt.id
  const receipt = host.find(row => row.messageId === promptId)
  if (receipt?.state === 'failed' || receipt?.state === 'unknown') {
    prompt = { ...prompt, delivery: { state: receipt.state, retryable: false, error: receipt.failure ? messageForUser(receipt.failure)
      : i18n.t('message.sendStatus.unknownNotResent', { ns: 'messaging' }) } }
  } else if (receipt || !input) {
    prompt = { ...prompt, delivery: { state: 'receiving' } }
  }
  return pendingPromptLanded(prompt, turns) ? null : prompt
}

/** Rejected inputs use ordinary transcript messages, including more than one refusal for a task. */
export function projectRejectedSessionInputs(sender: readonly SessionInput[], turns: readonly TranscriptTurn[]): PendingPrompt[] {
  return sender.filter(input => input.admission === 'rejected').flatMap(input => {
    const prompt: PendingPrompt = { id: input.id, text: input.text, sentAt: input.createdAt, held: true, senderRejected: true,
      baselineMessageIds: input.baseline, afterTurnId: input.afterTurnId,
      attachments: input.files?.map(file => ({ id: file.itemId, name: file.name, href: `gugu-file://${file.itemId}?v=${file.version}`, kind: file.mimeType.startsWith('image/') ? 'image' : 'file' })),
      delivery: { state: 'failed', retryable: true, reason: input.failure ? sessionInputFailureText(input.failure) : undefined,
        error: input.failure ? sessionInputFailureText(input.failure) : undefined } }
    return pendingPromptLanded(prompt, turns) ? [] : [prompt]
  })
}
