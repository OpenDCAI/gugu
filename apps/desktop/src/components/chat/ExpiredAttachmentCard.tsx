import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ParsedAttachment } from '@gugu/core/shared/ui/attachmentModels'
import { parseAttachmentContent } from '@gugu/core/shared/ui/attachmentModels'
import { attachmentMetadata, cachedAttachmentCopy } from '../../lib/attachmentBytes'
import { attachmentQueryClient } from '../../lib/attachmentQueryClient'
import { chatService } from '../../lib/chat'
import { useAuth } from '../../store/auth'
import { useChatStore } from '../../store/chatContext'
import { useToast } from '../toastContext'
import { Button } from '../ui/Button'
import { FileAttachmentCard } from './FileAttachmentCard'
import { sendAttachmentBatch } from './sendAttachmentBatch'

/** Re-upload is an ordinary new send, with the original message's audience and thread. */
export function ExpiredAttachmentCard({ meta, messageId, isMine }: { meta: ParsedAttachment; messageId: string; isMine: boolean }) {
  const { t } = useTranslation('messaging')
  const { user } = useAuth()
  const { appendMessage } = useChatStore('appendMessage')
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)
  const [needsOriginal, setNeedsOriginal] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const reupload = async (picked?: File) => {
    if (!user || busy) return
    setBusy(true)
    try {
      const original = await chatService.getMessageById(messageId, user.id)
      if (!original || original.sender_user_id !== user.id || original.retracted_at) throw new Error(t('attachmentView.fileGone'))
      const attachment = parseAttachmentContent(original.content, original)
      if (!attachment) throw new Error(t('attachmentView.fileGone'))
      const status = await attachmentMetadata(attachment.source)
      if (status.status !== 'expired') throw new Error(t('attachmentView.fileUnavailable'))
      const local = picked ?? await cachedAttachmentCopy(status.sha256)
      if (!local) { setNeedsOriginal(true); return }
      await sendAttachmentBatch({ files: [new File([local], attachment.fileName, { type: attachment.mimeType })],
        chatId: original.chat_id, senderId: user.id, toUserIds: original.to_user_ids, isWhisper: original.is_whisper,
        threadRootId: original.thread_root_id ?? (original.is_thread_root ? original.id : null), appendMessage })
      await attachmentQueryClient.invalidateQueries({ queryKey: ['attachment-state', user.id] })
    } catch (error) {
      toast(error instanceof Error ? error.message : t('attachmentView.fileUnavailable'), 'error')
    } finally { setBusy(false) }
  }
  return <div>
    <FileAttachmentCard file={meta} isMine={isMine} details={t('attachmentView.fileExpired')} onOpen={() => undefined} />
    {isMine && <>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => needsOriginal ? picker.current?.click() : void reupload()}>{t(needsOriginal ? 'attachmentView.selectOriginal' : 'attachmentView.reupload')}</Button>
      <input ref={picker} type="file" hidden aria-label={t('attachmentView.selectOriginal')} onChange={(event) => {
        const file = event.currentTarget.files?.[0]
        event.currentTarget.value = ''
        if (file) void reupload(file)
      }} />
    </>}
  </div>
}
