import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ImageViewerItem } from '@/lib/imageViewer'
import { getRendererSession } from '@/lib/sessionPublication'
import { chatService } from '@/lib/chat'
import { resolveReplyDelivery } from '@gugu/core/shared/replyDelivery'
import { composeInChat } from '@/session/shared/extensions/app-send-core'
import { composeChatDraft } from '@/lib/composeDraft'
import { downloadBlob } from '@/lib/download'
import { writeImageBlobToClipboard } from '@/lib/imageClipboard'
import { messageForUser } from '@/lib/userFacingError'
import { useToast } from '../toastContext'
import { annotateCaption, type AnnotateDocument } from './annotateModel'

export function useAnnotateActions(item: ImageViewerItem, doc: AnnotateDocument, output: () => Promise<Blob>, onDone: () => void) {
  const { t } = useTranslation('main', { keyPrefix: 'imageAnnotate' })
  const { toast } = useToast()
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const running = useRef(false)
  const source = item.source
  const filename = `${item.alt.replace(/\.[^/.]+$/, '') || 'image'}-annotated.png`
  const run = async (operation: () => Promise<void>) => {
    if (running.current) return
    running.current = true; setBusy(true); setError(null)
    try { await operation() }
    catch (failure) { setError(messageForUser(failure)) }
    finally { running.current = false; setBusy(false) }
  }
  const putInComposer = () => run(async () => {
    if (!source) throw new Error(t('noSource'))
    const session = getRendererSession()
    if (!session) throw new Error(t('notSignedIn'))
    const quote = source.messageId ? await chatService.getMessageById(source.messageId, session.user.id) : undefined
    if (source.messageId && (!quote || quote.chat_id !== source.chatId || !resolveReplyDelivery({ senderUserId: session.user.id, source: quote }))) throw new Error(t('originalUnavailable'))
    const blob = await output()
    const detail = await composeInChat({ account: async () => ({ token: session.access_token, userId: session.user.id }) }, {
      chat: source.chatId, text: annotateCaption(doc, ''),
      images: [{ name: filename, type: 'image/png', bytes: await blob.arrayBuffer() }],
    })
    composeChatDraft({ ...detail, ...(quote ? { quote } : {}) })
    onDone()
  })
  const copy = () => run(async () => { await writeImageBlobToClipboard(await output()); toast(t('copied'), 'success') })
  const save = () => run(async () => { if ((await downloadBlob(await output(), filename)).saved) toast(t('saved'), 'success') })
  const saveToFolder = () => run(async () => {
    if (!source) throw new Error(t('noSource'))
    const blob = await output()
    const { saveFilesToChatFolder } = await import('../appSlot/phoneAppHost')
    await saveFilesToChatFolder(source.chatId, [{ name: filename, bytes: await blob.arrayBuffer(), contentType: 'image/png' }], source.messageId ? [source.messageId] : undefined)
    toast(t('savedToFolder'), 'success')
  })
  return { busy, error, putInComposer, copy, save, saveToFolder, canCompose: !!source?.chatId }
}
