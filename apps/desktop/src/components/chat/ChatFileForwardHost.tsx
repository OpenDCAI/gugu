import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { APP_FORWARD_FILES_EVENT, type AppForwardFilesDetail } from '../../session/shared/extensions/app-runtime-protocol'
import { useAuth } from '../../store/auth'
import { useChatStore } from '../../store/chatContext'
import { ForwardMessageDialog } from './ForwardMessageDialog'

/**
 * The folder's 「转发」 (`files.forward`, desktop and phone): the chat's own forward page. Each chat picked gets one file card
 * per file, as forwarding several messages sends one message each; the folder's own chat is left out, as a message's is.
 * A working copy's files are in no chat: what they hold goes as attachments.
 */
export function ChatFileForwardHost() {
  const { t } = useTranslation('messaging')
  const { chats, forwardMessage, sendAttachmentsToChat } = useChatStore('chats', 'forwardMessage', 'sendAttachmentsToChat')
  const { user } = useAuth()
  const [request, setRequest] = useState<Extract<AppForwardFilesDetail, { files: unknown }> | { copies: File[] } | null>(null)
  useEffect(() => {
    // A working copy's bytes become Files at once: kept as they came, a large one would be held twice while the page is up.
    const open = (event: Event) => {
      const detail = (event as CustomEvent<AppForwardFilesDetail>).detail
      setRequest('copies' in detail ? { copies: detail.copies.map(({ name, bytes }) => new File([bytes], name)) } : detail)
    }
    window.addEventListener(APP_FORWARD_FILES_EVENT, open)
    return () => window.removeEventListener(APP_FORWARD_FILES_EVENT, open)
  }, [])
  if (!request || !user) return null
  const forward = async (targetChatIds: string[]) => {
    if ('copies' in request) {
      for (const chatId of targetChatIds) await sendAttachmentsToChat(chatId, request.copies)
      return
    }
    for (const file of request.files) for (const chatId of targetChatIds) await forwardMessage(file, chatId)
  }
  const named = 'copies' in request ? request.copies : request.files
  const [only] = named
  return (
    <ForwardMessageDialog
      chats={chats}
      sourceChatId={'copies' in request ? '' : request.chatId}
      preview={named.length === 1 && only ? only.name : t('forward.filesPreview', { count: named.length })}
      onForward={forward}
      onClose={() => setRequest(null)}
    />
  )
}
