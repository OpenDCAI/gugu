import { useTranslation } from 'react-i18next'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FilePreviewHost } from './filePreviewHost'
import { rendererLogger } from '../../lib/log'
import { messageForUser } from '../../lib/userFacingError'
import { platform } from '../../platform'
import { Sheet } from '../ui/Sheet'
import { openLinkTarget } from '../../lib/guguLinks'
import { MessageFilePreview, type PreviewFile } from './MessageFilePreview'

export type { PreviewFile } from './MessageFilePreview'

const fileOpenLog = rendererLogger('chat/file-open')

export function useMessageFilePreview({ mobile, visible, closeRightSurfaces, toast, onForward }: {
  mobile: boolean
  visible: boolean
  closeRightSurfaces: () => void
  toast: (message: string, kind: 'error', description?: string) => void
  onForward: (message: MessageItem) => void
}) {
  const { t } = useTranslation('messaging')
  const downloadFailed = t('chatArea.downloadFailed')
  const host = useContext(FilePreviewHost)
  const hosted = host !== null
  const onOpenChange = host?.onOpenChange
  const [preview, setPreview] = useState<{ file: PreviewFile; message?: MessageItem; opening: number } | null>(null)
  const isOpen = preview !== null
  useEffect(() => {
    onOpenChange?.(isOpen)
    return () => onOpenChange?.(false)
  }, [isOpen, onOpenChange])
  const opening = useRef(0)
  const restoreRef = useRef<(() => void) | null>(null)
  const open = useCallback((file: PreviewFile, message?: MessageItem, restore: () => void = () => {}) => {
    // A personal assistant conversation hosts its own preview; other group files use the App-first path.
    if (!hosted && file.source.kind === 'item' && platform.kind !== 'web') {
      void openLinkTarget({ kind: 'file', itemId: file.source.itemId }, { message, restore }).catch((error) => {
        fileOpenLog.error({ error }, 'opening the group file failed')
        toast(downloadFailed, 'error', messageForUser(error))
      })
      return
    }
    closeRightSurfaces()
    restoreRef.current = restore ?? null
    setPreview({ file, message, opening: ++opening.current })
  }, [closeRightSurfaces, downloadFailed, hosted, toast])
  const close = useCallback(() => {
    restoreRef.current = null
    setPreview(null)
  }, [])
  const closeByUser = useCallback(() => {
    const restore = restoreRef.current
    close()
    restore?.()
  }, [close])
  useEffect(() => { if (mobile && preview && !visible) close() }, [mobile, preview, visible, close])
  const body = preview && <MessageFilePreview key={preview.opening} fill={hosted} mobile={mobile} file={preview.file} message={preview.message} onForward={onForward} onClose={closeByUser} />
  const panel = host && 'target' in host ? (host.target && preview ? createPortal(body, host.target) : null) : mobile ? (
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
