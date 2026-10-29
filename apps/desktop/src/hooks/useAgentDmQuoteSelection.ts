import { useTranslation } from 'react-i18next'
import type { ChatMessage } from '@gugu/session-chat-ui'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { useAuth } from '../store/auth'
import { useToast } from '../components/toastContext'
import { messageForUser } from '../lib/userFacingError'
import { messageSelectionActionItems } from '../components/chat/messageActionItems'
import { useMessageQuote } from './useMessageQuote'
import { useConversationTextSelection } from './useConversationTextSelection'

/** Prepared for the unified DM host; only explicit provenance may supply an IM reply ID. */
export function useAgentDmQuoteSelection({ chatId, mobile, messages, aliases, names, agentName }: {
  chatId: string
  mobile: boolean
  messages: readonly MessageItem[]
  aliases: ReadonlyMap<string, readonly string[]>
  names: Readonly<Record<string, { display_name: string }>>
  agentName: string
}) {
  const { t } = useTranslation('messaging')
  const { user } = useAuth()
  const { toast } = useToast()
  const quote = useMessageQuote(chatId, id => names[id ?? '']?.display_name ?? (id === user?.id ? user?.nickname ?? '' : agentName), t('chatArea.attachment'))
  const sourceOf = (item: ChatMessage) => {
    const ids = aliases.get(item.id) ?? [item.id]
    return ids.length === 1 ? messages.find(message => message.id === ids[0]) : undefined
  }
  const attach = (item: ChatMessage, text: string, selectionId?: string) => {
    if ((aliases.get(item.id)?.length ?? 1) !== 1) return
    const source = sourceOf(item)
    if (source) quote.onQuote({ ...source, content: text }, { originalContent: source.content, selectionId })
    else quote.setQuote({ senderName: item.role === 'assistant' ? agentName : user?.nickname ?? '', content: text, originalContent: item.text, selectionId })
  }
  const selection = useConversationTextSelection({
    enabled: mobile,
    canSelect: item => {
      if ((aliases.get(item.id)?.length ?? 1) !== 1) return false
      const source = sourceOf(item)
      return !source || (source.content_type === 'text' && !source.retracted_at)
    },
    onQuote: attach,
    onClearQuote: id => quote.setQuote(current => current?.selectionId === id ? null : current),
    actions: (item, text) => messageSelectionActionItems({
      isRetracted: false, content: text, onReply: () => attach(item, text),
      onCopy: () => { void navigator.clipboard.writeText(text).then(
        () => toast(t('message.copied'), 'success'),
        error => toast(t('actions.copyFailed', { ns: 'common' }), 'error', messageForUser(error)),
      ) },
    }, t),
  })
  return { ...selection, quoteContent: quote.quote, onQuoteConsumed: () => quote.setQuote(null) }
}
