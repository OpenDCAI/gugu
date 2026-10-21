import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * @@@ui-ruler Chip — 小标签的唯一实现:设备名、「群聊」「已共享」、未读计数。
 * 18px 高药丸、caption 字号、可截断(flex: 0 1 auto)——放在名字旁边时先于名字被截断。
 * 中性附属文字默认透明;计数与有语义的状态保留填充。tone 只表达含义,不拿它当装饰色。
 */
export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode
  tone?: 'default' | 'accent' | 'danger' | 'ok' | 'warn'
  /** count = 圆形计数徽标(最小 18×18)。 */
  shape?: 'pill' | 'count'
  /** plain = 列表里的附属文字,不铺标签底板。 */
  appearance?: 'filled' | 'plain'
  className?: string
}

export function Chip({ children, tone = 'default', shape = 'pill', appearance = tone === 'default' && shape === 'pill' ? 'plain' : 'filled', className, ...rest }: ChipProps) {
  return (
    <span
      {...rest}
      data-slot="chip"
      data-tone={tone === 'default' ? undefined : tone}
      data-shape={shape === 'count' ? 'count' : undefined}
      data-appearance={appearance === 'plain' ? 'plain' : undefined}
      className={cn('gg-chip', className)}
    >
      {children}
    </span>
  )
}
