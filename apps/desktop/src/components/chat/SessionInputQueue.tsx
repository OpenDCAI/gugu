import { useState } from 'react'
import { retrySessionInputs, useQueuedSessionInputs } from '@/lib/sessionInputOutboxBridge'
import { sessionInputBubbles, type HostPendingRow, type SessionInputFailure } from '@/lib/sessionInputOutbox'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { readMessageQuote } from '@gugu/core/shared/ui/messageQuote'
import { conversationQuoteText } from '@session-chat/state/conversation-quote-text'
import { MessageSendingIndicator } from './MessageSendingIndicator'
import { Button } from '@renderer/lib/ui/button'
import { messageForUser } from '@/lib/userFacingError'

const NO_HOST_ROWS: readonly HostPendingRow[] = []

/**
 * The person's inputs not yet in the transcript, each drawn from its one custody owner (`sessionInputBubbles`):
 * the sender outbox row (shown while `waitingForConnection`), then the host's session_pending row.
 */
export function SessionInputQueue({ sessionId, waitingForConnection, host = NO_HOST_ROWS }: {
  sessionId: string; waitingForConnection: boolean; host?: readonly HostPendingRow[]
}) {
  const pending = useQueuedSessionInputs(sessionId)
  const { t } = useTranslation('messaging')
  const [retryError, setRetryError] = useState<string | null>(null)
  const bubbles = sessionInputBubbles(waitingForConnection ? pending : [], host)
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
          {conversationQuoteText(readMessageQuote(bubble.text)?.body ?? bubble.text)}
        </div>
        {bubble.state === 'sending' ? <MessageSendingIndicator label={t('message.sendStatus.sending')} /> : null}
      </div>
      {bubble.state === 'failed' ? <div className="flex items-center gap-2 text-sm">
        <span role="alert">{bubble.failure ? failureText(bubble.failure, t) : bubble.hostReason ? messageForUser(bubble.hostReason) : t('message.sendStatus.failed')}</span>
        {bubble.failure ? <Button size="xs" variant="ghost" onClick={() => { void retry() }}>{t('common.retry')}</Button> : null}
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
