import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { ChevronLeft, ChevronRight, Maximize2, MinusCircle, Plus } from '@/lib/icons'
import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { useTranslation } from 'react-i18next'
import { usePinchZoom } from '../../hooks/usePinchZoom'
import { Button } from '../ui/Button'
import type { DocumentPreviewKind } from './documentPreview'
import {
  DOCUMENT_MAX_ZOOM,
  DOCUMENT_MIN_ZOOM,
  pinchZoom
} from '@/session/shared/preview/pinch-zoom'
import {
  PREVIEW_LINK_MESSAGE_TYPE,
  SRCDOC_PREVIEW_LINK_SCRIPT,
  toExternalUrl,
} from '@/session/shared/preview/preview-link-script'
import { truncateSheetXml } from './xlsxPreviewLimits'
import './documentPreview.css'

interface DocumentPreviewContentProps {
  kind: DocumentPreviewKind
  content: string | ArrayBuffer | null
  title: string
  /**
   * 交给系统里的 Office / 默认程序打开这个文件。给了,表格太大只显示了一部分时,提示条上就带这个按钮(#7191)。
   */
  onOpenExternally?: () => void
}

type ZipLimits = { maxEntries: number; maxEntryUncompressedBytes: number; maxTotalUncompressedBytes: number }

const DOCX_ZIP_LIMITS: ZipLimits = {
  maxEntries: 4_000,
  maxEntryUncompressedBytes: 32 * 1024 * 1024,
  maxTotalUncompressedBytes: 256 * 1024 * 1024,
}

/**
 * xlsx 一张大表的 XML 解压后动辄几十 MB(本机样本:50 万格 ≈ 11 MB),docx 那份 32 MB 的单项上限会把
 * 「先显示前面一部分」的大表整个挡掉 —— 单项放到与 `@silurus/ooxml` 自己的默认预算一致(128 MiB)。
 */
const XLSX_ZIP_LIMITS: ZipLimits = { ...DOCX_ZIP_LIMITS, maxEntryUncompressedBytes: 128 * 1024 * 1024 }

type ZipEntryMetrics = { dir: boolean; _data?: { uncompressedSize?: number } }

/** 解压之前先按目录里声明的大小核一遍(防压缩炸弹);过了才把归档交出去。 */
async function loadSafeOfficeArchive(data: ArrayBuffer, errorMessage: string, limits: ZipLimits = DOCX_ZIP_LIMITS) {
  const { default: JSZip } = await import('jszip')
  const archive = await JSZip.loadAsync(data)
  const entries = Object.values(archive.files) as ZipEntryMetrics[]
  if (entries.length > limits.maxEntries) throw new Error(errorMessage)
  let totalBytes = 0
  for (const entry of entries) {
    if (entry.dir) continue
    const entryBytes = entry._data?.uncompressedSize ?? 0
    if (entryBytes > limits.maxEntryUncompressedBytes) throw new Error(errorMessage)
    totalBytes += entryBytes
    if (totalBytes > limits.maxTotalUncompressedBytes) throw new Error(errorMessage)
  }
  return archive
}

/**
 * 超过上限的工作表只留前面放得下的整行(见 `xlsxPreviewLimits.ts` 为什么必须在交给库之前做)。
 * 没有一张超的就原样返回同一份字节,不重新打包。
 */
async function fitLargeSheets(data: ArrayBuffer, errorMessage: string): Promise<{ data: ArrayBuffer; truncated: boolean }> {
  const archive = await loadSafeOfficeArchive(data, errorMessage, XLSX_ZIP_LIMITS)
  let truncated = false
  for (const path of Object.keys(archive.files)) {
    if (!/^xl\/worksheets\/[^/]+\.xml$/i.test(path)) continue
    const entry = archive.file(path)
    if (!entry) continue
    const sheet = truncateSheetXml(await entry.async('string'))
    if (!sheet.truncated) continue
    archive.file(path, sheet.xml)
    truncated = true
  }
  if (!truncated) return { data, truncated }
  return { data: await archive.generateAsync({ type: 'arraybuffer', compression: 'STORE' }), truncated }
}

export function DocumentPreviewContent({ kind, content, title, onOpenExternally }: DocumentPreviewContentProps) {
  if (kind === 'html' && typeof content === 'string') return <HtmlPreview content={content} title={title} />
  if (typeof content === 'string') return null
  if (!content) return null
  if (kind === 'docx') return <DocxPreview data={content} onOpenExternally={onOpenExternally} />
  if (kind === 'pdf') return <PdfPreview data={content} />
  if (kind === 'pptx') return <PptxPreview data={content} onOpenExternally={onOpenExternally} />
  if (kind === 'xlsx') return <XlsxPreview data={content} onOpenExternally={onOpenExternally} />
  return null
}

/**
 * 聊天里的 HTML 附件预览。
 *
 * 这一份的内容是一段字符串、盘上没有对应文件,所以它只能走 `srcdoc` —— 而 srcdoc 文档
 * **没有自己的地址**,页面里的每个链接都按宿主页的地址解析:点一个页内锚点会把 iframe 导到
 * 应用页上(预览变白),点一个外链会把外网页面直接加载进这个框里(#6156 实测三条全中)。
 * 所以这里必须自己拦:锚点自己滚,http(s) 递给宿主用系统浏览器开,其余一律不导航。
 *
 * ⚠️ 会话页那边的预览**不用**这一套:它由 `gugu-preview://` 供给、有真地址,锚点归浏览器管。
 * 分界是「这份文档有没有地址」,不是「在哪个界面」。
 */
function HtmlPreview({ content, title }: { content: string; title: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.source !== iframeRef.current?.contentWindow) return
      const data = e.data as { type?: string; href?: string } | null
      if (!data || data.type !== PREVIEW_LINK_MESSAGE_TYPE || typeof data.href !== 'string') return
      const externalUrl = toExternalUrl(data.href)
      // window.open 被主进程的 setWindowOpenHandler 接走 → shell.openExternal。
      // 沙箱 iframe 自己开不了(没有 allow-popups),所以这一步必须由宿主来。
      if (externalUrl) window.open(externalUrl)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  return (
    <iframe
      ref={iframeRef}
      className="document-preview-html"
      sandbox="allow-scripts"
      srcDoc={`${content}\n<script>${SRCDOC_PREVIEW_LINK_SCRIPT}</script>`}
      title={title}
    />
  )
}

function PreviewStatus({ children, error = false }: { children: React.ReactNode; error?: boolean }) {
  return <div className={error ? 'document-preview-status document-preview-status-error' : 'document-preview-status'}>{children}</div>
}

/** 渲染失败:说清原因,并给下一步(交给 Office / 默认程序)—— ❌ 只留一句报错的死路(#7191)。 */
function PreviewFailure({ message, onOpenExternally }: { message: string; onOpenExternally?: () => void }) {
  const { t } = useTranslation('messaging')
  return (
    <PreviewStatus error>
      <span>{message}</span>
      {onOpenExternally ? <Button variant="secondary" size="sm" onClick={onOpenExternally}>{t('chatArea.filePreview.openInOffice')}</Button> : null}
    </PreviewStatus>
  )
}

function DocxPreview({ data, onOpenExternally }: { data: ArrayBuffer; onOpenExternally?: () => void }) {
  const { t } = useTranslation('messaging')
  const bodyRef = useRef<HTMLDivElement>(null)
  const styleRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string>()

  useEffect(() => {
    let active = true
    const body = bodyRef.current
    const styles = styleRef.current
    if (!body || !styles) return
    body.replaceChildren()
    styles.replaceChildren()
    setError(undefined)

    void Promise.all([loadSafeOfficeArchive(data, t('chatArea.filePreview.previewLimits')), import('docx-preview')])
      .then(([, { renderAsync }]) => renderAsync(data.slice(0), body, styles, {
        breakPages: true,
        ignoreHeight: true,
        ignoreLastRenderedPageBreak: false,
        ignoreWidth: true,
        inWrapper: true,
        renderAltChunks: false,
        useBase64URL: true,
      }))
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : t('chatArea.filePreview.renderFailed'))
      })

    return () => {
      active = false
      body.replaceChildren()
      styles.replaceChildren()
    }
  }, [data, t])

  return (
    <div className="document-preview-office" data-testid="docx-preview">
      <div ref={styleRef} />
      {error ? <PreviewFailure message={error} onOpenExternally={onOpenExternally} /> : null}
      <div ref={bodyRef} className="document-preview-docx-body" />
    </div>
  )
}

function PdfPreview({ data }: { data: ArrayBuffer }) {
  const { t } = useTranslation('messaging')
  const viewportRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [document, setDocument] = useState<PDFDocumentProxy>()
  const [pageNumber, setPageNumber] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [availableWidth, setAvailableWidth] = useState(0)
  const [error, setError] = useState<string>()

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const update = () => setAvailableWidth(Math.max(1, viewport.clientWidth - 24))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  // 双指捏合与 −/+ 按钮改的是同一个 zoom,上下限也是同一套(#6456)。
  usePinchZoom(viewportRef, (deltaY) =>
    setZoom((value) => pinchZoom(value, deltaY, DOCUMENT_MIN_ZOOM, DOCUMENT_MAX_ZOOM))
  )

  useEffect(() => {
    let active = true
    let loadingTask: ReturnType<(typeof import('pdfjs-dist'))['getDocument']> | undefined
    setDocument(undefined)
    setPageNumber(1)
    setError(undefined)
    void import('pdfjs-dist/legacy/build/pdf.mjs')
      .then((pdfjs) => {
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
        loadingTask = pdfjs.getDocument({ data: new Uint8Array(data.slice(0)), isEvalSupported: false })
        return loadingTask.promise
      })
      .then((loaded) => {
        if (active) setDocument(loaded)
        else void loaded.destroy()
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : t('chatArea.filePreview.renderFailed'))
      })
    return () => {
      active = false
      void loadingTask?.destroy()
    }
  }, [data, t])

  useEffect(() => {
    if (!document || !availableWidth) return
    let active = true
    let page: PDFPageProxy | undefined
    let renderTask: RenderTask | undefined
    void document.getPage(pageNumber).then((loadedPage) => {
      if (!active) return
      page = loadedPage
      const natural = page.getViewport({ scale: 1 })
      const cssScale = (availableWidth / natural.width) * zoom
      const outputScale = Math.min(window.devicePixelRatio || 1, 2)
      const viewport = page.getViewport({ scale: cssScale * outputScale })
      const canvas = canvasRef.current
      if (!canvas) return
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      canvas.style.width = `${Math.floor(viewport.width / outputScale)}px`
      canvas.style.height = `${Math.floor(viewport.height / outputScale)}px`
      renderTask = page.render({ canvas, viewport })
      return renderTask.promise
    }).catch((cause) => {
      if (active && cause instanceof Error && cause.name !== 'RenderingCancelledException') setError(cause.message)
    })
    return () => {
      active = false
      renderTask?.cancel()
      page?.cleanup()
    }
  }, [availableWidth, document, pageNumber, zoom])

  useEffect(() => () => { void document?.destroy() }, [document])

  const pageCount = document?.numPages ?? 0
  return (
    <div className="document-preview-pdf">
      <div className="document-preview-toolbar" role="toolbar" aria-label={t('chatArea.filePreview.pdfControls')}>
        <Button variant="ghost" size="icon" aria-label={t('chatArea.filePreview.previousPage')} title={t('chatArea.filePreview.previousPage')} disabled={pageNumber <= 1} onClick={() => setPageNumber((page) => Math.max(1, page - 1))}><ChevronLeft size={17} /></Button>
        <span className="document-preview-page-count">{pageCount ? `${pageNumber} / ${pageCount}` : '–'}</span>
        <Button variant="ghost" size="icon" aria-label={t('chatArea.filePreview.nextPage')} title={t('chatArea.filePreview.nextPage')} disabled={!pageCount || pageNumber >= pageCount} onClick={() => setPageNumber((page) => Math.min(pageCount, page + 1))}><ChevronRight size={17} /></Button>
        <span className="document-preview-toolbar-divider" />
        <Button variant="ghost" size="icon" aria-label={t('chatArea.filePreview.zoomOut')} title={t('chatArea.filePreview.zoomOut')} disabled={zoom <= DOCUMENT_MIN_ZOOM} onClick={() => setZoom((value) => Math.max(DOCUMENT_MIN_ZOOM, value - 0.25))}><MinusCircle size={17} /></Button>
        <span className="document-preview-zoom">{Math.round(zoom * 100)}%</span>
        <Button variant="ghost" size="icon" aria-label={t('chatArea.filePreview.zoomIn')} title={t('chatArea.filePreview.zoomIn')} disabled={zoom >= DOCUMENT_MAX_ZOOM} onClick={() => setZoom((value) => Math.min(DOCUMENT_MAX_ZOOM, value + 0.25))}><Plus size={17} /></Button>
        <Button variant="ghost" size="icon" aria-label={t('chatArea.filePreview.fitWidth')} title={t('chatArea.filePreview.fitWidth')} onClick={() => setZoom(1)}><Maximize2 size={17} /></Button>
      </div>
      <div ref={viewportRef} className="document-preview-pdf-viewport">
        {error ? <PreviewStatus error>{error}</PreviewStatus> : !document ? <PreviewStatus><LoadingIndicator size="inline" />{t('chatArea.filePreview.rendering')}</PreviewStatus> : null}
        <canvas ref={canvasRef} aria-label={t('chatArea.filePreview.pdfPage', { page: pageNumber })} />
      </div>
    </div>
  )
}

function PptxPreview({ data, onOpenExternally }: { data: ArrayBuffer; onOpenExternally?: () => void }) {
  const { t } = useTranslation('messaging')
  const containerRef = useRef<HTMLDivElement>(null)
  const [rendering, setRendering] = useState(true)
  const [error, setError] = useState<string>()

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const controller = new AbortController()
    let viewer: import('@aiden0z/pptx-renderer').PptxViewer | undefined
    setRendering(true)
    setError(undefined)
    container.replaceChildren()
    void import('@aiden0z/pptx-renderer/browser')
      .then(({ PptxViewer, RECOMMENDED_ZIP_LIMITS }) => PptxViewer.open(data.slice(0), container, {
        fitMode: 'contain',
        lazyMedia: true,
        lazySlides: true,
        listOptions: { batchSize: 3, initialSlides: 3, windowed: true },
        pdfjs: false,
        renderMode: 'list',
        scrollContainer: container,
        signal: controller.signal,
        zipLimits: RECOMMENDED_ZIP_LIMITS,
      }))
      .then((loaded) => {
        if (controller.signal.aborted) {
          loaded.destroy()
          return
        }
        viewer = loaded
        setRendering(false)
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setRendering(false)
          setError(cause instanceof Error ? cause.message : t('chatArea.filePreview.renderFailed'))
        }
      })
    return () => {
      controller.abort()
      viewer?.destroy()
      container.replaceChildren()
    }
  }, [data, t])

  return (
    <div className="document-preview-pptx-shell">
      {rendering ? <PreviewStatus><LoadingIndicator size="inline" />{t('chatArea.filePreview.rendering')}</PreviewStatus> : null}
      {error ? <PreviewFailure message={error} onOpenExternally={onOpenExternally} /> : null}
      <div ref={containerRef} className="document-preview-pptx" />
    </div>
  )
}

/**
 * #7191 Excel 预览:`@silurus/ooxml`(MIT)。owner 2026-10-15 选它:本机同一份样表(合并单元格、填充色、
 * ¥ / % / 中文日期格式、公式结果、冻结表头、图表、中文)对比几个开源库,它全对,默认不联网,本身只读。
 * 表格太大时只显示前面一部分,并在顶上明说、给出「用 Office 打开」(owner 同日:「超出的部分显示不全,
 * 建议 Office 软件打开就好了,这样可以预览」)。
 */
function XlsxPreview({ data, onOpenExternally }: { data: ArrayBuffer; onOpenExternally?: () => void }) {
  const { t } = useTranslation('messaging')
  const containerRef = useRef<HTMLDivElement>(null)
  const [rendering, setRendering] = useState(true)
  const [error, setError] = useState<string>()
  const [truncated, setTruncated] = useState(false)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let active = true
    let viewer: import('@silurus/ooxml/xlsx').XlsxViewer | undefined
    setRendering(true)
    setError(undefined)
    setTruncated(false)
    container.replaceChildren()
    void (async () => {
      const prepared = await fitLargeSheets(data, t('chatArea.filePreview.previewLimits'))
      const { XlsxViewer } = await import('@silurus/ooxml/xlsx')
      if (!active) return
      // cjkFallback 'sc':中文缺字时按简体中文挑字体。`useGoogleFonts` 保持默认关 —— 开了会去请求 fonts.googleapis.com。
      viewer = new XlsxViewer(container, { cjkFallback: 'sc' })
      await viewer.load(prepared.data)
      if (!active) return
      setTruncated(prepared.truncated)
      setRendering(false)
    })().catch((cause: unknown) => {
      if (!active) return
      setRendering(false)
      setError(cause instanceof Error ? cause.message : t('chatArea.filePreview.renderFailed'))
    })
    return () => {
      active = false
      viewer?.destroy()
      container.replaceChildren()
    }
  }, [data, t])

  return (
    <div className="document-preview-xlsx-shell" data-testid="xlsx-preview">
      {truncated ? (
        <div className="document-preview-notice" role="status" data-testid="xlsx-preview-truncated">
          <span>{t('chatArea.filePreview.sheetTruncated')}</span>
          {onOpenExternally ? (
            <Button variant="secondary" size="sm" onClick={onOpenExternally}>{t('chatArea.filePreview.openInOffice')}</Button>
          ) : null}
        </div>
      ) : null}
      {rendering ? <PreviewStatus><LoadingIndicator size="inline" />{t('chatArea.filePreview.rendering')}</PreviewStatus> : null}
      {error ? <PreviewFailure message={error} onOpenExternally={onOpenExternally} /> : null}
      <div ref={containerRef} className="document-preview-xlsx" />
    </div>
  )
}
