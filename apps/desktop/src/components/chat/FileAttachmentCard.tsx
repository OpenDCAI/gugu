import { Download, FileText } from '@/lib/icons'
import { formatAttachmentSize, type AttachmentMeta } from '@gugu/core/shared/ui/attachmentModels'
import type { ResourceContext } from '@/session/shared/resource-actions'
import { ResourceMenu } from '../ResourceMenu'
import { Button } from '../ui/Button'
import { useTranslation } from 'react-i18next'
import { attachmentTypeKey } from './attachmentType'

interface FileAttachmentCardProps {
  resource?: ResourceContext
  file: Pick<AttachmentMeta, 'fileName' | 'sizeBytes' | 'mimeType'> & { kind?: AttachmentMeta['kind'] }
  isMine?: boolean
  details?: string
  /** The folder file's version this message pins, already worded ("第 2 版"): shown before the size. */
  versionLabel?: string
  onOpen: () => void
  onDownload?: () => void
  downloadLabel?: string
}

/** The canonical document attachment surface used by messages and history. */
export function FileAttachmentCard({ file, isMine = false, details, versionLabel, onOpen, onDownload, downloadLabel, resource }: FileAttachmentCardProps) {
  const { t } = useTranslation('messaging')
  const type = attachmentTypeKey(file)
  const metadata = [versionLabel, formatAttachmentSize(file.sizeBytes), type ? t(`attachmentView.types.${type}`) : null].filter(Boolean).join(' · ')
  const accent = isMine ? 'var(--text-on-bubble-strong)' : 'var(--text-link)'
  const muted = isMine ? 'var(--text-on-bubble-muted)' : 'var(--text-tertiary)'
  const card = (
    <div className="gg-hcard gg-hfile flex max-w-[260px] items-center gap-[11px] rounded-xl border border-[var(--border)] !p-[11px] !mb-2">
      <Button
        variant="ghost"
        size="option"
        onClick={onOpen}
        aria-label={file.fileName}
        className="min-w-0 flex-1 justify-start text-left"
        style={{ minWidth: 0, padding: 0, border: 'none', background: 'none', color: 'inherit' }}
      >
        <div aria-hidden="true" className="bg-foreground/[0.06] grid size-8 shrink-0 place-items-center rounded-[var(--radius-document)]">
          {file.kind === 'image' ? <span aria-hidden="true">🖼️</span> : <FileText size={18} color={accent} strokeWidth={1.7} />}
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[length:var(--font-body)] font-semibold" style={{ color: accent }}>{file.fileName}</span>
          <span className="text-[length:var(--font-caption)]" style={{ color: muted }}>{details ?? metadata}</span>
        </div>
      </Button>
      {onDownload && (
        <button
          type="button"
          className="gg-hdl grid size-7 shrink-0 cursor-pointer place-items-center rounded-lg border-none bg-transparent text-[var(--faint-fg)] hover:bg-[var(--hover)] hover:text-[var(--fg)]"
          title={downloadLabel}
          aria-label={downloadLabel ?? `Download ${file.fileName}`}
          onClick={(event) => { event.stopPropagation(); onDownload() }}
        >
          <Download size={15} aria-hidden="true" />
        </button>
      )}
    </div>
  )
  return resource ? <ResourceMenu resource={resource}>{card}</ResourceMenu> : card
}
