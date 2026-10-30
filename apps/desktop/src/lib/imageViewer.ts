// 全 app 唯一的看图查看器(PhotoSwipe,宿主是 components/ImagePreviewProvider)的入口与纯函数。
// 入口是模块函数而不是 React context:会话页是另一棵 React 树,context 伸不过去。

import type { ResourceContext } from '@/session/shared/resource-actions'

export interface ImageViewerItem {
  /** Actual origin, never inferred from whichever conversation is behind the viewer. */
  source?: { chatId: string; messageId?: string }
  resource?: ResourceContext
  url: string
  alt: string
  /** 页面上那张缩略图:从它放大进入、关闭时缩回去,并提前知道原图尺寸;没有就淡入淡出。 */
  thumb?: HTMLElement | null
  /** 气泡里画的是缩略图时:取原图(object URL)。查看器先用 url 打开,翻到这一张再换成原图。 */
  full?: () => Promise<string>
  /** File previews keep their existing citation producer when opening the shared image viewer. */
  quote?: () => Promise<void> | void
}

/** 缩略图 <img> → 取它原图的办法(附件进群文件夹 ③:气泡用 CDN 缩略图,原图到看的时候才下)。 */
const fullImageLoaders = new WeakMap<HTMLImageElement, Pick<ImageViewerItem, 'full' | 'resource' | 'source'>>()
export function registerFullImage(thumb: HTMLImageElement, load: () => Promise<string>, resource?: ResourceContext, source?: ImageViewerItem['source']): () => void {
  const entry = { full: load, resource, ...(source ? { source } : {}) }
  fullImageLoaders.set(thumb, entry)
  return () => {
    if (fullImageLoaders.get(thumb) === entry) fullImageLoaders.delete(thumb)
  }
}

export interface Size {
  width: number
  height: number
}

export interface ThumbBounds {
  x: number
  y: number
  w: number
  /** 缩略图按 object-fit: cover 裁过时可见的那一块,PhotoSwipe 用它做裁切过渡。 */
  innerRect?: { x: number; y: number; w: number; h: number }
}

/** 缩略图是已解码的 <img> 时,它的 natural 尺寸就是原图尺寸(缩略图都是原图缩放显示)。 */
export function decodedSizeOf(thumb: HTMLElement | null | undefined): Size | null {
  const img = thumb instanceof HTMLImageElement ? thumb : thumb?.querySelector('img')
  if (!img || !img.complete || img.naturalWidth === 0 || img.naturalHeight === 0) return null
  return { width: img.naturalWidth, height: img.naturalHeight }
}

/** 缩略图在屏幕上画出原图的矩形;盒子不在视口里返回 undefined(缩回看不见的位置不如淡出)。 */
export function thumbBoundsFor(rect: DOMRectReadOnly, objectFit: string, image: Size, viewport: Size): ThumbBounds | undefined {
  if (rect.width <= 0 || rect.height <= 0) return undefined
  if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= viewport.width || rect.top >= viewport.height) return undefined
  if (objectFit === 'cover') {
    const scale = Math.max(rect.width / image.width, rect.height / image.height)
    const offsetX = (rect.width - image.width * scale) / 2
    const offsetY = (rect.height - image.height * scale) / 2
    return { x: rect.left + offsetX, y: rect.top + offsetY, w: image.width * scale, innerRect: { w: rect.width, h: rect.height, x: offsetX, y: offsetY } }
  }
  if (objectFit === 'contain') {
    const scale = Math.min(rect.width / image.width, rect.height / image.height)
    return { x: rect.left + (rect.width - image.width * scale) / 2, y: rect.top + (rect.height - image.height * scale) / 2, w: image.width * scale }
  }
  return { x: rect.left, y: rect.top, w: rect.width }
}

/** 普通手机截图约 2.2,整张放进一屏正好;滚动长截图常在 4 以上。 */
const LONG_IMAGE_ASPECT = 3

/** 长图:又细又长,按宽铺开(不放大)后一屏放不下。按宽铺开、从顶端读,而不是缩成一条细线。 */
export function isLongImage(image: Size, panArea: Size): boolean {
  return image.height / image.width >= LONG_IMAGE_ASPECT && image.height * Math.min(1, panArea.width / image.width) > panArea.height
}

/**
 * `fit` 是 PhotoSwipe 算的「整张放进视口、不放大」。initial:打开时;secondary:双击去的那档,至少 initial 的
 * 两倍(PhotoSwipe 默认 min(1, 3×fit) 对小图恰好是 1,双击没反应);max:捏合上限,至少原图 200%。
 */
export function zoomLevelsFor(image: Size, panArea: Size, fit: number): { initial: number; secondary: number; max: number } {
  const initial = isLongImage(image, panArea) ? Math.min(1, panArea.width / image.width) : fit
  const secondary = Math.max(initial * 2, Math.min(1, fit * 3))
  return { initial, secondary, max: Math.max(2, secondary, initial * 4) }
}

/** alt 就是上传时的原名;没有就取 URL 末段。data:/blob: 地址没有名字可取。 */
export function downloadNameFor(item: Pick<ImageViewerItem, 'url' | 'alt'>): string {
  if (item.alt) return item.alt
  const nameFromUrl = /^(data|blob):/.test(item.url) ? '' : item.url.split('/').pop()?.split('?')[0]
  return nameFromUrl || 'image'
}

// 只有一个宿主,挂载时登记、卸载时注销。
export interface ImageViewerRequest {
  items: ImageViewerItem[]
  index: number
}

type ImageViewerHost = (request: ImageViewerRequest) => void

let host: ImageViewerHost | null = null

export function registerImageViewerHost(next: ImageViewerHost): () => void {
  if (host) throw new Error('image viewer host is already registered; the app mounts exactly one ImagePreviewProvider')
  host = next
  return () => {
    if (host === next) host = null
  }
}

export function openImageViewer(items: ImageViewerItem[], index = 0): void {
  if (!host) throw new Error('image viewer host is not mounted')
  if (items.length === 0) throw new Error('openImageViewer needs at least one image')
  host({ items, index: Math.max(0, Math.min(index, items.length - 1)) })
}

// 画廊 = 此刻渲染在带 IMAGE_GALLERY_ATTR 的容器里、带 IMAGE_VIEWER_SRC_ATTR(原图地址)的缩略图,按文档顺序。
export const IMAGE_GALLERY_ATTR = 'data-image-gallery'
export const IMAGE_VIEWER_SRC_ATTR = 'data-image-viewer-src'

function itemFromThumb(thumb: HTMLImageElement): ImageViewerItem {
  const url = thumb.getAttribute(IMAGE_VIEWER_SRC_ATTR)
  if (!url) throw new Error(`image thumbnail is missing ${IMAGE_VIEWER_SRC_ATTR}`)
  return { url, alt: thumb.alt, thumb, ...fullImageLoaders.get(thumb) }
}

export function galleryAround(thumb: HTMLImageElement): ImageViewerRequest {
  const scope = thumb.closest(`[${IMAGE_GALLERY_ATTR}]`)
  if (!scope) return { items: [itemFromThumb(thumb)], index: 0 }
  const thumbs = Array.from(scope.querySelectorAll<HTMLImageElement>(`img[${IMAGE_VIEWER_SRC_ATTR}]`))
  const index = thumbs.indexOf(thumb)
  if (index < 0) throw new Error(`clicked thumbnail is not marked with ${IMAGE_VIEWER_SRC_ATTR}`)
  return { items: thumbs.map(itemFromThumb), index }
}

export function openImageFromThumb(thumb: HTMLImageElement): void {
  const { items, index } = galleryAround(thumb)
  openImageViewer(items, index)
}

/** 输入框里的附件 chip:图片进查看器并返回 true;文本附件返回 false,交回宿主的附件对话框。 */
export function openComposerImage(attachment: { kind: 'image' | 'file'; name: string; previewUrl?: string }): boolean {
  if (attachment.kind !== 'image' || !attachment.previewUrl) return false
  openImageViewer([{ url: attachment.previewUrl, alt: attachment.name }])
  return true
}
