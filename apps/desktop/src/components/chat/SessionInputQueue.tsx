import { useState } from 'react'
import { retrySessionInputs, useQueuedSessionInputs } from '@/lib/sessionInputOutboxBridge'
import { sessionInputBubbles, type SessionInputFailure } from '@/lib/sessionInputOutbox'
import type { LifeView } from '@/session/shared/core/sessions/session-life'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { readMessageQuote } from '@gugu/core/shared/ui/messageQuote'
import { conversationQuoteText } from '@session-chat/state/conversation-quote-text'
import { MessageSendingIndicator } from './MessageSendingIndicator'
import { Button } from '@renderer/lib/ui/button'
import { messageForUser } from '@/lib/userFacingError'

/**
 * The person's inputs not yet in the transcript, each drawn from its one custody owner (`sessionInputBubbles`):
 * the sender outbox row (shown while `waitingForConnection`), then the host's session_pending row of the session's `life`.
 */
export function SessionInputQueue({ sessionId, waitingForConnection, life = null, inTranscript = null }: {
  sessionId: string; waitingForConnection: boolean; life?: LifeView | null
  /** The row the transcript already draws as its next turn: one place per message. */
  inTranscript?: string | null
}) {
  const pending = useQueuedSessionInputs(sessionId)
  const { t } = useTranslation('messaging')
  const [retryError, setRetryError] = useState<string | null>(null)
  const bubbles = sessionInputBubbles(waitingForConnection ? pending : [], life?.pending.items ?? [], life?.kind ?? null)
    .filter(bubble => bubble.id !== inTranscript)
  if (!bubbles.length && !retryError) return null
  const retry = async () => {
    setRetryError(null)
    try { await retrySessionInputs() }
    catch (error) { setRetryError(messageForUser(error)) }
  }
  return <div className="flex flex-col gap-2 px-3 py-2" data-native-input-queue="">
    {retryError ? <div role="alert">{retryError}</div> : null}
    {bubbles.map(bubble => <div key={bubble.id} className="flex flex-col items-end gap-1" data-native-input-id={bubble.id}>
      <div className="flex items-end justify-end gap-1">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-[var(--radius-thread)] bg-[var(--chat-bubble-user)] px-4 py-2 text-[length:var(--font-body)] text-[var(--chat-bubble-user-fg)]">
          {bubble.from ? <div className="text-xs text-foreground-muted" data-delivered-from="">{t('message.deliveredFrom', { name: bubble.from })}</div> : null}
          {conversationQuoteText(readMessageQuote(bubble.text)?.body ?? bubble.text)}
        </div>
        {bubble.state === 'sending' ? <MessageSendingIndicator label={t('message.sendStatus.sending')} /> : null}
      </div>
      {bubble.state === 'held' ? <div className="text-xs text-foreground-muted" role="status" data-send-state="held">{t('message.sendStatus.held')}</div> : null}
      {bubble.state === 'failed' ? <div className="flex items-center gap-2 text-sm">
        <span role="alert">{bubble.failure ? failureText(bubble.failure, t) : bubble.hostReason ? messageForUser(bubble.hostReason) : t('message.sendStatus.failed')}</span>
        {/* A host that is offline gets the input once it is back: no retry to press. */}
        {bubble.failure && bubble.failure.code !== 'host-offline' ? <Button size="xs" variant="ghost" onClick={() => { void retry() }}>{t('common.retry')}</Button> : null}
      </div> : null}
      {bubble.state === 'unknown' ? <div className="text-xs text-foreground-muted" role="status">{t('message.sendStatus.unknownNotResent')}</div> : null}
    </div>)}
  </div>
}

function failureText(failure: SessionInputFailure, t: TFunction<'messaging'>): string {
  switch (failure.code) {
    case 'host-offline': return t('message.sendStatus.failure.hostOffline')
    case 'host-not-ready': return t('message.sendStatus.failure.hostNotReady')
    case 'phone-unconfirmed': return t('message.sendStatus.failure.phoneUnconfirmed')
    case 'no-acknowledgement': return t('message.sendStatus.failure.noAcknowledgement')
    case 'send-failed': return messageForUser(failure.message)
  }
}
