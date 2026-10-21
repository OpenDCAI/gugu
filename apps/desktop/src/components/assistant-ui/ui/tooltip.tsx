import type { ComponentProps, ReactElement, ReactNode } from 'react'
import { Tooltip as GuguTooltip } from '@/components/ui/Tooltip'
import { cn } from '@/lib/utils'

/**
 * shadcn 形状的 Tooltip（Radix 命名）→ 咕咕自己的 Tooltip 复合件。
 * 官方源码写 `Tooltip / TooltipTrigger / TooltipContent / TooltipProvider`，咕咕的是
 * `Tooltip.{Provider,Root,Trigger,Portal,Positioner,Popup}`，这里只做名字对应。
 */
export function TooltipProvider({
  children,
  delayDuration
}: {
  children: ReactNode
  delayDuration?: number
}) {
  return <GuguTooltip.Provider delay={delayDuration}>{children}</GuguTooltip.Provider>
}

export function Tooltip(props: ComponentProps<typeof GuguTooltip.Root>) {
  return <GuguTooltip.Root {...props} />
}

/**
 * Radix 的 `asChild`（把触发器渲染成 children 那个元素）在 Base UI 里叫 `render`。
 * 官方源码写的是 asChild，所以在这里翻译，而不是去改它。
 */
export function TooltipTrigger({
  asChild,
  children,
  ...rest
}: Omit<ComponentProps<typeof GuguTooltip.Trigger>, 'render'> & { asChild?: boolean }) {
  if (asChild) return <GuguTooltip.Trigger render={children as ReactElement} {...rest} />
  return <GuguTooltip.Trigger {...rest}>{children}</GuguTooltip.Trigger>
}

export function TooltipContent({
  className,
  children,
  side = 'top',
  ...rest
}: ComponentProps<typeof GuguTooltip.Popup> & { side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <GuguTooltip.Portal>
      <GuguTooltip.Positioner side={side} sideOffset={6}>
        <GuguTooltip.Popup
          className={cn(
            // @@@shadow-lift (Refs #6105) — 原样 shadcn 的 shadow-md 是 Tailwind 内置阴影,
            // rounded-md 在本仓是 8px(控件档)。tooltip 是浮层 ⇒ surface 档 + 唯一那档 lift。
            // @@@float-one-edge (Refs #6104) — 去掉 border:浮层只留 lift 那一层。
            'bg-popover text-popover-foreground rounded-[var(--radius-surface)] px-2 py-1 text-xs shadow-[var(--shadow-lift)]',
            className
          )}
          {...rest}
        >
          {children}
        </GuguTooltip.Popup>
      </GuguTooltip.Positioner>
    </GuguTooltip.Portal>
  )
}
