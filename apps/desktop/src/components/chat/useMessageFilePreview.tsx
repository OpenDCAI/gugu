import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ParsedAttachment } from '@gugu/core/shared/ui/attachmentModels'
import { downloadBlob } from '../../lib/download'
import { attachmentBytes, attachmentResolver, openAttachmentInSystemApp, sourceKeyOf } from '../../lib/attachmentBytes'
import { MessageFilePreviewPanel } from './MessageFilePreviewPanel'
import { useTranslation } from 'react-i18next'
import { classifyDocumentPreview, documentPreviewNeedsFetch, type DocumentPreviewKind } from './documentPreview'
import { rendererLogger } from '../../lib/log'
import { Sheet } from '../ui/Sheet'
import { messageForUser } from '../../lib/userFacingError'
import { platform } from '../../platform'
import { openGroupFile } from '../markdown/fileLinks'
import { chatClaimantHere } from '../markdown/chatClaimant'
import { typedFileName } from '@/session/shared/extensions/app-runtime-protocol'

const fileOpenLog = rendererLogger('chat/file-open')

/** 预览、下载、交给系统应用打开的那个文件:名字、类型、大小,和字节从哪来(消息附件或历史「文件」页)。 */
export type PreviewFile = Pick<ParsedAttachment, 'kind' | 'fileName' | 'mimeType' | 'sizeBytes' | 'source'>

/** 预览要读的那份字节:经 lib/attachmentBytes(签名链接 + Cache Storage);条目删了就说出来。 */
async function previewBytes(file: PreviewFile): Promise<Blob> {
  const bytes = await attachmentBytes(file.source)
  if (bytes.status === 'gone') throw new Error('gone')
  return bytes.blob
}

/**
 * What a preview of this kind shows (`kind` from `classifyDocumentPreview`): a video, its signed link (<video> reads it in
 * ranges); anything else, its bytes — as text for what is read as text. A file gone throws `gone`. The chat's preview and
 * a peek beside an App (AppPeek) read it this one way.
 */
export async function readPreview(file: PreviewFile, kind: DocumentPreviewKind): Promise<{ content: string | ArrayBuffer | null; videoUrl?: string }> {
  if (!documentPreviewNeedsFetch(kind)) {
    const link = await attachmentResolver.resolve(file.source)
    if (link.status === 'gone') throw new Error('gone')
    return { content: null, videoUrl: link.url }
  }
  const blob = await previewBytes(file)
  return { content: kind === 'text' || kind === 'markdown' || kind === 'html' ? await blob.text() : await blob.arrayBuffer() }
}

type PreviewState = {
  file: PreviewFile
  kind: DocumentPreviewKind
  content: string | ArrayBuffer | null
  /** 视频:签好的链接,<video> 自己分段取(Cache Storage 要整段读进内存,视频不走它)。 */
  videoUrl?: string
  loading: boolean
  error?: string
}

export function useMessageFilePreview({
  mobile,
  visible,
  closeRightSurfaces,
  toast,
  downloadFailed,
}: {
  mobile: boolean
  visible: boolean
  closeRightSurfaces: () => void
  toast: (message: string, kind: 'error') => void
  downloadFailed: string
}) {
  const { t } = useTranslation('messaging')
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const requestRef = useRef<AbortController | null>(null)
  // 预览顶替了谁(目前只有话题分栏):用户点 × 关掉预览时把它还回去。被别的面板挤掉(closeRightSurfaces)时不还。
  const restoreRef = useRef<(() => void) | null>(null)
  const open = useCallback((file: PreviewFile, restore?: () => void) => {
    requestRef.current?.abort()
    // A file of the chat's folder that an App here opens goes to that App, the way a link to it opens (owner 10-19, A);
    // the rest is previewed here or handed to the system.
    if (file.source.kind === 'item' && chatClaimantHere(typedFileName({ name: file.fileName, contentType: file.mimeType }))) {
      requestRef.current = null
      void openGroupFile(file.source.itemId).catch((error) => {
        fileOpenLog.error({ error }, 'opening the file in its App failed')
        toast(messageForUser(error, downloadFailed), 'error')
      })
      return
    }
    const kind = classifyDocumentPreview(file)
    // 交给系统应用打开的文件不占右栏 ⇒ ❌ 不关右栏(曾经先关再判:从话题里点一张 png,话题分栏白白被关掉)。
    if (kind === 'unsupported') {
      requestRef.current = null
      void openAttachmentInSystemApp(file.source, file.fileName)
        .catch((error) => {
          fileOpenLog.error({ error }, 'system app handoff failed')
          toast(messageForUser(error, downloadFailed), 'error')
        })
      return
    }
    closeRightSurfaces()
    restoreRef.current = restore ?? null
    setPreview({ file, kind, content: null, loading: true })
    const request = new AbortController()
    requestRef.current = request
    const key = sourceKeyOf(file.source)
    const settle = (next: Pick<PreviewState, 'content' | 'videoUrl' | 'error'>) => {
      if (requestRef.current !== request) return
      requestRef.current = null
      setPreview((current) => current && sourceKeyOf(current.file.source) === key ? { file, kind, ...next, content: next.content ?? null, loading: false } : current)
    }
    void readPreview(file, kind).then(settle, (error) =>
      settle({ content: null, error: error instanceof Error && error.message === 'gone' ? t('attachmentView.fileGone') : t('attachmentView.fileUnavailable') }))
  }, [closeRightSurfaces, downloadFailed, t, toast])
  const close = useCallback(() => {
    requestRef.current?.abort()
    requestRef.current = null
    restoreRef.current = null
    setPreview(null)
  }, [])
  const closeByUser = useCallback(() => {
    const restore = restoreRef.current
    close()
    restore?.()
  }, [close])
  useEffect(() => () => requestRef.current?.abort(), [])
  // 手机上预览是一层整页 Sheet(返回键先关它);所在聊天页被切走(退回列表、换 tab,页面只隐藏不卸载)时一并关掉,
  // ❌ 留一个看不见、还在出声、还吃返回键的预览。
  useEffect(() => { if (mobile && preview && !visible) close() }, [mobile, preview, visible, close])
  const openExternal = () => {
    if (!preview) return
    if (preview.kind === 'html' && platform.kind === 'electron') {
      const fileName = /\.html?$/i.test(preview.file.fileName) ? preview.file.fileName : `${preview.file.fileName}.html`
      void openAttachmentInSystemApp(preview.file.source, fileName).catch((error) => {
        fileOpenLog.error({ error }, 'cached HTML handoff failed')
        toast(messageForUser(error, downloadFailed), 'error')
      })
      return
    }
    // 浏览器里「在新标签页打开」:给它签好的链接(新标签页不经 Cache Storage)。
    const source = preview.file.source
    void attachmentResolver.resolve(source).then((link) => {
      if (link.status === 'gone') throw new Error('gone')
      window.open(link.url, '_blank', 'noopener,noreferrer')
    }).catch(() => toast(downloadFailed, 'error'))
  }
  const download = () => {
    if (!preview) return
    const { fileName } = preview.file
    void previewBytes(preview.file).then((blob) => downloadBlob(blob, fileName)).catch(() => toast(downloadFailed, 'error'))
  }
  const body = preview && <MessageFilePreviewPanel mobile={mobile} file={preview.file} videoUrl={preview.videoUrl} kind={preview.kind} content={preview.content} loading={preview.loading} error={preview.error} onClose={closeByUser} onDownload={download} onOpenExternal={openExternal} />
  const panel = mobile ? (
    preview && <Sheet fullScreenMobile onClose={closeByUser} ariaLabel={preview.file.fileName} testId="message-file-preview-sheet">{body}</Sheet>
  ) : (
    <AnimatePresence>
      {preview && <motion.div key="message-file-preview-panel" initial={{ x: 380, opacity: 0 }} animate={{ x: 0, opacity: 1 }} transition={{ type: 'tween', duration: 0.2 }} style={{ flexShrink: 0, height: '100%', overflow: 'hidden' }}>
        {body}
      </motion.div>}
    </AnimatePresence>
  )
  return { isOpen: !!preview, open, close, panel }
}
