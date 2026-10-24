import type { MessageItem } from '@gugu/core/shared/types/chat'
import { messageActionItems } from './messageActionItems'
import { useEffect, useState } from 'react'
import type { ParsedAttachment } from '@gugu/core/shared/ui/attachmentModels'
import { useTranslation } from 'react-i18next'
import { downloadBlob } from '../../lib/download'
import { attachmentBytes, attachmentResolver, openAttachmentImage, openAttachmentInSystemApp, sourceKeyOf } from '../../lib/attachmentBytes'
import { rendererLogger } from '../../lib/log'
import { messageForUser } from '../../lib/userFacingError'
import { useToast } from '../toastContext'
import { MessageFilePreviewPanel } from './MessageFilePreviewPanel'
import { classifyDocumentPreview, documentPreviewNeedsFetch, type DocumentPreviewKind } from './documentPreview'

const fileOpenLog = rendererLogger('chat/file-open')

/** 预览、下载、交给系统应用打开的那个文件:名字、类型、大小,和字节从哪来(消息附件或历史「文件」页)。 */
export type PreviewFile = Pick<ParsedAttachment, 'kind' | 'fileName' | 'mimeType' | 'sizeBytes' | 'source'> & { document?: boolean }

/** 预览要读的那份字节:经 lib/attachmentBytes(签名链接 + Cache Storage);条目删了就说出来。 */
async function previewBytes(file: PreviewFile): Promise<Blob> {
  if (file.document && file.source.kind === 'item') {
    const { readChatFolderText } = await import('../../lib/chatFolder')
    const document = await readChatFolderText({ id: file.source.itemId })
    if (!document) throw new Error('gone')
    return new Blob([document.text], { type: file.mimeType })
  }
  const bytes = await attachmentBytes(file.source)
  if (bytes.status === 'gone') throw new Error('gone')
  return bytes.blob
}

/**
 * What a preview of this kind shows (`kind` from `classifyDocumentPreview`): a video, its signed link (<video> reads it in
 * ranges); anything else, its bytes — as text for what is read as text. A file gone throws `gone`. The chat's preview and
 * a peek beside an App (AppPeek) read it this one way.
 */
async function readPreview(file: PreviewFile, kind: DocumentPreviewKind): Promise<{ content: string | ArrayBuffer | null; videoUrl?: string }> {
  if (!documentPreviewNeedsFetch(kind)) {
    const link = await attachmentResolver.resolve(file.source)
    if (link.status === 'gone') throw new Error('gone')
    return { content: null, videoUrl: link.url }
  }
  const blob = await previewBytes(file)
  return { content: kind === 'text' || kind === 'markdown' || kind === 'html' ? await blob.text() : await blob.arrayBuffer() }
}

/** The host's preview wherever a file opens: messages, the chat's folder and an App's peek. */
export function MessageFilePreview({ file, mobile = false, fill = false, tabbed = false, message, onForward, onBack, full, onToggleFull, onClose }: { file: PreviewFile; mobile?: boolean; fill?: boolean; tabbed?: boolean; message?: MessageItem; onForward?: (message: MessageItem) => void; onBack?: () => void; full?: boolean; onToggleFull?: () => void; onClose: () => void }) {
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  const downloadFailed = t('chatArea.downloadFailed')
  const kind = classifyDocumentPreview(file)
  const [read, setRead] = useState<{ content: string | ArrayBuffer | null; videoUrl?: string; error?: string } | null>(null)
  const key = sourceKeyOf(file.source)
  useEffect(() => {
    let live = true
    setRead(null)
    if (kind !== 'unsupported') void (kind === 'image' ? openAttachmentImage(file.source, file.fileName, () => live) : readPreview(file, kind)).then(
      (done) => { if (live) { if (kind === 'image') (onBack ?? onClose)(); else if (done) setRead(done) } },
      (error) => live && setRead({ content: null, error: t(error instanceof Error && error.message === 'gone' ? 'attachmentView.fileGone' : 'attachmentView.fileUnavailable') }),
    )
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- source kind/id/version and the preview kind identify the bytes
  }, [key, kind, file.document, t])
  const openExternal = () => {
    const fileName = kind === 'html' && !/\.html?$/i.test(file.fileName) ? `${file.fileName}.html` : file.fileName
    void openAttachmentInSystemApp(file.source, fileName).catch((error) => {
      fileOpenLog.error({ error }, 'system app handoff failed')
      toast(messageForUser(error, downloadFailed), 'error')
    })
  }
  const download = () => void previewBytes(file).then((blob) => downloadBlob(blob, file.fileName)).catch(() => toast(downloadFailed, 'error'))
  const actions = messageActionItems({ isMine: false, isRetracted: !!message?.retracted_at, content: message?.content ?? null, onForward: message && onForward ? () => onForward(message) : undefined, onDownload: download }, t)
  if (kind === 'image' && !read?.error) return null
  return <MessageFilePreviewPanel fill={fill} tabbed={tabbed} mobile={mobile} file={file} kind={kind} content={read?.content ?? null} videoUrl={read?.videoUrl} loading={kind !== 'unsupported' && read === null} error={read?.error} onBack={onBack} full={full} onToggleFull={onToggleFull} onClose={onClose} actions={actions} onOpenExternal={kind === 'unsupported' || file.document ? undefined : openExternal} />
}
