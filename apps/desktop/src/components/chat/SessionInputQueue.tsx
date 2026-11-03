import { retrySessionInputs, useQueuedSessionInputs } from '@/lib/sessionInputOutboxBridge'
import { sessionInputBubbles } from '@/lib/sessionInputOutbox'
import type { LifeView } from '@/session/shared/core/sessions/session-life'
import { useTranslation } from 'react-i18next'
import { readMessageQuote } from '@gugu/core/shared/ui/messageQuote'
import { conversationQuoteText } from '@session-chat/state/conversation-quote-text'
import { MessageSendingIndicator } from './MessageSendingIndicator'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { messageForUser } from '@/lib/userFacingError'
import { sessionInputFailureText, sessionInputWaitingReason } from '@/lib/pendingSessionInput'
import { useMobileShell } from '@/hooks/useMobileShell'
import { toast } from '@renderer/lib/hooks/use-toast'
import { Button } from '@/components/ui/Button'

/**
 * The person's inputs not yet in the transcript, each drawn from its one custody owner (`sessionInputBubbles`):
 * the sender outbox row (shown while `waitingForConnection`), then the host's session_pending row of the session's `life`.
 */
export function SessionInputQueue({ sessionId, waitingForConnection, life = null, inTranscript = [] }: {
  sessionId: string; waitingForConnection: boolean; life?: LifeView | null
  /** Inputs already drawn in the transcript: one place per message. */
  inTranscript?: readonly string[]
}) {
  const pending = useQueuedSessionInputs(sessionId)
  const { t } = useTranslation('messaging')
  const mobile = useMobileShell()
  const queuedFailures = new Map(mobile ? pending.filter(input => input.queued === true && input.failure
    && !life?.pending.items.some(row => row.messageId === input.id)).map(input => [input.id, input.failure!]) : [])
  const sender = pending.filter(input => (waitingForConnection || queuedFailures.has(input.id))
    && (!mobile || input.queued !== true || input.failure))
  const retry = () => { void retrySessionInputs().catch(error => toast({ title: translateSessionMessage('acpFailure.sendMessage'), description: messageForUser(error), variant: 'destructive' })) }
  const bubbles = sessionInputBubbles(sender, life?.pending.items ?? [], life?.hold ?? null)
    .filter(bubble => !inTranscript.includes(bubble.id) && !pending.some(input => input.id === bubble.id && input.queued === false))
  if (!bubbles.length) return null
  return <div className="flex flex-col gap-2 px-3 py-2" data-native-input-queue="">
    {bubbles.map(bubble => <div key={bubble.id} className="flex flex-col items-end gap-1" data-native-input-id={bubble.id}>
      <div className="flex items-end justify-end gap-1">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-[var(--radius-thread)] bg-[var(--chat-bubble-user)] px-4 py-2 text-[length:var(--font-body)] text-[var(--chat-bubble-user-fg)]">
          {bubble.from ? <div className="text-xs text-foreground-muted" data-delivered-from="">{t('message.deliveredFrom', { name: bubble.from })}</div> : null}
          {conversationQuoteText(readMessageQuote(bubble.text)?.body ?? bubble.text)}
        </div>
        {bubble.state === 'sending' ? <MessageSendingIndicator label={t('message.sendStatus.sending')} /> : null}
      </div>
      {queuedFailures.has(bubble.id) ? <div className="flex items-center gap-2 text-xs text-[var(--danger-fg)]" role="alert" data-send-state="failed">
        <span>{t('message.sendStatus.failed')} · {sessionInputFailureText(queuedFailures.get(bubble.id)!)}</span>
        <Button type="button" variant="ghost" size="sm" className="shrink-0 text-[var(--danger-fg)]" onClick={retry}>{translateSessionMessage('transcript.retrySend')}</Button>
      </div> : bubble.state === 'waiting' ? <div className="text-xs text-foreground-muted" role="status" data-send-state="waiting" title={sessionInputFailureText(bubble.failure)}>{translateSessionMessage('transcript.waitingToSend')} · {sessionInputWaitingReason(bubble.failure)}</div> : null}
      {bubble.state === 'stopped' ? <div className="text-xs text-foreground-muted" role="status" data-send-state="stopped">{t('message.sendStatus.stopped')}</div> : null}
      {bubble.state === 'failed' ? <div className="flex items-center gap-2 text-sm">
        <span role="alert">{bubble.hostReason ? messageForUser(bubble.hostReason) : t('message.sendStatus.failed')}</span>
      </div> : null}
      {bubble.state === 'unknown' ? <div className="text-xs text-foreground-muted" role="status">{t('message.sendStatus.unknownNotResent')}</div> : null}
    </div>)}
  </div>
}
