import { useTranslation } from 'react-i18next'
import { useAssistantConversationProgress } from './assistantConversationProgressContext'

/** Small evidence-backed preface; missing record data never becomes a fabricated duration. */
export function AssistantReplyProcess({ messageId }: { messageId?: string }) {
  const { t } = useTranslation('assistant')
  const context = useAssistantConversationProgress()
  const process = messageId ? context?.replies.get(messageId) : null
  if (!process || (!process.thoughts && !process.tools)) return null
  const parts: string[] = []
  if (process.thoughts) parts.push(process.thinkingMs > 0
    ? t('chat.thoughtSeconds', { seconds: Math.max(1, Math.round(process.thinkingMs / 1_000)) })
    : t('chat.thoughtCount', { count: process.thoughts }))
  if (process.tools) parts.push(t('chat.toolCount', { count: process.tools }))
  return <span className="assistant-reply-process" data-testid="assistant-reply-process">{parts.join(' · ')}</span>
}
