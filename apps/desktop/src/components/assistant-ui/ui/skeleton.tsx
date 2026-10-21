import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/**
 * 骨架屏。咕咕没有这个原语，官方的历史区加载态要用，补一个最小实现。
 * 颜色走 tokens.css 里那座 shadcn → 咕咕的 @theme 桥，所以它自动跟随亮暗主题。
 */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('bg-muted animate-pulse rounded-[var(--radius-control)] motion-reduce:animate-none', className)} {...props} />
}
