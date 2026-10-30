import type { MessageItem } from '@gugu/core/shared/types/chat'
import { messageActionItems } from './messageActionItems'
import { useEffect, useRef, useState } from 'react'
import { bindFileViewerMenu } from '../preview/file-viewer-menu'
import { quoteChatFile, selectedTextQuote } from '../preview/quote-preview-file'
import type { ParsedAttachment } from '@gugu/core/shared/ui/attachmentModels'
import { useTranslation } from 'react-i18next'
import { downloadBlob } from '../../lib/download'
import { attachmentBytes, attachmentPreview, openAttachmentImage, openAttachmentInSystemApp, sourceKeyOf } from '../../lib/attachmentBytes'
import { rendererLogger } from '../../lib/log'
import { messageForUser } from '../../lib/userFacingError'
import { useToast } from '../toastContext'
import { MessageFilePreviewPanel } from './MessageFilePreviewPanel'
import { classifyDocumentPreview, documentPreviewNeedsFetch, type DocumentPreviewKind } from './documentPreview'
import { savedFileName } from '../../session/shared/extensions/app-runtime-protocol'

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
  if (bytes.status !== 'ready') throw new Error(bytes.status)
  return bytes.blob
}

/**
 * What a preview of this kind shows (`kind` from `classifyDocumentPreview`): a video, its signed link (<video> reads it in
 * ranges); anything else, its bytes — as text for what is read as text. A file gone throws `gone`. The chat's preview and
 * a peek beside an App (AppPeek) read it this one way.
 */
type PreviewRead = { content: string | ArrayBuffer | null; videoUrl?: string; expiresAt?: number; renew?: () => Promise<{ videoUrl: string; expiresAt: number }>; release?: () => Promise<void>; error?: string }
async function readPreview(file: PreviewFile, kind: DocumentPreviewKind): Promise<PreviewRead> {
  if (!documentPreviewNeedsFetch(kind)) {
    const preview = await attachmentPreview(file.source)
    if (preview.status !== 'ready') throw new Error(preview.status)
    let objectUrl: string | undefined
    const renew = async () => {
      const content = await preview.content()
      if (!(content instanceof Blob)) return { videoUrl: content.url, expiresAt: content.expiresAt }
      objectUrl ??= URL.createObjectURL(content)
      return { videoUrl: objectUrl, expiresAt: Infinity }
    }
    const release = async () => { if (objectUrl) URL.revokeObjectURL(objectUrl); await preview.dispose() }
    try { return { content: null, ...await renew(), renew, release } } catch (error) { await release(); throw error }
  }
  const blob = await previewBytes(file)
  return { content: kind === 'text' || kind === 'markdown' || kind === 'html' ? await blob.text() : await blob.arrayBuffer() }
}

/** The host's preview wherever a file opens: messages, the chat's folder and an App's peek. */
export function MessageFilePreview({ file, mobile = false, fill = false, tabbed = false, message, onForward, onBack, onClose }: { file: PreviewFile; mobile?: boolean; fill?: boolean; tabbed?: boolean; message?: MessageItem; onForward?: (message: MessageItem) => void; onBack?: () => void; onClose: () => void }) {
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  const kind = classifyDocumentPreview(file)
  const key = sourceKeyOf(file.source)
  const viewerRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!viewerRef.current || (file.source.kind !== 'item' && !message)) return
    return bindFileViewerMenu(viewerRef.current, () => ({
      resource: file.source.kind === 'item' ? { kind: 'file', target: { kind: 'file', itemId: file.source.itemId, version: file.source.version } } : undefined,
      quote: async (selection) => {
        if (file.source.kind === 'item') return quoteChatFile(file.source.itemId, file.source.version, selection)
        const { UI_EVENTS } = await import('@/lib/uiEvents')
        window.dispatchEvent(new CustomEvent(UI_EVENTS.quoteMessage, { detail: { messageId: message!.id, source: message, senderName: file.fileName, content: selection ? selectedTextQuote(selection) : file.fileName } }))
      },
      canSelectAll: !(mobile && kind === 'html') && kind !== 'image' && kind !== 'video' && kind !== 'unsupported',
    }), (error) => toast(error instanceof Error ? error.message : String(error), 'error'))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- source identity retains the menu snapshot across unrelated renders
  }, [key, file.fileName, message?.id, kind, mobile, toast])
  const [read, setRead] = useState<PreviewRead | null>(null)
  useEffect(() => {
    let live = true, release: PreviewRead['release']
    setRead(null)
    const source = file.source
    const quoteImage = source.kind === 'item' ? () => quoteChatFile(source.itemId, source.version, null) : undefined
    if (kind !== 'unsupported') void (kind === 'image' ? openAttachmentImage(source, file.fileName, () => live, quoteImage) : readPreview(file, kind)).then(
      (done) => { release = done?.release; if (!live) { void release?.(); return } if (kind === 'image') (onBack ?? onClose)(); else if (done) setRead(done) },
      (error) => live && setRead({ content: null, error: t(error instanceof Error && error.message === 'gone' ? 'attachmentView.fileGone' : error instanceof Error && error.message === 'expired' ? 'attachmentView.fileExpired' : 'attachmentView.fileUnavailable') }),
    )
    return () => { live = false; void release?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- source kind/id/version and the preview kind identify the bytes
  }, [key, kind, file.document, t])
  const renewVideo = async (video: HTMLVideoElement) => {
    const current = read
    if (video.dataset.renewing) return
    const fail = () => setRead(row => row === current ? { ...row!, error: t('attachmentView.fileUnavailable') } : row)
    if (!current?.renew || Date.now() < (current.expiresAt ?? Infinity)) { fail(); return }
    video.dataset.renewing = 'true'
    const time = video.currentTime, playing = !video.paused
    try {
      const next = await current.renew()
      video.addEventListener('loadedmetadata', () => { video.currentTime = time; if (playing) void video.play().catch(fail) }, { once: true })
      setRead(row => row === current ? { ...row, ...next } : row)
    } catch { fail() } finally { delete video.dataset.renewing }
  }
  const savedName = savedFileName({ name: file.fileName, contentType: file.mimeType })
  const openExternal = () => {
    void openAttachmentInSystemApp(file.source, savedName).catch((error) => {
      fileOpenLog.error({ error }, 'system app handoff failed')
      toast(t('chatArea.downloadFailed'), 'error', messageForUser(error))
    })
  }
  const download = () => void previewBytes(file).then((blob) => downloadBlob(blob, savedName)).catch((error) => { fileOpenLog.error({ error }, 'preview file download failed'); toast(t('chatArea.downloadFailed'), 'error', messageForUser(error)) })
  const actions = messageActionItems({ isRetracted: !!message?.retracted_at, content: message?.content ?? null, onForward: message && onForward ? () => onForward(message) : undefined, onDownload: download }, t)
  if (kind === 'image' && !read?.error) return null
  return <MessageFilePreviewPanel viewerRef={viewerRef} fill={fill} tabbed={tabbed} mobile={mobile} file={file} kind={kind} content={read?.content ?? null} videoUrl={read?.videoUrl} onVideoError={renewVideo} loading={kind !== 'unsupported' && read === null} error={read?.error} onBack={onBack} onClose={onClose} actions={actions} onOpenExternal={kind === 'unsupported' || file.document ? undefined : openExternal} />
}
