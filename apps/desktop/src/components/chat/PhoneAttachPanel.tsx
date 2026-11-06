import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useUiPortalContainer } from '@gugu/session-ui/react/primitives'
import { X } from '@/lib/icons'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { Switch } from '../ui/Switch'
import { useBackLayer } from '../ui/sheetStack'
import { compressPhoto } from './compressPhoto'
import './phoneAttach.css'

export type PhoneAttachEntry = { id: string; label: string; icon: ReactNode; disabled?: boolean; onSelect: () => void }

/**
 * 手机输入框的「+」(owner 11-05 认可):在键盘的位置升起一块面板,照片、拍摄、文件分开,后面接这个输入框原有的附加项。
 * 桌面不走这里:照旧是回形针 / 拖拽 / 粘贴。
 */
export function PhoneAttachPanel({ entries, onClose }: { entries: PhoneAttachEntry[]; onClose: () => void }) {
  useBackLayer(onClose)
  return (
    <div className="gg-phone-attach" data-testid="chat-composer-attach-panel">
      {entries.map((entry) => (
        <Button key={entry.id} variant="ghost" className="gg-phone-attach-tile" disabled={entry.disabled} data-testid={`chat-composer-attach-${entry.id}`}
          onClick={() => { onClose(); entry.onSelect() }}>
          <span className="gg-phone-attach-icon" aria-hidden>{entry.icon}</span>
          {entry.label}
        </Button>
      ))}
    </div>
  )
}

/**
 * 照片 / 拍摄选完先到这一页看一眼再发:大图、缩略图条(可去掉某张)、说明文字、「原图」开关(默认关 = 压缩)。
 * 发出去是图片消息,和输入框里已有的内容走同一次发送。
 */
export function PhonePhotoPreview({ files, caption, onSend, onCancel }: {
  files: File[]
  caption: string
  onSend: (photos: File[], caption: string) => void
  onCancel: () => void
}) {
  const { t } = useTranslation('messaging')
  const portalContainer = useUiPortalContainer()
  const [photos, setPhotos] = useState(() => files.map((file) => ({ file, url: URL.createObjectURL(file) })))
  const [current, setCurrent] = useState(0)
  const [text, setText] = useState(caption)
  const [original, setOriginal] = useState(false)
  const [sending, setSending] = useState(false)
  const release = (list: typeof photos) => list.forEach((photo) => URL.revokeObjectURL(photo.url))
  const cancel = () => { release(photos); onCancel() }
  useBackLayer(cancel)
  const remove = (index: number) => {
    release([photos[index]])
    const next = photos.filter((_photo, i) => i !== index)
    if (!next.length) return onCancel()
    setPhotos(next)
    setCurrent(Math.min(current, next.length - 1))
  }
  const send = async () => {
    setSending(true)
    const ready = original ? photos.map((photo) => photo.file) : await Promise.all(photos.map((photo) => compressPhoto(photo.file)))
    release(photos)
    onSend(ready, text)
  }
  const shown = photos[current]
  return createPortal(
    <div className="gg-phone-photos" role="dialog" aria-label={t('composer.photos')} data-testid="chat-photo-preview">
      <div className="gg-phone-photos-top">
        <IconButton shape="pill" size="md" aria-label={t('composer.cancelPhotos')} onClick={cancel}><X /></IconButton>
        <span>{current + 1} / {photos.length}</span>
      </div>
      <img className="gg-phone-photos-big" src={shown.url} alt={shown.file.name} />
      <div className="gg-phone-photos-strip">
        {photos.map((photo, index) => (
          <div key={photo.url} className="gg-phone-photos-thumb" data-current={index === current || undefined}>
            <Button variant="ghost" className="gg-phone-photos-pick" aria-label={photo.file.name} onClick={() => setCurrent(index)}>
              <img src={photo.url} alt="" />
            </Button>
            <IconButton shape="pill" size="sm" className="gg-phone-photos-remove" aria-label={t('composer.removeAttachment', { fileName: photo.file.name })} onClick={() => remove(index)}><X /></IconButton>
          </div>
        ))}
      </div>
      <div className="gg-phone-photos-bottom">
        <input className="gg-phone-photos-caption" value={text} placeholder={t('composer.photoCaption')} aria-label={t('composer.photoCaption')} onChange={(event) => setText(event.target.value)} />
        <label className="gg-phone-photos-original">
          <Switch checked={original} onCheckedChange={setOriginal} data-testid="chat-photo-original" />
          {t('composer.originalPhoto')}
        </label>
        <Button variant="primary" className="gg-phone-photos-send" disabled={sending} data-testid="chat-photo-send" onClick={() => void send()}>
          {t('composer.sendPhotos', { count: photos.length })}
        </Button>
      </div>
    </div>,
    portalContainer ?? document.body,
  )
}
