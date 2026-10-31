import { useQueuedSessionInputs } from '@/lib/sessionInputOutboxBridge'
import { useTranslation } from 'react-i18next'
import { readMessageQuote } from '@gugu/core/shared/ui/messageQuote'
import { conversationQuoteText } from '@session-chat/state/conversation-quote-text'
import { MessageSendingIndicator } from './MessageSendingIndicator'

/** Still sender-owned, not a claim that the host or model has received it. */
export function SessionInputQueue({ sessionId, waitingForConnection }: { sessionId: string; waitingForConnection: boolean }) {
  const pending = useQueuedSessionInputs(sessionId)
  const { t } = useTranslation('messaging')
  if (!waitingForConnection || !pending.length) return null
  return <div className="flex flex-col gap-2 px-3 py-2" data-native-input-queue="">
    {pending.map(input => <div key={input.id} className="flex items-end justify-end gap-1" data-native-input-id={input.id}>
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-[var(--radius-thread)] bg-[var(--chat-bubble-user)] px-4 py-2 text-[length:var(--font-body)] text-[var(--chat-bubble-user-fg)]">
        {conversationQuoteText(readMessageQuote(input.text)?.body ?? input.text)}
      </div>
      <MessageSendingIndicator label={t('message.sendStatus.sending')} />
    </div>)}
  </div>
}
