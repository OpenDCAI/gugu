import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Minus, Plus } from '@/lib/icons'
import { Button } from '@renderer/lib/ui/button'
import { clampZoom, DOCUMENT_MAX_ZOOM, DOCUMENT_MIN_ZOOM } from '@/session/shared/preview/pinch-zoom'
import type { FileZoomCommand } from '@/session/shared/preview/file-zoom'
import { readFileZoom, subscribeFileZoom, writeFileZoom, zoomForCommand, type FileZoomKind } from './file-content-zoom'

/**
 * Zoom B's one control (owner 11-05): a row in a readable view's ⋯ menu — − ratio +, the ratio itself back to 100%.
 * The same preference and steps as the keys and a pinch; the row is not a menu item, so pressing it keeps the menu open.
 */
export function ZoomMenuRow({ kind }: { kind: FileZoomKind }) {
  const { t } = useTranslation('messaging')
  const zoom = useSyncExternalStore(subscribeFileZoom, () => readFileZoom(kind), () => 1)
  const min = kind === 'image' ? 1 : DOCUMENT_MIN_ZOOM
  const run = (command: FileZoomCommand) => writeFileZoom(kind, clampZoom(zoomForCommand(zoom, command), min, DOCUMENT_MAX_ZOOM))
  const step = (command: 'zoomOut' | 'zoomIn', disabled: boolean) => (
    <Button size="icon-xs" variant="ghost" aria-label={t(`chatArea.filePreview.${command}`)} title={t(`chatArea.filePreview.${command}`)} disabled={disabled} onClick={() => run(command)}>
      {command === 'zoomOut' ? <Minus /> : <Plus />}
    </Button>
  )
  return (
    <div className="flex items-center gap-1 px-2 py-1 text-sm" data-testid="zoom-menu-row">
      <span className="flex-1">{t('chatArea.filePreview.zoom')}</span>
      {step('zoomOut', zoom <= min)}
      <Button size="xs" variant="ghost" className="min-w-12 tabular-nums" aria-label={t('chatArea.filePreview.zoomReset')} title={t('chatArea.filePreview.zoomReset')} onClick={() => run('resetZoom')}>
        {Math.round(zoom * 100)}%
      </Button>
      {step('zoomIn', zoom >= DOCUMENT_MAX_ZOOM)}
    </div>
  )
}
