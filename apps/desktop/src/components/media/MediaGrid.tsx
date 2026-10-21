import { openImageViewer, type ImageViewerItem } from '../../lib/imageViewer'
import { Button } from '../ui/Button'

/** `pending`:图还不在手里(手机去机器上取的工具图)—— 这一格画这句话代替图,点它调 `onPending`,看图器里不带它。 */
export type MediaGridItem = ImageViewerItem & { pending?: string }

export interface MediaGridProps {
  images: MediaGridItem[]
  className?: string
  onPending?: (index: number) => void
}
function layoutFor(count: number): 1 | 2 | 3 | 4 | 6 | 9 {
  if (count <= 1) return 1
  if (count === 2) return 2
  if (count === 3) return 3
  if (count === 4) return 4
  if (count <= 6) return 6
  return 9
}
export function MediaGrid({ images, className, onPending }: MediaGridProps) {
  if (images.length === 0) return null

  const visibleImages = images.slice(0, 9)
  const layout = layoutFor(visibleImages.length)
  const columns = layout === 1 ? 1 : layout === 2 || layout === 4 ? 2 : 3
  return (
    <div className={className} data-testid="media-grid" data-layout={layout} style={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: 4, width: '100%', maxWidth: layout === 1 ? 380 : 460 }}>
      {visibleImages.map((image, index) => (
        <Button
          key={`${image.url}:${index}`}
          variant="ghost" size="icon"
          aria-label={image.alt}
          // 第 9 格之后的图没有缩略图:打开照样能滑到,只是关闭时淡出而不是缩回。
          onClick={(e) => {
            if (image.pending !== undefined) return onPending?.(index)
            const cells = e.currentTarget.parentElement?.children
            const ready = images.flatMap(({ pending, ...item }, i) => (pending === undefined ? [{ ...item, thumb: cells?.[i]?.querySelector('img') ?? null, i }] : []))
            openImageViewer(ready.map(({ i: _i, ...item }) => item), ready.findIndex((item) => item.i === index))
          }}
          style={{ position: 'relative', display: 'block', width: '100%', height: 'auto', minHeight: 0, minWidth: 0, aspectRatio: layout === 1 ? '4 / 3' : '1 / 1', padding: 0, overflow: 'hidden', border: 'none', borderRadius: 'var(--radius-document)', background: 'var(--bg-secondary)', cursor: 'zoom-in' }}
        >
          {image.pending !== undefined ? (
            <span className="gg-media-grid-pending">{image.pending}</span>
          ) : (
            <img src={image.url} alt={image.alt} loading="lazy" style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }} />
          )}
          {index === 8 && images.length > 9 ? (
            <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-overlay-modal)', color: 'var(--text-on-accent)', fontSize: 'var(--font-caption)', fontWeight: 600 }}>
              +{images.length - 9}
            </span>
          ) : null}
        </Button>
      ))}
    </div>
  )
}
