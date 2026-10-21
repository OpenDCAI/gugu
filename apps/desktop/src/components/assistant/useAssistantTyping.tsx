import { useEffect, useRef, type ReactNode } from 'react'
import { useAgentReplyPending } from '../chat/useAgentReplyPending'
import { AssistantTyping } from './AssistantTyping'
import { assistantReplyActivity } from './assistantReplyActivity'
import { useAssistantConversationProgress } from './assistantConversationProgressContext'

/** The private chat's one host subscription supplies actual source-bound progress. */
export function useAssistantTyping(chatId: string | null, assistantId: string | null, name: string): ReactNode {
  const { pending, awaitingMessageId } = useAgentReplyPending(chatId, assistantId)
  const progress = useAssistantConversationProgress()
  const retriedInput = useRef<string | null>(null)
  const retry = progress?.retryMissingRecord
  useEffect(() => {
    const key = `${chatId}/${awaitingMessageId}`
    if (pending && awaitingMessageId && retry && retriedInput.current !== key) {
      retriedInput.current = key
      retry()
    }
  }, [chatId, awaitingMessageId, pending, retry])
  if (!pending || !awaitingMessageId) return null
  const activity = awaitingMessageId ? assistantReplyActivity(progress?.live ?? null, awaitingMessageId) : null
  return <AssistantTyping pending={pending} name={name} activity={activity} />
}
