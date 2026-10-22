import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { sheetBackdropMotion } from '@/components/ui/sheetMotion'
import { useBackLayer } from '@/components/ui/sheetStack'
import { cn } from '@/lib/cn'
import { rendererLogger } from '@/lib/log'
import { errorText } from './usePhoneRead'

const log = rendererLogger('mobile/assistant')

/**
 * 删东西前的确认(手机):屏幕正中一张卡,❌ 底部抽屉(owner 不要 Sheet 式菜单)。
 * 点「删除」等它真删完才关;没删成就留在卡上说没删成(人可以再点一次或取消),❌ 关了卡当作删掉了。
 * 安卓返回键、点卡外 = 取消(删的时候不响应,免得删到一半以为取消了)。
 */
export function PhoneConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  failedText,
  onConfirm,
  onConfirmed,
  onClose,
  testId,
}: {
  open: boolean
  title: string
  body: string
  confirmLabel: string
  /** 没删成时卡上那一句(说是哪一步)。 */
  failedText: string
  onConfirm: () => Promise<void>
  onConfirmed?: () => void
  onClose: () => void
  testId?: string
}) {
  const { t } = useTranslation('assistant')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const confirmed = useRef(false)
  useLayoutEffect(() => { if (open) { setBusy(false); setFailed(false); confirmed.current = false } }, [open])
  const close = () => {
    if (!busy) onClose()
  }
  useBackLayer(close, open)
  const confirm = async () => {
    setBusy(true)
    setFailed(false)
    try {
      await onConfirm()
      confirmed.current = true
      onClose()
    } catch (error) {
      log.warn({ error: errorText(error) }, 'assistant phone delete failed')
      setFailed(true)
      setBusy(false)
    }
  }
  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : close())} onOpenChangeComplete={(next) => { if (!next && confirmed.current) onConfirmed?.() }}>
      {open ? <Dialog.Portal>
        <Dialog.Backdrop className={cn(sheetBackdropMotion, 'gg-mobile-motion z-[var(--z-modal)]')} />
        <Dialog.Viewport className="gg-window-layer pointer-events-none z-[var(--z-modal)] flex items-center justify-center p-6">
          <Dialog.Popup
            className="ta-dialog ta-phone-confirm-dialog gg-mobile-motion pointer-events-auto flex w-full max-w-[360px] flex-col gap-3 p-6 outline-none animate-[gg-sheet-pop-in_var(--dur-med)_var(--ease-spring)] data-[ending-style]:animate-none data-[ending-style]:opacity-0 data-[ending-style]:scale-[0.98] motion-reduce:animate-none motion-reduce:transition-none"
            data-testid={testId}
          >
            <Dialog.Title className="ta-dialog-title">{title}</Dialog.Title>
            <Dialog.Description className="ta-page-sub">{body}</Dialog.Description>
            {failed ? (
              <p className="ta-phone-confirm-failed" role="alert">
                {failedText}
              </p>
            ) : null}
            <div className="mt-2 flex justify-end gap-2">
              <Button variant="ghost" className="ta-pill-btn" disabled={busy} onClick={close}>
                {t('common.cancel')}
              </Button>
              <Button variant="ghost" className="ta-pill-btn" data-tone="danger" disabled={busy} aria-busy={busy} onClick={() => void confirm()} data-testid={testId ? `${testId}-confirm` : undefined}>
                {confirmLabel}
              </Button>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal> : null}
    </Dialog.Root>
  )
}
