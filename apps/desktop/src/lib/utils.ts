import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * shadcn/ui 的标准类名合并工具。粘过来的 shadcn 组件一律 `import { cn } from '@/lib/utils'`，
 * 这个文件就是那个约定位置 —— 之前主 app 没有它，每个组件粘进来第一件事就是改 import 或自己搓一个。
 *
 * 为什么不是裸 clsx：twMerge 会解决同类冲突（后写的赢）。这一条正是 `className` 入参
 * 能覆盖组件自带样式的前提 —— 组件里写 `cn('rounded-lg', className)`，调用方传
 * `rounded-full` 才真的能盖掉，否则两条都进 class 列表、由编译源序决定，结果不可预期。
 *
 * （vendor 的 `apps/desktop/src/session/renderer` 有自己的 `@renderer/utils/utils`，别跨树 import。）
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
