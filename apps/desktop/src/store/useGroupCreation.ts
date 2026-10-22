import { useCallback, type Dispatch, type SetStateAction } from 'react'
import { createOptimisticGroupChat, upsertChatRow } from '@gugu/core/shared/ui/chatModels'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import type { ToastType } from '../components/toastContext'
import { i18n } from '../i18n'
import { chatService } from '../lib/chat'

export function useGroupCreation({ userId, loadChats, setChats, toast }: {
  userId: string | null
  loadChats: () => Promise<unknown>
  setChats: Dispatch<SetStateAction<ChatItem[]>>
  toast: (message: string, type?: ToastType) => void
}) {
  return useCallback(async (name: string, memberIds: string[], groupPrompt?: string | null): Promise<string> => {
    if (!userId) throw new Error('Not authenticated')
    const result = await chatService.createGroupChat(name, userId, memberIds, groupPrompt)
    if (result.invitation_errors.length) {
      toast(i18n.t('createGroup.invitesFailed', { ns: 'contacts', count: result.invitation_errors.length }), 'error')
    } else if (result.invitations.length) {
      toast(i18n.t('createGroup.invitesSent', { ns: 'contacts', count: result.invitations.length }), 'success')
    }
    await loadChats()
    setChats((prev) => upsertChatRow(prev, createOptimisticGroupChat(result.chat_id, name)))
    return result.chat_id
  }, [userId, loadChats, setChats, toast])
}
