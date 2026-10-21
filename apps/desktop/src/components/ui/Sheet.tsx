import { type CSSProperties, type ReactNode } from 'react'
import type { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { useMobileShell } from '../../hooks/useMobileShell'
import { Dialog } from './Dialog'
import { sheetBackdropMotion, sheetContentMotion } from './sheetMotion'
import { useBackLayer } from './sheetStack'

// 几何归 `.gg-window-layer`(tokens.css @@@window-layer):铺在 Windows 标题栏行下面,不盖住窗口外框。
const sheetViewport = 'gg-window-layer flex justify-center pointer-events-none'

// 只对读屏可见:标题与关闭按钮必须存在于无障碍树,但不占视觉空间。
const visuallyHidden =
  'absolute h-px w-px overflow-hidden whitespace-nowrap border-0 p-0 -m-px [clip:rect(0,0,0,0)]'

// The host Escape / Android-back handling below shares one stack of open layers (sheetStack.ts): it
// preserves Gugu's nested-sheet contract — a child picker never closes its parent in the same key press.

// @@@1278-sheet — shared responsive Sheet/Dialog primitive.
//
// Desktop: a centered dialog (gugu's existing modal look — bordered card, pops in).
// Mobile (mobile shell / <720px): a bottom-sheet — full-width, anchored to the bottom edge, 32px
// top corners, 85dvh tall, sliding up from the bottom (max-sm Dialog→bottom-sheet
// pattern). Content taller than the sheet scrolls in the sheet itself
// (@@@sheet-scroll in sheetMotion.ts). One primitive, both presentations, so each migrated modal
// gets the mobile bottom-sheet for free while keeping its desktop dialog.
//
// Base UI supplies the behavior engine (focus trap/restore, inert background, nested Escape stack,
// accessible dialog semantics). Gugu keeps the public API, responsive geometry, motion, and tokens.

export interface SheetProps {
  open?: boolean
  onClosed?: () => void
  /** Dismiss the sheet (backdrop click, the ✕, or Escape all call this). */
  onClose: () => void
  /**
   * Optional Escape interception. Return `true` when the key was handled and the sheet should
   * remain open (for example, a multi-step flow going back one step). Returning a falsy value
   * falls through to `onClose`.
   */
  onEscape?: () => boolean
  children: ReactNode
  /** Desktop centered-dialog width. Mobile is always full-width. Default 'min(420px, 100%)'. */
  desktopWidth?: string
  /** Desktop centered-dialog max height. Mobile uses `mobileHeight`. */
  desktopMaxHeight?: string
  /**
   * Optional FIXED desktop height (e.g. '480px'). Use for dense panels whose layout assumes a
   * stable frame (a full-height nav rail): without it the card shrinks to content height and jumps
   * between sections. Still capped by `desktopMaxHeight` on short viewports. Omitted → content-height.
   */
  desktopHeight?: string
  /** Mobile bottom-sheet height. Default '85dvh'. Ignored when `fullScreenMobile`. */
  mobileHeight?: string
  /**
   * Dense panels (Settings / AgentSettings): on mobile use a full-screen sheet —
   * 100dvh, square corners (rounded-none) — instead of the 85dvh rounded bottom-sheet. Still
   * slides up from the bottom. Desktop is unchanged (centered dialog). Equivalent to
   * `max-sm:h-[100dvh] max-sm:rounded-none` for dense content.
   */
  fullScreenMobile?: boolean
  /**
   * 内容可变的向导流(如 CreateAgentModal 分步创建):mobile 底部 sheet 高度随内容自适应,
   * `mobileHeight`(默认 85dvh)只作上限——固定死高在内容少的步骤会留大片死空白(#1788 步骤化后暴露)。
   * 与 `fullScreenMobile` 互斥(全屏优先)。
   */
  mobileFitContent?: boolean
  /** data-testid on the content container (e2e). The container also carries data-sheet-mobile. */
  testId?: string
  /** Accessible label for the dialog. */
  ariaLabel?: string
  /** Explicit focus target for a nested sheet to restore when it closes. */
  finalFocus?: DialogPrimitive.Popup.Props['finalFocus']
  /**
   * Id of a Dialog.Title supplied by the caller inside the popup. When present, the caller's
   * visible title is the dialog's accessible name and Sheet does not add a second hidden title.
   */
  titleId?: string
  /** Dismiss when the backdrop is clicked. Default true. */
  closeOnBackdrop?: boolean
  /** Stacking order. Default var(--z-modal)；非常规层传 var(--z-*) token（#1899），❌ 魔数。 */
  zIndex?: number | string
}

export function Sheet({
  open = true,
  onClosed,
  onClose,
  onEscape,
  children,
  desktopWidth = 'min(420px, 100%)',
  desktopMaxHeight = 'min(560px, calc(100dvh - 32px))',
  desktopHeight,
  mobileHeight = '85dvh',
  fullScreenMobile = false,
  mobileFitContent = false,
  testId,
  ariaLabel,
  finalFocus,
  titleId,
  closeOnBackdrop = true,
  zIndex = 'var(--z-modal)',
}: SheetProps) {
  const { t } = useTranslation()
  const mobile = useMobileShell()
  useBackLayer(() => { if (!onEscape?.()) onClose() }, open)

  const mobileStyle: CSSProperties = {
    width: '100%',
    maxWidth: '100%',
    // Dense panels go full-screen (max-sm:h-[100dvh] rounded-none); light dialogs are the
    // 85dvh rounded bottom-sheet; fit-content wizards hug their content (mobileHeight = cap only).
    height: fullScreenMobile ? '100dvh' : mobileFitContent ? 'auto' : mobileHeight,
    maxHeight: fullScreenMobile ? undefined : mobileHeight,
    borderRadius: fullScreenMobile ? '0' : '32px 32px 0 0',
    paddingBlockEnd: 'env(safe-area-inset-bottom)',
  }

  const desktopStyle: CSSProperties = {
    width: desktopWidth,
    maxWidth: '100%',
    // `desktopHeight` (optional) pins a FIXED desktop frame for dense panels whose layout assumes a
    // stable height (e.g. a full-height nav rail) — without it the card would shrink to content and
    // jump between sections. `maxHeight` still caps it on short viewports. Omitted → content-height.
    height: desktopHeight,
    // 调用方的上限多按整窗写(`calc(100dvh - 32px)`);层在标题栏行下面时会矮一截,卡片不许顶出层去压回标题栏。
    maxHeight: `min(${desktopMaxHeight}, 100%)`,
    // 形状由这里唯一决定(原来是一个 prop,14 个调用点各拍一个数字)。#7333 视觉规范:较大的全局 Sheet / Dialog
    // 外壳 16(--radius-dialog),里面的卡片仍是 12 —— 所以是一个新名字,❌ 把 --radius-xl 一起放大。
    borderRadius: 'var(--radius-dialog)',
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChangeComplete={(next) => { if (!next) onClosed?.() }}
      disablePointerDismissal={!closeOnBackdrop}
      onOpenChange={(open, details) => {
        if (!open) {
          if (details.reason === 'escape-key' && onEscape?.()) {
            details.cancel()
            return
          }
          onClose()
        }
      }}
    >
      {open ? <Dialog.Portal>
        <Dialog.Backdrop
          className={cn('gg-sheet-backdrop window-no-drag-region', sheetBackdropMotion)}
          data-sheet-mobile={mobile ? 'true' : 'false'}
          style={{ zIndex }}
        />
        <Dialog.Viewport
          className={cn('gg-sheet-viewport window-no-drag-region', sheetViewport)}
          data-sheet-mobile={mobile ? 'true' : 'false'}
          style={{
            alignItems: mobile ? 'flex-end' : 'center',
            padding: mobile ? 0 : '16px',
            zIndex,
          }}
        >
          <Dialog.Popup
            className={cn('gg-sheet-content', sheetContentMotion)}
            aria-modal="true"
            finalFocus={finalFocus}
            {...(titleId ? { 'aria-labelledby': titleId } : {})}
            data-testid={testId}
            data-sheet-mobile={mobile ? 'true' : 'false'}
            data-sheet-fullscreen={fullScreenMobile ? 'true' : 'false'}
            style={{ ...(mobile ? mobileStyle : desktopStyle), background: 'var(--modal-bg)' }}
          >
            {!titleId && (
              <Dialog.Title className={visuallyHidden}>{ariaLabel ?? t('dialog.label')}</Dialog.Title>
            )}
            {children}
            <Dialog.Close
              className={visuallyHidden}
              aria-label={t('dialog.close')}
              tabIndex={-1}
            />
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal> : null}
    </Dialog.Root>
  )
}
