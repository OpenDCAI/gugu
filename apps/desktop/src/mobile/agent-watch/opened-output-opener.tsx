import { platform } from '@/platform'
import { messageForUser } from '@/lib/userFacingError';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { OPENED_FILE_MAX_BYTES } from '@gugu/session-core/session-record/contract'
import type { AttachmentMeta } from '@gugu/core/shared/ui/attachmentModels'
import { formatBytes } from '@renderer/utils/formatBytes'
import { bindFileViewerMenu } from '@/components/preview/file-viewer-menu'
import { workspaceFileQuote } from '@/components/preview/quote-preview-file'
import { MessageFilePreviewPanel } from '@/components/chat/MessageFilePreviewPanel'
import type { DocumentPreviewKind } from '@/components/chat/documentPreview'
import type { OpenedOutput } from '@gugu/session-chat-ui'
import { useToast } from '@/components/toastContext'
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu'
import { Sheet } from '@/components/ui/Sheet'
import { downloadBlob } from '@/lib/download'
import { messageActionItems } from '@/components/chat/messageActionItems'
import { openImageViewer } from '@/lib/imageViewer'
import { rendererLogger } from '@/lib/log'
import type { OpenedOutputHandlers } from './opened-output-handlers'
import { OpenedFileChangedError, phoneOpenPlan, readWholeOpenedFile } from './opened-output-open'
import { readOpenedFileChunk, SessionpageRpcError } from './sessionpage-rpc'

const log = rendererLogger('mobile/opened-output')

type Preview = {
  path: string
  file: AttachmentMeta
  kind: DocumentPreviewKind
  /** 读到的字节;下载就交它。 */
  blob: Blob | null
  content: string | ArrayBuffer | null
  loading: boolean
  /** 读到哪了(从那台电脑分块取,大文件要等一会儿)。还没读到第一块 = 没有。 */
  progress?: { read: number; size: number }
  error?: string
}

/**
 * 手机会话页里点附件卡(#7193):网页交给浏览器;文件从那台电脑现读 —— 读的时候就是一整页预览在转,
 * 读到了图进看图器、文档在这页里画(App 现成的那张预览,与聊天里的附件同一份)。
 * 读不到就在这页里说为什么(那台机器给的原因),❌ 点了没反应。
 */
export function useOpenedOutputOpener({ deviceId, sessionId, onQuote, readFileChunk }: {
  deviceId: string; sessionId: string; onQuote: (text: string) => void
  readFileChunk?: (input: import('@gugu/session-core/session-record/contract').SessionpageOpenedFileReadRequest) => Promise<import('@gugu/session-core/session-record/contract').SessionpageOpenedFileChunk>
}): {
  handlers: OpenedOutputHandlers
  openFile: (path: string) => void
  panel: ReactNode
} {
  const { t } = useTranslation('main')
  const { t: messageT } = useTranslation('messaging')
  const { toast } = useToast()
  const [preview, setPreview] = useState<Preview | null>(null)
  // 卡上「预览 ▾ / 浏览器 ▾」点开的那张打开方式菜单:锚在那枚按钮下面(❌ 底部抽屉)。
  const [menu, setMenu] = useState<{ output: OpenedOutput; anchor: HTMLElement } | null>(null)
  const requestRef = useRef<AbortController | null>(null)
  const blobUrlRef = useRef<{ url: string; image?: { name: string; path: string } } | null>(null)

  const releaseBlobUrl = useCallback(() => {
    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current.url)
    blobUrlRef.current = null
  }, [])

  const close = useCallback(() => {
    requestRef.current?.abort()
    requestRef.current = null
    setPreview(null)
  }, [])

  useEffect(() => () => { requestRef.current?.abort(); releaseBlobUrl() }, [releaseBlobUrl])

  const path = preview?.path
  const previewKind = preview?.kind
  const viewerRef = useCallback((element: HTMLElement | null) => {
    if (!element || !path) return
    return bindFileViewerMenu(element, () => ({
      quote: selection => { onQuote(workspaceFileQuote(path, selection)); close() },
      canSelectAll: previewKind !== 'html' && previewKind !== 'video' && previewKind !== 'unsupported',
    }), error => toast(String(error), 'error'))
  }, [path, previewKind, onQuote, close, toast])

  const describeFailure = useCallback(
    (error: unknown): string => {
      if (error instanceof OpenedFileChangedError) return t('agentWatch.output.fileChanged')
      if (error instanceof SessionpageRpcError) {
        if (error.code === 'file_missing') return t('agentWatch.output.fileMissing')
        if (error.code === 'too_large') return t('agentWatch.output.tooLarge', { limit: formatBytes(OPENED_FILE_MAX_BYTES) })
      }
      return t('agentWatch.output.readFailed')
    },
    [t],
  )

  /** 点整行(默认方式)与菜单里的「下载」共用:`download` = 读到就交给下载,不留预览页。 */
  const openOutput = useCallback(
      (output: OpenedOutput, opts: { download?: boolean } = {}) => {
        const plan = phoneOpenPlan(output)
        if (plan.kind === 'machine-only') return
        if (plan.kind === 'browser') {
          window.open(plan.url, '_blank', 'noopener,noreferrer')
          return
        }
        requestRef.current?.abort()
        releaseBlobUrl()
        const request = new AbortController()
        requestRef.current = request
        const kind: DocumentPreviewKind = plan.view === 'image' ? 'unsupported' : plan.view
        const file: AttachmentMeta = { kind: 'file', fileName: plan.name, mimeType: plan.mimeType, url: '', sizeBytes: 0 }
        setPreview({ path: plan.path, file, kind, blob: null, content: null, loading: true })
        void readWholeOpenedFile({
          read: (chunk) => readFileChunk ? readFileChunk(chunk) : readOpenedFileChunk(deviceId, chunk),
          conversationId: sessionId,
          path: plan.path,
          signal: request.signal,
          onProgress: (read, size) => {
            if (requestRef.current !== request) return
            setPreview((current) => (current && current.loading ? { ...current, progress: { read, size } } : current))
          },
        })
          .then(async (bytes) => {
            if (requestRef.current !== request) return
            requestRef.current = null
            const blob = new Blob([bytes], plan.mimeType ? { type: plan.mimeType } : {})
            if (opts.download) {
              // 读的时候那一页在转,读到就交给下载、页面让位。
              setPreview(null)
              await downloadBlob(blob, plan.name).catch((error: unknown) => {
                log.error({ error, path: plan.path }, 'opened file save failed')
                toast(t('agentWatch.output.saveFailed'), 'error', messageForUser(error))
              })
              return
            }
            const url = URL.createObjectURL(blob)
            blobUrlRef.current = { url, ...(plan.view === 'image' ? { image: { name: plan.name, path: plan.path } } : {}) }
            if (plan.view === 'image') {
              // 图走全 app 唯一的看图器;这一页只是读的时候的等待,读到就让位。
              setPreview(null)
              return
            }
            const content =
              kind === 'text' || kind === 'markdown' || kind === 'html'
                ? new TextDecoder().decode(bytes)
                : kind === 'video' || kind === 'unsupported'
                  ? null
                  : await blob.arrayBuffer()
            setPreview({ path: plan.path, file: { ...file, url, sizeBytes: bytes.length }, kind, blob, content, loading: false })
          })
          .catch((error: unknown) => {
            if (request.signal.aborted || requestRef.current !== request) return
            requestRef.current = null
            log.warn({ error, path: plan.path }, 'opened file read failed')
            setPreview({ path: plan.path, file, kind, blob: null, content: null, loading: false, error: describeFailure(error) })
          })
      },
    [deviceId, sessionId, readFileChunk, releaseBlobUrl, describeFailure, t, toast],
  )

  const copy = useCallback(
    (text: string) => {
      void platform.writeClipboardText(text).then(
        () => toast(t('agentWatch.output.copied')),
        (error: unknown) => {
          log.error({ error }, 'opened-output copy failed')
          toast(t('agentWatch.output.copyFailed'), 'error', messageForUser(error))
        },
      )
    },
    [t, toast],
  )

  const handlers = useMemo<OpenedOutputHandlers>(
    () => ({
      outputUnavailable: (output) => (phoneOpenPlan(output).kind === 'machine-only' ? t('agentWatch.output.machineOnly') : null),
      onOpenOutput: ({ output }) => openOutput(output),
      // 点整行在手机上是什么:文件 = 整页预览,网页 = 交给浏览器。写在下拉钮上。
      outputOpenMode: (output) => {
        const kind = phoneOpenPlan(output).kind
        return kind === 'file' ? t('agentWatch.output.modePreview') : kind === 'browser' ? t('agentWatch.output.modeBrowser') : null
      },
      onOutputMenu: ({ output, anchor }) => setMenu({ output, anchor }),
    }),
    [t, openOutput],
  )

  const menuPlan = menu ? phoneOpenPlan(menu.output) : null
  const menuNode =
    menu && menuPlan && menuPlan.kind !== 'machine-only' ? (
      <Menu anchor={menu.anchor} onClose={() => setMenu(null)} minWidth={180}>
        {menuPlan.kind === 'file' ? (
          <>
            <MenuItem shortcut={t('agentWatch.output.default')} onClick={() => openOutput(menu.output)}>
              {t('agentWatch.output.preview')}
            </MenuItem>
            <MenuSeparator />
            <MenuItem onClick={() => openOutput(menu.output, { download: true })}>{t('agentWatch.output.download')}</MenuItem>
            <MenuItem onClick={() => copy(menuPlan.path)}>{t('agentWatch.output.copyPath')}</MenuItem>
          </>
        ) : (
          <>
            <MenuItem shortcut={t('agentWatch.output.default')} onClick={() => openOutput(menu.output)}>
              {t('agentWatch.output.browser')}
            </MenuItem>
            <MenuSeparator />
            <MenuItem onClick={() => copy(menuPlan.url)}>{t('agentWatch.output.copyLink')}</MenuItem>
          </>
        )}
      </Menu>
    ) : null

  const closed = () => {
    const blob = blobUrlRef.current
    const image = blob?.image
    if (blob && image) openImageViewer([{ url: blob.url, alt: image.name, quote: () => onQuote(workspaceFileQuote(image.path, null)) }])
    else releaseBlobUrl()
  }
  const sheet = (
    <Sheet open={preview !== null} onClosed={closed} fullScreenMobile onClose={close} ariaLabel={preview?.file.fileName} testId="opened-output-preview-sheet">
      {preview ? <MessageFilePreviewPanel
        viewerRef={viewerRef}
        mobile
        file={preview.file}
        videoUrl={preview.file.url || undefined}
        kind={preview.kind}
        content={preview.content}
        loading={preview.loading}
        loadingLabel={
          preview.progress
            ? t('agentWatch.output.reading', { read: formatBytes(preview.progress.read), total: formatBytes(preview.progress.size) })
            : t('agentWatch.output.readingStart')
        }
        {...(preview.progress && preview.progress.size > 0 ? { loadingFraction: preview.progress.read / preview.progress.size } : {})}
        {...(preview.error ? { error: preview.error } : {})}
        onClose={close}
        actions={messageActionItems({ isRetracted: false, content: null, onDownload: preview.blob ? () => void downloadBlob(preview.blob as Blob, preview.file.fileName).catch((error: unknown) => {
          log.error({ error, name: preview.file.fileName }, 'opened file save failed')
          toast(t('agentWatch.output.saveFailed'), 'error', messageForUser(error))
        }) : undefined }, messageT)}
      /> : null}
    </Sheet>
  )

  return {
    handlers,
    openFile: path => openOutput({ kind: 'file', path }),
    panel: (
      <>
        {sheet}
        {menuNode}
      </>
    ),
  }
}
