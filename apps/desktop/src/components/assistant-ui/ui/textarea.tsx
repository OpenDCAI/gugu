import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/**
 * 官方「改了重发」那个编辑框用的裸 textarea。
 * 咕咕的 Field 是带标签的表单件，这里要的是不带外壳的输入区，所以单开一个。
 */
export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        // @@@focus-glow (Refs #6105) — 原样 shadcn 的 ring-ring 解析到 --color-ring = --primary,
        // 即纯白/纯黑的焦点环;换成 ui/Field 同款的边框 + 3px color-mix 光晕(全区唯一焦点可供性)。
        'border-input placeholder:text-muted-foreground',
        'flex w-full rounded-[var(--radius-control)] border bg-transparent px-3 py-2 text-base',
        'transition-[border-color,box-shadow] duration-[var(--dur-fast)] ease-out motion-reduce:transition-none',
        'focus-visible:border-[var(--primary)] focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--primary)_18%,transparent)]',
        'focus-visible:outline-none disabled:opacity-50',
        className
      )}
      {...props}
    />
  )
}
