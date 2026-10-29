import { useQueuedSessionInputs } from '@/lib/sessionInputOutboxBridge'
import { translateSessionMessage } from '@/session/renderer/localization/locale-store'
import { readMessageQuote } from '@gugu/core/shared/ui/messageQuote'
import { conversationQuoteText } from '@session-chat/state/conversation-quote-text'

/** Still sender-owned, not a claim that the host or model has received it. */
export function SessionInputQueue({ sessionId }: { sessionId: string }) {
  const pending = useQueuedSessionInputs(sessionId)
  if (!pending.length) return null
  return <div role="status" className="px-3 py-2 text-sm" data-native-input-queue="">
    <div>{translateSessionMessage('composer.waitingForHost')}</div>
    {pending.map(input => <div key={input.id} className="truncate" data-native-input-id={input.id}>{conversationQuoteText(readMessageQuote(input.text)?.body ?? input.text)}</div>)}
  </div>
}
