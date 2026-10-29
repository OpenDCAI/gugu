import { messageForUser } from '@/lib/userFacingError';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type PhotoSwipe from 'photoswipe'
import type { Bounds, PhotoSwipeOptions, SlideData } from 'photoswipe'
import 'photoswipe/style.css'
import './imagePreview.css'
import { X, Download, Copy, ChevronLeft, ChevronRight, Pencil } from '@/lib/icons'
import { DUR_SLOW_MS, EASE } from '@/styles/motion'
import { useToast } from './toastContext'
import { useBackLayer } from './ui/sheetStack'
import { IconButton } from './ui/IconButton'
import { bindFileViewerMenu } from './preview/file-viewer-menu'
import { quoteChatFile } from './preview/quote-preview-file'
import { AUTOMATION_TEST_IDS } from '../lib/automationDom'
import { fetchBlob, downloadRemoteFile } from '../lib/download'
import { canWriteImageToClipboard, writeImageBlobToClipboard } from '../lib/imageClipboard'
import { rendererLogger } from '../lib/log'
import { safeFailureLine } from '@/session/renderer/features/sessions/gugu-reason'
import { UiPortalContainerProvider } from '@gugu/session-ui/react/primitives'
import { commandRegistry } from '@renderer/lib/commands/registry'
import { useMobileShell } from '../hooks/useMobileShell'
import { readRendererPlatform, windowTitlebarHeight } from '../lib/window-chrome'
import {
  decodedSizeOf,
  downloadNameFor,
  isLongImage,
  registerImageViewerHost,
  thumbBoundsFor,
  zoomLevelsFor,
  type ImageViewerItem,
  type ImageViewerRequest,
} from '../lib/imageViewer'

// 全 app 唯一的看图查看器(PhotoSwipe)的宿主:把请求翻成 PhotoSwipe 选项、把工具栏 portal 进它的根、
// 查看器开着时接住返回键与 Esc。调用方经 lib/imageViewer 进来。

const log = rendererLogger('media/image-viewer')
const AnnotateEditor = lazy(() => import('./imageAnnotate/AnnotateEditor'))
/** PhotoSwipe 处理完的方向键不再冒泡到底下的页面。 */
const VIEWER_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])
const PRELOADER_DELAY_MS = 300
/**
 * 查看器的根铺在 Windows 标题栏行下面(tokens.css @@@window-layer),而 PhotoSwipe 默认把整个窗口当视口、
 * 指针与缩略图都按窗口坐标算。它的三处几何都要换成「根的盒子」:视口高度、指针偏移、起落位置。其余平台是 0。
 */
const viewerTop = () => windowTitlebarHeight(readRendererPlatform())
const DOUBLE_CLICK_MS = 300

async function fetchImageAsPngBlob(url: string): Promise<Blob> {
  const blob = await fetchBlob(url)
  if (blob.type === 'image/png') return blob
  return new Promise<Blob>((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    const objectUrl = URL.createObjectURL(blob)
    const settle = (fn: () => void) => {
      URL.revokeObjectURL(objectUrl)
      fn()
    }
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('canvas getContext failed')
        ctx.drawImage(img, 0, 0)
        canvas.toBlob((b) => {
          if (b) settle(() => resolve(b))
          else settle(() => reject(new Error('canvas toBlob failed')))
        }, 'image/png')
      } catch (err) {
        // onload 里抛出的异常不会传给 Promise executor,不显式 reject 调用方会永远挂起
        settle(() => reject(err))
      }
    }
    img.onerror = () => settle(() => reject(new Error('image load failed')))
    img.src = objectUrl
  })
}

type ViewerSlide = SlideData & { item: ImageViewerItem; sizeKnown: boolean }

function slideFor(item: ImageViewerItem): ViewerSlide {
  const size = decodedSizeOf(item.thumb)
  return {
    src: item.url,
    alt: item.alt,
    // 尺寸未知时按视口占位(宽为 0 PhotoSwipe 不加载图),loadComplete 里回填真尺寸
    width: size?.width ?? window.innerWidth,
    height: size?.height ?? window.innerHeight,
    msrc: size ? item.url : undefined,
    item,
    sizeKnown: Boolean(size),
  }
}

/** env(safe-area-inset-*) 在 JS 里读不到,借探针元素算成 px。 */
function readSafeAreaInsets(): { top: number; bottom: number } {
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;visibility:hidden;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)'
  document.body.append(probe)
  const style = getComputedStyle(probe)
  const insets = { top: parseFloat(style.paddingTop) || 0, bottom: parseFloat(style.paddingBottom) || 0 }
  probe.remove()
  return insets
}

function zoomOption(pick: 'initial' | 'secondary' | 'max'): PhotoSwipeOptions['initialZoomLevel'] {
  return ({ elementSize, panAreaSize, fit }) => {
    if (!elementSize || !panAreaSize) throw new Error('PhotoSwipe asked for zoom levels before measuring the slide')
    return zoomLevelsFor({ width: elementSize.x, height: elementSize.y }, { width: panAreaSize.x, height: panAreaSize.y }, fit)[pick]
  }
}

function viewerOptions(request: ImageViewerRequest, mobile: boolean, errorMsg: string): PhotoSwipeOptions {
  const safeArea = mobile ? readSafeAreaInsets() : null
  return {
    dataSource: request.items.map(slideFor),
    index: request.index,
    mainClass: 'gg-image-viewer',
    showHideAnimationType: 'zoom',
    showAnimationDuration: DUR_SLOW_MS,
    hideAnimationDuration: DUR_SLOW_MS,
    zoomAnimationDuration: DUR_SLOW_MS,
    easing: `cubic-bezier(${EASE.join(', ')})`,
    bgOpacity: mobile ? 1 : 0.9,
    loop: false,
    escKey: false,
    wheelToZoom: true,
    tapAction: 'close',
    errorMsg,
    zoom: false,
    close: false,
    counter: false,
    arrowPrev: false,
    arrowNext: false,
    preloaderDelay: PRELOADER_DELAY_MS,
    padding: safeArea ? { top: safeArea.top, bottom: safeArea.bottom, left: 0, right: 0 } : { top: 64, bottom: 48, left: 16, right: 16 },
    getViewportSizeFn: () => ({ x: document.documentElement.clientWidth, y: window.innerHeight - viewerTop() }),
    initialZoomLevel: zoomOption('initial'),
    secondaryZoomLevel: zoomOption('secondary'),
    maxZoomLevel: zoomOption('max'),
  }
}

function wireViewer(pswp: PhotoSwipe, dialogLabel: string): void {
  // 缩略图打开的那几张:翻到哪张,取哪张的原图,换上(取不到就留着缩略图;item.full 自己记着结果,不重复下)。
  const upgrade = (index: number) => {
    const slides = pswp.options.dataSource
    const data = (Array.isArray(slides) ? slides[index] : undefined) as ViewerSlide | undefined
    const full = data?.item.full
    if (!data || !full) return
    full().then((url) => {
      if (data.src === url) return
      data.src = url
      data.item.url = url
      pswp.refreshSlideContent(index)
    }, (error: unknown) => log.warn({ error: String(error) }, 'full image unavailable; keeping the thumbnail'))
  }
  pswp.on('afterInit', () => upgrade(pswp.currIndex))
  pswp.on('change', () => upgrade(pswp.currIndex))
  pswp.on('loadComplete', ({ content, isError }) => {
    const data = content.data as ViewerSlide
    const img = content.element
    if (isError || data.sizeKnown || !(img instanceof HTMLImageElement) || img.naturalWidth === 0) return
    data.width = img.naturalWidth
    data.height = img.naturalHeight
    data.sizeKnown = true
    pswp.refreshSlideContent(content.index)
  })

  // undefined = 没有起落位置,PhotoSwipe 退成淡入淡出(它自己的实现也这样返回,只是类型没写)
  pswp.addFilter('thumbBounds', (_bounds, itemData) => {
    const data = itemData as ViewerSlide
    const thumb = data.item.thumb
    const img = thumb instanceof HTMLImageElement ? thumb : thumb?.querySelector('img')
    if (!img || !data.sizeKnown) return undefined as unknown as Bounds
    const size = { width: data.width ?? 0, height: data.height ?? 0 }
    const rect = img.getBoundingClientRect()
    const top = viewerTop()
    const inViewer = new DOMRect(rect.x, rect.y - top, rect.width, rect.height)
    return thumbBoundsFor(inViewer, getComputedStyle(img).objectFit, size, { width: innerWidth, height: innerHeight - top }) as Bounds
  })

  // 指针点 = pageY - offset.y:根下移了,offset 也跟着下移。PhotoSwipe 的 init 在派发 updateScrollOffset 之后
  // 又直写了一次 offset.y(不派发),所以在紧跟着的 initialLayout 里再对齐一次。
  const alignPointerOffset = () => { pswp.offset.y = window.pageYOffset + viewerTop() }
  pswp.on('updateScrollOffset', alignPointerOffset)
  pswp.on('initialLayout', alignPointerOffset)

  const isLongSlide = (slide: NonNullable<PhotoSwipe['currSlide']>) =>
    Boolean(slide.width) && isLongImage(slide, { width: slide.panAreaSize.x, height: slide.panAreaSize.y })

  // 长图从顶端开始读;桌面滚轮在长图上是往下读,按住 ctrl(触控板捏合)才缩放
  pswp.on('initialZoomPan', ({ slide }) => {
    if (isLongSlide(slide)) slide.pan.y = slide.bounds.min.y
  })
  pswp.on('wheel', (event) => {
    const slide = pswp.currSlide
    const wheel = event.originalEvent
    if (!slide || wheel.ctrlKey || !slide.isPannable() || !isLongSlide(slide)) return
    event.preventDefault()
    slide.panTo(slide.pan.x - wheel.deltaX, slide.pan.y - wheel.deltaY)
  })

  // 桌面:单击图不做事,双击缩放到光标处(PhotoSwipe 默认单击就缩放,双击会放大又缩回)
  let lastImageClick = -Infinity
  pswp.on('imageClickAction', (event) => {
    event.preventDefault()
    const at = event.originalEvent.timeStamp
    if (at - lastImageClick > DOUBLE_CLICK_MS) {
      lastImageClick = at
      return
    }
    lastImageClick = -Infinity
    const { x, y } = event.point
    if (x === undefined || y === undefined) throw new Error('PhotoSwipe reported an image click without a point')
    pswp.currSlide?.toggleZoom({ x, y })
  })

  pswp.on('keydown', ({ originalEvent }) => {
    if (VIEWER_KEYS.has(originalEvent.key)) originalEvent.stopPropagation()
  })

  // slideActivate 不为打开时的第一张触发,所以按 change 标当前图
  const markCurrentImage = () => {
    pswp.element?.querySelectorAll(`[data-testid="${AUTOMATION_TEST_IDS.imagePreviewImage}"]`).forEach((el) => el.removeAttribute('data-testid'))
    pswp.currSlide?.content.element?.setAttribute('data-testid', AUTOMATION_TEST_IDS.imagePreviewImage)
  }
  pswp.on('change', markCurrentImage)
  pswp.on('afterInit', () => {
    const root = pswp.element
    if (!root) return
    root.setAttribute('data-testid', AUTOMATION_TEST_IDS.imagePreviewOverlay)
    root.setAttribute('aria-modal', 'true')
    root.setAttribute('aria-label', dialogLabel)
    root.classList.add('window-no-drag-region')
    markCurrentImage()
  })
}

interface OpenViewer {
  pswp: PhotoSwipe
  root: HTMLElement
  items: ImageViewerItem[]
  index: number
}

function ViewerButton({ label, testId, className, side, onClick, children }: {
  label: string
  testId: string
  className?: string
  side?: 'prev' | 'next'
  onClick: () => void
  children: ReactNode
}) {
  return (
    <IconButton aria-label={label} data-testid={testId} data-side={side} className={`gg-image-viewer__btn ${className ?? ''}`} size="lg" onClick={onClick}>
      {children}
    </IconButton>
  )
}

function ImageViewerChrome({ viewer, mobile, onEdit }: { viewer: OpenViewer; mobile: boolean; onEdit: () => void }) {
  const { t } = useTranslation('main')
  const { toast } = useToast()
  const [copying, setCopying] = useState(false)
  const { pswp, items, index } = viewer
  const current = items[index]

  const handleDownload = useCallback(async () => {
    try {
      await downloadRemoteFile(current.full ? await current.full() : current.url, downloadNameFor(current))
    } catch (error) {
      rendererLogger('chat/file-open').error({ error }, 'image download failed')
      toast(t('shell.imagePreview.downloadFailed'), 'error', safeFailureLine(String((error as Error)?.message ?? error)))
    }
  }, [current, t, toast])

  const handleCopy = useCallback(async () => {
    if (copying) return
    if (!canWriteImageToClipboard()) {
      toast(t('shell.imagePreview.copyUnsupported'), 'error')
      return
    }
    setCopying(true)
    try {
      // blob-first(#1892):先 await 拿到 Blob 再写剪贴板
      await writeImageBlobToClipboard(await fetchImageAsPngBlob(current.full ? await current.full() : current.url))
      toast(t('shell.imagePreview.copied'), 'success')
    } catch (error) {
      toast(t('shell.imagePreview.copyFailed'), 'error', safeFailureLine(String((error as Error)?.message ?? error)))
    } finally {
      setCopying(false)
    }
  }, [copying, current, t, toast])

  // 手机的出口是左上返回箭头,桌面是右上 ✕;手机上滑动切图,不画箭头
  const close = (
    <ViewerButton label={t('shell.imagePreview.close')} testId={AUTOMATION_TEST_IDS.imagePreviewClose} onClick={() => pswp.close()}>
      {mobile ? <ChevronLeft /> : <X />}
    </ViewerButton>
  )
  return (
    <div className="gg-image-viewer__chrome pswp__hide-on-close" data-mobile={mobile || undefined}>
      <div className="gg-image-viewer__bar">
        {mobile ? close : null}
        <div className="gg-image-viewer__spacer" />
        <ViewerButton label={t('imageAnnotate.edit')} testId="image-preview-edit" onClick={onEdit}><Pencil /></ViewerButton>
        <ViewerButton label={t('shell.imagePreview.copy')} testId={AUTOMATION_TEST_IDS.imagePreviewCopy} onClick={() => void handleCopy()}>
          <Copy />
        </ViewerButton>
        <ViewerButton label={t('shell.imagePreview.download')} testId={AUTOMATION_TEST_IDS.imagePreviewDownload} onClick={() => void handleDownload()}>
          <Download />
        </ViewerButton>
        {mobile ? null : close}
      </div>
      {!mobile && index > 0 ? (
        <ViewerButton label={t('shell.imagePreview.previous')} testId={AUTOMATION_TEST_IDS.imagePreviewPrev} className="gg-image-viewer__arrow" side="prev" onClick={() => pswp.prev()}>
          <ChevronLeft />
        </ViewerButton>
      ) : null}
      {!mobile && index < items.length - 1 ? (
        <ViewerButton label={t('shell.imagePreview.next')} testId={AUTOMATION_TEST_IDS.imagePreviewNext} className="gg-image-viewer__arrow" side="next" onClick={() => pswp.next()}>
          <ChevronRight />
        </ViewerButton>
      ) : null}
      {items.length > 1 ? <div className="gg-image-viewer__counter">{index + 1} / {items.length}</div> : null}
    </div>
  )
}

export function ImagePreviewProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation('main')
  const mobile = useMobileShell()
  const { toast } = useToast()
  const [viewer, setViewer] = useState<OpenViewer | null>(null)
  const [editing, setEditing] = useState<ImageViewerItem | null>(null)
  const annotating = editing !== null
  useLayoutEffect(() => {
    if (!annotating) return
    const paused = commandRegistry.shortcutsPaused
    commandRegistry.setShortcutsPaused(true)
    return () => commandRegistry.setShortcutsPaused(paused)
  }, [annotating])
  // 宿主只登记一次,打开时读最新的形态与文案
  const latest = useRef({ t, mobile, toast })
  latest.current = { t, mobile, toast }

  useEffect(() => {
    let active: PhotoSwipe | null = null
    let disposed = false
    const unregister = registerImageViewerHost((request) => {
      import('photoswipe')
        .then(({ default: PhotoSwipeCtor }) => {
          if (disposed) return
          const { t: translate, mobile: isMobile } = latest.current
          active?.destroy()
          const pswp = new PhotoSwipeCtor(viewerOptions(request, isMobile, translate('shell.imagePreview.loadFailed')))
          wireViewer(pswp, translate('shell.imagePreview.dialog'))
          let unbindMenu: (() => void) | undefined
          const bindMenu = () => {
            unbindMenu?.()
            const { quote, resource } = request.items[pswp.currIndex] ?? {}
            unbindMenu = (quote || resource) && pswp.element ? bindFileViewerMenu(pswp.element, () => ({ resource, quote: () => {
              pswp.close()
              if (quote) return quote()
              if (resource?.target.kind === 'file' && resource.target.version !== undefined) return quoteChatFile(resource.target.itemId, resource.target.version, null)
              throw new Error('This image has no file reference to quote')
            }, canSelectAll: false }), (error) => {
              log.error({ error: String(error) }, 'image citation failed')
              latest.current.toast(String(error), 'error')
            }) : undefined
          }
          pswp.on('change', () => {
            bindMenu()
            setViewer((open) => (open?.pswp === pswp ? { ...open, index: pswp.currIndex } : open))
          })
          pswp.on('destroy', () => {
            unbindMenu?.()
            if (active === pswp) active = null
            setViewer((open) => (open?.pswp === pswp ? null : open))
            setEditing(null)
          })
          active = pswp
          pswp.init()
          if (!pswp.element) throw new Error('PhotoSwipe did not create its root element')
          bindMenu()
          setViewer({ pswp, root: pswp.element, items: request.items, index: pswp.currIndex })
        })
        .catch((error: unknown) => {
          log.error({ error: String(error), count: request.items.length }, 'failed to open image viewer')
          latest.current.toast(latest.current.t('shell.imagePreview.openFailed'), 'error', messageForUser(error))
        })
    })
    return () => {
      disposed = true
      unregister()
      active?.destroy()
    }
  }, [])

  const openPswp = viewer?.pswp
  // 开着的查看器与 Sheet 同进一个栈:返回键 / Esc 只归栈顶,MainLayout 见 isSheetOpen() 就不动下面的页面
  const isTopLayer = useBackLayer(openPswp ? () => editing ? setEditing(null) : openPswp.close() : undefined)
  useEffect(() => {
    if (!viewer || !editing) return
    const previous = viewer.pswp.options.arrowKeys
    const label = viewer.root.getAttribute('aria-label')
    viewer.pswp.options.arrowKeys = false
    viewer.root.dataset.annotating = 'true'
    viewer.root.setAttribute('aria-label', t('imageAnnotate.title'))
    return () => {
      viewer.pswp.options.arrowKeys = previous
      delete viewer.root.dataset.annotating
      if (label) viewer.root.setAttribute('aria-label', label)
      viewer.root.focus()
    }
  }, [viewer, editing, t])
  useEffect(() => {
    if (!viewer || editing) return
    const editKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.key.toLowerCase() !== 'e' || !isTopLayer()) return
      if (event.target instanceof HTMLElement && event.target.closest('input,textarea,[contenteditable="true"]')) return
      event.preventDefault(); event.stopPropagation(); setEditing(viewer.items[viewer.index])
    }
    window.addEventListener('keydown', editKey, true)
    return () => window.removeEventListener('keydown', editKey, true)
  }, [viewer, editing, isTopLayer])
  useEffect(() => {
    if (!openPswp) return
    // Esc:不在栈里的 Base UI 对话框在 document 上听 Esc。window 捕获阶段先于所有 document 监听,
    // 在这里关查看器并截住这一下,压在下面的对话框才不会跟着关。
    const onEscapeCapture = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || !isTopLayer()) return
      event.stopPropagation()
      event.preventDefault()
      if (editing && event.target instanceof HTMLElement && event.target.closest('input,textarea,[contenteditable="true"]')) {
        event.target.blur()
        viewer?.root.querySelector<HTMLElement>('.ia-editor')?.focus()
      } else if (editing) setEditing(null)
      else openPswp.close()
    }
    window.addEventListener('keydown', onEscapeCapture, { capture: true })
    return () => window.removeEventListener('keydown', onEscapeCapture, { capture: true })
  }, [openPswp, editing, isTopLayer, viewer])

  return (
    <>
      {children}
      {viewer ? createPortal(editing ? <Suspense fallback={<div role="status">{t('imageAnnotate.loading')}</div>}>
        <UiPortalContainerProvider value={viewer.root}><AnnotateEditor item={editing} mobile={mobile} onCancel={() => setEditing(null)} onDone={() => viewer.pswp.close()} /></UiPortalContainerProvider>
      </Suspense> : <ImageViewerChrome viewer={viewer} mobile={mobile} onEdit={() => setEditing(viewer.items[viewer.index])} />, viewer.root) : null}
    </>
  )
}
