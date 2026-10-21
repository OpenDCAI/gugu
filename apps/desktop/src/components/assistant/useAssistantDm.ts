import { useEffect, useState } from 'react'
import { createOptimisticDmChat } from '@gugu/core/shared/ui/chatModels'
import { chatService } from '../../lib/chat'
import { rendererLogger } from '../../lib/log'
import { useAuth } from '../../store/auth'
import { useChatStore } from '../../store/chatContext'

const dmLog = rendererLogger('assistant/chat')

export type AssistantDm = { chatId: string | null; failed: boolean; retry: () => void }

/**
 * #7199 和个人助理的那条私聊;还没有就建一条(与通讯录「发消息」同一个 getOrCreateDM)。
 * 壳挂着就认出来(AssistantShellHost):聊天格子画它,「今天」页读它的文件夹(today.json),同一条。
 */
export function useAssistantDm(assistantId: string | null): AssistantDm {
  const { user } = useAuth()
  const { chats, upsertChat, refreshChats } = useChatStore('chats', 'upsertChat', 'refreshChats')
  const existing = assistantId
    ? chats.find((chat) => (chat.kind === 'dm' || chat.kind === 'ai') && chat.peer_user_id === assistantId)?.id ?? null
    : null
  const [created, setCreated] = useState<{ agentId: string; chatId: string } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [failedAttempt, setFailedAttempt] = useState<number | null>(null)
  const userId = user?.id ?? null
  useEffect(() => {
    if (existing || !userId || !assistantId) return
    let cancelled = false
    chatService.getOrCreateDM(userId, assistantId)
      .then((chatId) => {
        if (cancelled) return
        upsertChat(createOptimisticDmChat(chatId, assistantId))
        setCreated({ agentId: assistantId, chatId })
        void refreshChats()
      })
      .catch((error: unknown) => {
        if (cancelled) return
        dmLog.error({ error: String(error), assistantId }, 'open assistant dm failed')
        setFailedAttempt(attempt)
      })
    return () => { cancelled = true }
  }, [existing, userId, assistantId, attempt, upsertChat, refreshChats])
  const chatId = existing ?? (assistantId && created?.agentId === assistantId ? created.chatId : null)
  return { chatId, failed: chatId === null && failedAttempt === attempt, retry: () => setAttempt((n) => n + 1) }
}
