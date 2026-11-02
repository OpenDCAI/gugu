import { pendingPromptLanded, type PendingPrompt } from '@session-chat/state/pending-prompt'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { i18n } from '@/i18n'
import { messageForUser } from './userFacingError'
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

/** One ordinary input follows sender custody, host custody and its native echo without changing its row. */
export function projectSessionPendingInput(previous: PendingPrompt | null, sender: readonly SessionInput[],
  host: readonly HostPendingRow[], turns: readonly TranscriptTurn[]): PendingPrompt | null {
  const input = sender.find(row => row.queued === false && (!previous?.delivery || row.id === previous.id))
  let prompt: PendingPrompt | null = input ? {
    id: input.id, text: input.text, sentAt: input.createdAt, baselineMessageIds: input.baseline, afterTurnId: input.afterTurnId,
    attachments: input.files?.map(file => ({ id: file.itemId, name: file.name, href: `gugu-file://${file.itemId}?v=${file.version}`, kind: file.mimeType.startsWith('image/') ? 'image' : 'file' })),
    held: true, delivery: input.failure ? { state: 'failed', error: sessionInputFailureText(input.failure) } : { state: 'sending' },
  } : previous?.delivery ? { ...previous, held: true, delivery: { state: 'accepted' } } : null
  if (!prompt) return null
  const promptId = prompt.id
  const receipt = host.find(row => row.messageId === promptId)
  if (receipt?.state === 'failed' || receipt?.state === 'unknown') {
    prompt = { ...prompt, delivery: { state: receipt.state, retryable: false, error: receipt.failure ? messageForUser(receipt.failure)
      : i18n.t('message.sendStatus.unknownNotResent', { ns: 'messaging' }) } }
  } else if (receipt?.state === 'accepted' || !input) {
    prompt = { ...prompt, delivery: { state: 'accepted' } }
  }
  return pendingPromptLanded(prompt, turns) ? null : prompt
}
