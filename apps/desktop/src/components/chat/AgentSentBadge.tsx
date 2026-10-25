import { messageForUser } from '@/lib/userFacingError';
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { createOptimisticDmChat } from '@gugu/core/shared/ui/chatModels'
import { useAuth } from '../../store/auth'
import { useChatStore } from '../../store/chatContext'
import { chatService } from '../../lib/chat'
import { Button } from '../ui/Button'
import { useToast } from '../toastContext'

/** Source metadata is private on the server. Received messages render only the public marker. */
export function AgentSentBadge({ source }: { source: MessageItem['agent_sender'] }) {
  const { t } = useTranslation('messaging')
  if (!source) return <span className="px-[2px] text-[length:var(--font-caption)] leading-[var(--lh-caption)] text-[var(--faint-fg)]" data-ai-sent="true">{t('message.aiSent')}</span>
  return <SendingAgentLink key={source.id ?? source.name} source={source} />
}

function SendingAgentLink({ source }: { source: NonNullable<MessageItem['agent_sender']> }) {
  const { t } = useTranslation('messaging')
  const { user } = useAuth()
  const { upsertChat, setActiveChatId, refreshChats } = useChatStore('upsertChat', 'setActiveChatId', 'refreshChats')
  const { toast } = useToast()
  const [opening, setOpening] = useState(false)
  const label = t('message.agentSentForYou', { agent: source.name })
  if (!source.id) return <span data-ai-sent="true" title={t('message.sendingAgentRemoved')} className="px-[2px] text-[length:var(--font-caption)] leading-[var(--lh-caption)] text-[var(--faint-fg)]">{label} · {t('message.sendingAgentRemoved')}</span>

  async function open() {
    if (!user || !source.id || opening) return
    setOpening(true)
    try {
      const chatId = await chatService.getOrCreateDM(user.id, source.id)
      upsertChat(createOptimisticDmChat(chatId, source.id))
      setActiveChatId(chatId)
      await refreshChats()
    } catch (error) { console.error(error);
      toast(messageForUser(error), 'error')
    } finally {
      setOpening(false)
    }
  }
  return (
    <Button variant="ghost" size="sm" data-ai-sent="true" disabled={opening}
      title={t('message.openSendingAgent', { agent: source.name })} onClick={() => { void open() }}
      className="max-w-full whitespace-normal text-right px-[2px] text-[length:var(--font-caption)] leading-[var(--lh-caption)] text-[var(--faint-fg)]"
    >{label}</Button>
  )
}
