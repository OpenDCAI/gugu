import { Button as ButtonPrimitive } from '@base-ui/react/button'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { useMobileShell } from '../../hooks/useMobileShell'

/**
 * @@@ui-ruler IconButton — 图标钮的唯一实现。
 *
 * 原来同一件事有五份:chatPresentation.ICON_BTN(28,圆角 4)、GHOST_BTN(30,药丸)、
 * ChatHeaderActions.mheadIconClass(32 网格)、InputArea 的手写 send 钮(onMouseEnter 改 style)、
 * ui/Button size="icon"(34)。尺寸从 tokens 的 --control-h-* 取(sm 28 / md 32 / lg 36;手机上 md / lg 长到触控 44,sm 只撑点击区 —— 由这里读 useMobileShell,调用方不用管),
 * 图标从 --icon-* 取(16 / 18 / 20),颜色三态由 .gg-ghost 供给,「开」态挂 data-on。
 *
 * 必须给 aria-label:图标钮没有可见文字,这是它唯一的可访问名。
 */
export interface IconButtonProps extends Omit<ButtonPrimitive.Props, 'className' | 'children'> {
  'aria-label': string
  children: ReactNode
  size?: 'sm' | 'md' | 'lg'
  /** 药丸形(composer 里的附件 / 发送钮);默认 --r 圆角。 */
  shape?: 'round' | 'pill'
  /** 「开」态(面板已展开 / 菜单已打开)。 */
  on?: boolean
  /** 文字型 ghost 的强调 tone:rest 抬到 muted-fg。 */
  tone?: 'default' | 'strong'
  className?: string
}

export function IconButton({
  size = 'md',
  shape = 'round',
  on,
  tone,
  className,
  children,
  type = 'button',
  ...props
}: IconButtonProps) {
  const mobile = useMobileShell()
  return (
    <ButtonPrimitive
      {...props}
      type={type}
      data-slot="icon-button"
      data-size={size}
      data-shape={shape === 'pill' ? 'pill' : undefined}
      data-on={on || undefined}
      data-mobile={mobile || undefined}
      data-tone={tone === 'strong' ? 'strong' : undefined}
      className={cn('gg-icon-btn gg-ghost window-no-drag-region', className)}
    >
      {children}
    </ButtonPrimitive>
  )
}
