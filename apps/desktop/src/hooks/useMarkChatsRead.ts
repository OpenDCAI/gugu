import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../store/chatContext'
import { useToast } from '../components/toastContext'
import { markChatsReadAndRefresh } from '../lib/chatUnreadLocator'
import { chatsInReadScope } from '../session/shared/conversation-row-menu'
import { messageForUser } from '../lib/userFacingError'
import { rendererLogger } from '../lib/log'
import { nativeUnreadTargets } from '../lib/nativeUnreadTargets'
import { directoryDevices, directoryRows, liveDeviceSessions } from '../session/shared/remote-sessions/session-directory'
import { platform } from '../platform'

const log = rendererLogger('chat/mark-read')

/** Both scoped and global row actions use the existing stream-watermark writer. */
export function useMarkChatsRead() {
  const { chats, refreshChats } = useChatStore('chats', 'refreshChats')
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  return useCallback((rootId?: string | readonly string[]) => {
    const scope = rootId === undefined ? chats : chatsInReadScope(chats, rootId)
    void (async () => {
      if (rootId !== undefined && [rootId].flat().some((id) => !scope.some((chat) => chat.id === id))) throw new Error('Conversation is not loaded')
      const devices = directoryDevices()
      const localDevice = platform.kind === 'electron' ? devices.find(device => device.is_current_device)?.device_id : undefined
      const nativeReads = nativeUnreadTargets(directoryRows(devices, liveDeviceSessions()), scope, rootId === undefined, localDevice)
      return markChatsReadAndRefresh({ chats: scope, nativeReads, refresh: refreshChats })
    })().then(({ failedChats, error }) => {
      if (failedChats > 0) toast(t('chatList.markAllReadPartial', { count: failedChats }), 'error', messageForUser(error))
    }).catch((error: unknown) => {
      log.error({ error: String(error), chatId: rootId }, 'mark read failed')
      toast(t('chatList.markAllReadFailed'), 'error', messageForUser(error))
    })
  }, [chats, refreshChats, t, toast])
}
