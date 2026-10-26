import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../store/chatContext'
import { useToast } from '../components/toastContext'
import { markChatsReadAndRefresh } from '../lib/chatUnreadLocator'
import { chatsInReadScope } from '../session/shared/conversation-row-menu'
import { messageForUser } from '../lib/userFacingError'
import { rendererLogger } from '../lib/log'

const log = rendererLogger('chat/mark-read')

/** Both scoped and global row actions use the existing stream-watermark writer. */
export function useMarkChatsRead() {
  const { chats, refreshChats } = useChatStore('chats', 'refreshChats')
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  return useCallback((rootId?: string) => {
    const scope = rootId === undefined ? chats : chatsInReadScope(chats, rootId)
    void Promise.resolve().then(() => {
      if (rootId !== undefined && !scope.some((chat) => chat.id === rootId)) throw new Error('Conversation is not loaded')
      return markChatsReadAndRefresh({ chats: scope, refresh: refreshChats })
    }).then(({ failedChats, error }) => {
      if (failedChats > 0) toast(t('chatList.markAllReadPartial', { count: failedChats }), 'error', messageForUser(error))
    }).catch((error: unknown) => {
      log.error({ error: String(error), chatId: rootId }, 'mark read failed')
      toast(t('chatList.markAllReadFailed'), 'error', messageForUser(error))
    })
  }, [chats, refreshChats, t, toast])
}
