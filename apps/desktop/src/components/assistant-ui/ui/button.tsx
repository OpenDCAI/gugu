import type { ComponentProps } from 'react'
import { Button as GuguButton } from '@/components/ui/Button'

/**
 * shadcn 形状的 Button → 咕咕自己的 Button 的**档位翻译层**。
 *
 * 官方 assistant-ui 的源码写 `variant="outline" / "default" / "destructive"`（shadcn 的词），
 * 咕咕的 Button 档位叫 `secondary / primary / danger`（同一件事，另一套名字）。
 * 在这里翻译，是为了让官方源码**一行不改**地落地 —— 改了源码，它以后的更新就再也接不上了。
 *
 * ❌ 不往咕咕的 Button 里加 shadcn 的档位名：那个 Button 全 app 在用，为了一处移植
 * 在它的公共 API 上多开两个同义词，是把局部的翻译成本摊给所有人。
 */
const VARIANT = {
  default: 'primary',
  destructive: 'danger',
  outline: 'secondary',
  secondary: 'secondary',
  ghost: 'ghost',
  link: 'ghost'
} as const

const SIZE = {
  default: 'md',
  sm: 'sm',
  lg: 'lg',
  icon: 'icon'
} as const

export type ButtonProps = Omit<ComponentProps<typeof GuguButton>, 'variant' | 'size'> & {
  variant?: keyof typeof VARIANT
  size?: keyof typeof SIZE
}

export function Button({ variant = 'default', size = 'default', ...rest }: ButtonProps) {
  return <GuguButton variant={VARIANT[variant]} size={SIZE[size]} {...rest} />
}
