import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { APP_FORWARD_FILES_EVENT, type AppForwardFilesDetail } from '../../session/shared/extensions/app-runtime-protocol'
import { useAuth } from '../../store/auth'
import { useChatStore } from '../../store/chatContext'
import { ForwardMessageDialog } from './ForwardMessageDialog'

/**
 * The folder's 「转发」 (`files.forward`, desktop and phone): the chat's own forward page. Each chat picked gets one file card
 * per file, as forwarding several messages sends one message each; the folder's own chat is left out, as a message's is.
 */
export function ChatFileForwardHost() {
  const { t } = useTranslation('messaging')
  const { chats, forwardMessage } = useChatStore('chats', 'forwardMessage')
  const { user } = useAuth()
  const [request, setRequest] = useState<AppForwardFilesDetail | null>(null)
  useEffect(() => {
    const open = (event: Event) => setRequest((event as CustomEvent<AppForwardFilesDetail>).detail)
    window.addEventListener(APP_FORWARD_FILES_EVENT, open)
    return () => window.removeEventListener(APP_FORWARD_FILES_EVENT, open)
  }, [])
  if (!request || !user) return null
  const forward = async (targetChatIds: string[]) => {
    for (const file of request.files) for (const chatId of targetChatIds) await forwardMessage(file, chatId)
  }
  const [only] = request.files
  return (
    <ForwardMessageDialog
      chats={chats}
      sourceChatId={request.chatId}
      preview={request.files.length === 1 && only ? only.name : t('forward.filesPreview', { count: request.files.length })}
      onForward={forward}
      onClose={() => setRequest(null)}
    />
  )
}
