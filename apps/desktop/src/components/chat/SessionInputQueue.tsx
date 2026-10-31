import { useEffect, useState } from 'react'
import { confirmSessionInputs, retrySessionInputs, useQueuedSessionInputs } from '@/lib/sessionInputOutboxBridge'
import { useTranslation } from 'react-i18next'
import { readMessageQuote } from '@gugu/core/shared/ui/messageQuote'
import { conversationQuoteText } from '@session-chat/state/conversation-quote-text'
import { MessageSendingIndicator } from './MessageSendingIndicator'
import { Button } from '@renderer/lib/ui/button'

const NO_CONFIRMATIONS: readonly string[] = []

/** Still sender-owned, not a claim that the host or model has received it. */
export function SessionInputQueue({ sessionId, confirmedClientMessageIds = NO_CONFIRMATIONS }: { sessionId: string; confirmedClientMessageIds?: readonly string[] }) {
  const pending = useQueuedSessionInputs(sessionId)
  const { t } = useTranslation('messaging')
  const [reconcileError, setReconcileError] = useState<string | null>(null)
  useEffect(() => {
    if (pending.some(input => confirmedClientMessageIds.includes(input.id))) void confirmSessionInputs(sessionId, confirmedClientMessageIds)
      .catch(error => setReconcileError(error instanceof Error ? error.message : String(error)))
  }, [sessionId, pending, confirmedClientMessageIds])
  const visible = pending.filter(input => !confirmedClientMessageIds.includes(input.id))
  const retry = async () => {
    setReconcileError(null)
    try { await retrySessionInputs() }
    catch (error) { setReconcileError(error instanceof Error ? error.message : String(error)) }
  }
  if (!visible.length && !reconcileError) return null
  return <div className="flex flex-col gap-2 px-3 py-2" data-native-input-queue="">
    {reconcileError ? <div role="alert">{reconcileError}</div> : null}
    {visible.map(input => <div key={input.id} className="flex flex-col items-end gap-1" data-native-input-id={input.id}>
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-[var(--radius-thread)] bg-[var(--chat-bubble-user)] px-4 py-2 text-[length:var(--font-body)] text-foreground-muted">
        {conversationQuoteText(readMessageQuote(input.text)?.body ?? input.text)}
        {input.attachments?.map(attachment => <div key={attachment.type === 'attachment' ? attachment.id : attachment.originalPath}>{attachment.name ?? t('message.attachment')}</div>)}
      </div>
      {input.error ? <div className="flex items-center gap-2 text-sm">
        <span role="alert">{input.error}</span>
        <Button size="xs" variant="ghost" onClick={() => { void retry() }}>{t('common.retry')}</Button>
      </div> : <div className="flex items-center gap-1 text-xs text-foreground-muted" role="status">
        <MessageSendingIndicator label={t('message.sendStatus.pending')} />
        {t('message.sendStatus.pending')}
      </div>}
    </div>)}
  </div>
}
