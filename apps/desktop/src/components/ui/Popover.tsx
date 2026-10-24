/* eslint-disable react-refresh/only-export-components -- compound component namespace is intentional. */

import { Popover as PopoverPrimitive } from '@base-ui/react/popover'
import type { CSSProperties } from 'react'
import { cn } from '@/lib/cn'
import { popupMotion } from './variants'

type ClassNameProp = { className?: string }

// @@@popover-variants - 原来只有 keyframe 进场,关闭是"直接消失"。改用 Base UI 的
// data-starting-style / data-ending-style 转场:退场也有 140ms,弹层从触发点长出、也缩回触发点。
// window-no-drag-region:浮层盖到顶栏 52px 拖拽区时,拖拽区会吞掉点击(Electron -webkit-app-region)。与 ui/Menu 同一条。
const popoverPositioner = 'window-no-drag-region z-[var(--z-popover)] outline-none'
const popoverPopup = cn('box-border outline-none', popupMotion)

function Portal(props: PopoverPrimitive.Portal.Props) {
  return <PopoverPrimitive.Portal {...props} />
}

function Positioner({
  className,
  ...props
}: Omit<PopoverPrimitive.Positioner.Props, 'className'> & ClassNameProp) {
  return (
    <PopoverPrimitive.Positioner
      data-slot="popover-positioner"
      className={cn(popoverPositioner, className)}
      {...props}
    />
  )
}

function Popup({
  className,
  style,
  ...props
}: Omit<PopoverPrimitive.Popup.Props, 'className' | 'style'> &
  ClassNameProp & {
    style?: CSSProperties
  }) {
  return (
    <PopoverPrimitive.Popup
      data-slot="popover-popup"
      className={cn(popoverPopup, className)}
      style={style}
      {...props}
    />
  )
}

function Arrow({ className, ...props }: Omit<PopoverPrimitive.Arrow.Props, 'className'> & ClassNameProp) {
  return <PopoverPrimitive.Arrow className={className} {...props} />
}

function Close({
  className,
  ...props
}: Omit<PopoverPrimitive.Close.Props, 'className'> & ClassNameProp) {
  return <PopoverPrimitive.Close data-slot="popover-close" className={className} {...props} />
}

/** Gugu popover composition: Base UI owns dismissal/positioning, call sites own content. */
export const Popover = {
  Root: PopoverPrimitive.Root,
  Trigger: PopoverPrimitive.Trigger,
  createHandle: PopoverPrimitive.createHandle,
  Portal,
  Positioner,
  Popup,
  Close,
  Arrow,
}
