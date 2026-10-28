import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { useContactsStore } from '../../store/contactsContext'
import { Markdown } from '../markdown/Markdown'
import { Avatar } from '../Avatar'
import { buildBubbleStyle } from '../chat/messageBubbleStyle'
import { taskExchangeContent } from './taskExchangeContent'
import { MediaAttachmentBubble } from '../chat/MediaAttachmentBubble'
import type { ParsedAttachment } from '@gugu/core/shared/ui/attachmentModels'
import { downloadAttachment } from '../../lib/attachmentBytes'
import './assistant-task-chat.css'

/** Read-only collaboration evidence: it has no IM reactions, delete action, or read watermark. */
export function TaskExchangeBubble({ message, mobile, onOpenFile }: { message: MessageItem; recipientUserId: string; mobile: boolean; onOpenFile?: (file: ParsedAttachment) => void }) {
  const { contacts } = useContactsStore()
  const { t } = useTranslation('assistant')
  const { t: filesT } = useTranslation('messaging')
  const [downloadFailed, setDownloadFailed] = useState(false)
  const content = taskExchangeContent(message.content ?? '')
  const download = async (file: ParsedAttachment) => {
    setDownloadFailed(false)
    try { await downloadAttachment(file.source, file.fileName) } catch { setDownloadFailed(true) }
  }
  const sender = contacts.find((contact) => contact.id === message.sender_user_id)
  if (!content.text && content.files.length === 0 && !content.invalidAttachments) return null
  return <div data-task-exchange="true" data-mobile={mobile || undefined} data-own={message.is_mine || undefined} className="task-exchange">
    <Avatar seed={message.sender_user_id ?? undefined} name={sender?.display_name ?? ''} avatarUrl={sender?.avatar} size="sm" isAgent still harnessBadge={false} />
    <div className="task-exchange__column">
      <div data-message-sender-name="true" className="task-exchange__who">
        {sender?.display_name ?? t('tasks.agent')}
      </div>
      <div style={buildBubbleStyle(message.is_mine, false, mobile)}>
        {content.text && <Markdown trust="chat" content={content.text} />}
        {content.files.map((file, index) => <MediaAttachmentBubble key={`${file.source.kind === 'attachment' ? file.source.attachmentId : index}:${index}`}
          meta={file} messageId={message.id} isMine={message.is_mine} onOpenFile={onOpenFile} onDownload={() => void download(file)} />)}
        {content.invalidAttachments && <span role="alert">{filesT('attachmentView.fileUnavailable')}</span>}
        {downloadFailed && <span role="alert">{filesT('chatArea.downloadFailed')}</span>}
      </div>
    </div>
  </div>
}
