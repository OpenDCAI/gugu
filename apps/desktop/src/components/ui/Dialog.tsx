/* eslint-disable react-refresh/only-export-components -- compound component namespace is intentional. */

import { useLayoutEffect, useState } from 'react'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { cn } from '@/lib/cn'

type ClassNameProp = { className?: string }


function DialogRoot({ children, open, onOpenChangeComplete, ...props }: DialogPrimitive.Root.Props) {
  // Keep the last committed portal until Base UI finishes closing.
  const [retained, setRetained] = useState(() => children)
  useLayoutEffect(() => { if (open && children != null) setRetained(() => children) }, [open, children])
  return <DialogPrimitive.Root {...props} open={open} onOpenChangeComplete={(next) => {
    if (!next && open) return
    if (!next) setRetained(null)
    onOpenChangeComplete?.(next)
  }}>{children ?? retained}</DialogPrimitive.Root>
}

function DialogPortal(props: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal {...props} />
}

function DialogBackdrop({
  className,
  ...props
}: Omit<DialogPrimitive.Backdrop.Props, 'className'> & ClassNameProp) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-backdrop"
      className={cn('gg-dialog-backdrop', className)}
      {...props}
    />
  )
}

function DialogViewport({
  className,
  ...props
}: Omit<DialogPrimitive.Viewport.Props, 'className'> & ClassNameProp) {
  return (
    <DialogPrimitive.Viewport
      data-slot="dialog-viewport"
      className={cn('gg-dialog-viewport', className)}
      {...props}
    />
  )
}

function DialogPopup({
  className,
  ...props
}: Omit<DialogPrimitive.Popup.Props, 'className'> & ClassNameProp) {
  return (
    <DialogPrimitive.Popup
      data-slot="dialog-popup"
      className={cn('gg-dialog-popup', className)}
      {...props}
    />
  )
}

function DialogTitle({
  className,
  ...props
}: Omit<DialogPrimitive.Title.Props, 'className'> & ClassNameProp) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('gg-dialog-title', className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: Omit<DialogPrimitive.Description.Props, 'className'> & ClassNameProp) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('gg-dialog-description', className)}
      {...props}
    />
  )
}

function DialogClose({
  className,
  ...props
}: Omit<DialogPrimitive.Close.Props, 'className'> & ClassNameProp) {
  return (
    <DialogPrimitive.Close
      data-slot="dialog-close"
      className={cn('gg-dialog-close', className)}
      {...props}
    />
  )
}

/**
 * Gugu-owned dialog composition layer.
 *
 * Base UI owns interaction semantics and accessibility. Call sites own product flow,
 * while Gugu CSS classes/tokens own every visual decision. Keeping this wrapper local
 * gives us a shadcn-style component surface without inheriting a third-party skin.
 */
export const Dialog = {
  Root: DialogRoot,
  Portal: DialogPortal,
  Backdrop: DialogBackdrop,
  Viewport: DialogViewport,
  Popup: DialogPopup,
  Title: DialogTitle,
  Description: DialogDescription,
  Close: DialogClose,
}
