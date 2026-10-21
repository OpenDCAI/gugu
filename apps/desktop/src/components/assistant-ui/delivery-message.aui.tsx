import { MessagePrimitive, useAuiState } from '@assistant-ui/react'
import { useMemo, type ReactElement } from 'react'
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope'
import type { TranscriptTurn } from '@gugu/session-chat-ui'
import { SharedTurnTranscript, useSharedChatRuntime } from './shared-transcript.aui'
import { UserMessage as DefaultUserMessage } from './thread.aui'

/**
 * Keep the assistant-ui message boundary for ordinary user messages. A
 * delivery message (every route the desktop Session page folds into a card, chat
 * and session-direct alike) is the only case that crosses into the shared
 * task-chat renderer, so the mobile Session page does not change the existing
 * Thread layout for regular text, tools, or agent replies.
 */
export function DeliveryMessage(): ReactElement {
  const content = useAuiState((s) => s.message.content)
  const messageId = useAuiState((s) => s.message.id)
  const textPart = content.find((part) => part.type === 'text')
  const text = textPart?.type === 'text' ? textPart.text : ''

  const delivered = useMemo(() => readDeliveryEnvelope(text) !== null, [text])
  if (!delivered) return <DefaultUserMessage />
  return <SharedDeliveryMessage messageId={messageId} text={text} />
}

function SharedDeliveryMessage({
  messageId,
  text
}: {
  messageId: string
  text: string
}): ReactElement {
  const runtime = useSharedChatRuntime()
  const turn = useMemo<TranscriptTurn>(() => ({
    id: `mobile-delivery:${messageId}`,
    seq: 0,
    initiator: 'user',
    items: [{ kind: 'message', id: messageId, seq: 0, role: 'user', text }],
  }), [messageId, text])

  return (
    <MessagePrimitive.Root
      data-slot="aui_delivery-message-root"
      data-testid="mobile-delivery-message"
      data-message-id={messageId}
      className="fade-in slide-in-from-bottom-1 animate-in w-full min-w-0 px-2 duration-150"
      data-role="user"
    >
      {runtime ? <SharedTurnTranscript runtime={runtime} uri={`mobile-delivery:${messageId}`} turn={turn} /> : null}
    </MessagePrimitive.Root>
  )
}
