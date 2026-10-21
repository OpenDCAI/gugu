import { useRef, type ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, X } from '@/lib/icons'
import type { ImageAttachDraftItem } from './useImageAttachDraft'
import { Button } from '../ui/Button'

export interface ImageAttachStripProps {
  images: ImageAttachDraftItem[]
  onAddFiles: (files: Iterable<File>) => void
  onRemove: (id: string) => void
  maxImages?: number
  disabled?: boolean
}
export function ImageAttachStrip({ images, onAddFiles, onRemove, maxImages = 9, disabled = false }: ImageAttachStripProps) {
  const { t } = useTranslation('contacts')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const canAdd = !disabled && images.length < maxImages
  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.currentTarget.files) onAddFiles(event.currentTarget.files)
    event.currentTarget.value = ''
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, overflowX: 'auto', padding: '2px 0' }}>
      {images.map((image) => (
        <div key={image.id} style={{ position: 'relative', width: 64, height: 64, flex: '0 0 64px' }}>
          <img src={image.previewUrl} alt={image.file.name} style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'var(--radius-document)', background: 'var(--bg-secondary)' }} />
          <Button
            variant="ghost" size="icon"
            aria-label={t('sharingMedia.removeImage', { name: image.file.name })}
            title={t('sharingMedia.removeImage', { name: image.file.name })}
            disabled={disabled} onClick={() => onRemove(image.id)}
            style={{ position: 'absolute', top: 3, right: 3, width: 24, height: 24, minHeight: 24, border: 'none', borderRadius: 'var(--radius-document)', background: 'var(--bg-overlay-modal)', color: 'var(--text-on-accent)', cursor: disabled ? 'default' : 'pointer' }}
          >
            <X size={14} />
          </Button>
        </div>
      ))}
      <input ref={inputRef} type="file" accept="image/*" multiple hidden onChange={onChange} />
      {canAdd ? (
        <Button
          variant="secondary" size="icon"
          aria-label={t('sharingMedia.addImages')}
          title={t('sharingMedia.addImages')}
          onClick={() => inputRef.current?.click()}
          style={{ width: 64, height: 64, minHeight: 64, flex: '0 0 64px', borderStyle: 'dashed', background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
        >
          <Plus size={20} />
        </Button>
      ) : null}
    </div>
  )
}
