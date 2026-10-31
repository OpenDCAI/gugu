import { Button as ButtonPrimitive } from '@base-ui/react/button'
import { cva, type VariantProps } from 'class-variance-authority'
import type { CSSProperties, ReactNode } from 'react'
import { cn } from '@/lib/cn'
import {
  controlTransition,
  disabledState,
  pressedSolidState,
  pressedSurfaceState,
} from './variants'

// @@@button-variants - 按钮样式的唯一真相。Base UI Button 只提供 data-disabled，
// 普通按钮的 hover/press 仍是 native :hover/:active；两者都显式排除 disabled。
const buttonVariants = cva(
  cn(
    // @@@state-ladder-mix ❌ 别把 .gg-pressable 加回来：每个 variant 自己已经给了按下态
    // (pressedSurfaceState / pressedSolidState)。两条同时命中会把 --press 叠两层，
    // 合成 alpha 约 10%(浅)/12%(暗)，**比 --selected 还深** —— 阶梯当场倒过来。
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap select-none cursor-pointer',
    // @@@6044 —— 钮内图标不参与命中测试。#6044 的真因不是遮挡:`makeIcon` 的 svg 走
    // `dangerouslySetInnerHTML`,按下到抬起之间那条 `<path>` 会被换成**新节点**,于是
    // mousedown 的 target 已 detach ⇒ Chromium 不合成 `click`(实测:pointerdown/mousedown/
    // pointerup/mouseup 四条 trusted 事件都到,`click` 一条都没有,`onClick` 从不执行,
    // 而 `dispatchEvent('click')` 与 Enter 都能发)。让 svg/path 退出命中测试,down 与 up 的
    // target 就永远是**稳定的那个 button 元素自己**,对图标内部任何 DOM 抖动免疫。
    // (这里刻意不写那个标签的字面量:scripts/check-ui-visual-spec.mts 按正则数 rawButtons,
    //  连注释一起数,写了会把 mainRenderer 的棘轮顶高一格。)
    // ❌ 别改 `packages/session-ui/src/icons.tsx`:那是 `scripts/gen-icons.mjs` 的生成物。
    '[&_svg]:pointer-events-none',
    'rounded-[var(--radius-control)] border border-transparent',
    'font-[inherit] text-[length:var(--font-body)] font-[var(--font-weight-medium)] leading-none',
    controlTransition,
    disabledState,
  ),
  {
    variants: {
      variant: {
        primary: cn(
          'bg-[var(--primary)] text-[var(--primary-fg)]',
          '[&:hover:not([data-disabled])]:opacity-[0.88]',
          pressedSolidState,
        ),
        secondary: cn(
          'border-[var(--border-strong)] bg-transparent text-[var(--text-primary)]',
          '[&:hover:not([data-disabled])]:bg-[var(--hover)]',
          pressedSurfaceState,
        ),
        ghost: cn(
          'bg-transparent text-[var(--text-secondary)]',
          '[&:hover:not([data-disabled])]:bg-[var(--hover)]',
          pressedSurfaceState,
        ),
        danger: cn(
          // 实底危险按钮那一对(tokens.css --danger-solid):白字 6.47;❌ --danger 当底(白字 3.76),❌ --primary-fg(暗色下是深灰)。
          'bg-[var(--danger-solid)] text-[var(--danger-solid-fg)]',
          '[&:hover:not([data-disabled])]:opacity-[0.88]',
          pressedSolidState,
        ),
        // 单选项。一组里同时摆若干个、每次只有一个选中(档位、购买周期、支付方式、金额)。
        // 选中只换边框与底色 —— 不改字号、不加阴影、不放大:尺寸一变整行会跳,而这一列每次
        // 只有一个是选中的,跳动比选中态本身更抢眼。用 aria-checked 驱动,不另造 data 属性,
        // 因为这些控件本来就该是 role=radio。
        option: cn(
          'border-[var(--border)] bg-transparent text-[var(--fg)]',
          '[&:hover:not([data-disabled])]:bg-[var(--hover)]',
          pressedSurfaceState,
          // #7333 选中 = 中性实底(--muted)+ 加深一档的边,❌ 墨色粗边。
          '[&[aria-checked="true"]]:border-[var(--border-strong)] [&[aria-checked="true"]]:bg-[var(--muted)]',
        ),
      },
      // @@@ui-ruler 控件高只取 tokens 的 --control-h-*(sm 28 / md 32 / lg 36 / xl 40,触控 44),与 SearchField /
      // Field / IconButton 同一把尺子;原来 30/34/40 与输入框 34/36 错开 2px,同一行里按钮和输入框对不齐。
      size: {
        sm: 'min-h-[var(--control-h-sm)] px-3 max-[719px]:min-h-[var(--control-h-touch)]',
        md: 'min-h-[var(--control-h-md)] px-3 max-[719px]:min-h-[var(--control-h-touch)]',
        lg: 'min-h-[var(--control-h-lg)] px-4 max-[719px]:min-h-[var(--control-h-touch)]',
        xl: 'min-h-[var(--control-h-xl)] px-5 max-[719px]:min-h-[var(--control-h-touch)]',
        icon: 'min-h-[var(--control-h-md)] w-[var(--control-h-md)] px-0 max-[719px]:min-h-[var(--control-h-touch)] max-[719px]:w-[var(--control-h-touch)]',
        // 选项行:44px 是仓库 UI 规范的触控目标下限;允许换行与左对齐,因为选项常有第二行说明。
        option: 'min-h-[44px] px-3 py-2 whitespace-normal justify-start text-left',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
)

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>['variant']>
export type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>['size']>

export interface ButtonProps extends Omit<ButtonPrimitive.Props, 'className' | 'style' | 'children'> {
  children: ReactNode
  className?: string
  style?: CSSProperties
  variant?: ButtonVariant
  size?: ButtonSize
}

/** Base UI 出行为,变体表出视觉 —— 见 design-system spec 的组件模板。 */
export function Button({
  children,
  className,
  style,
  variant = 'secondary',
  size = 'md',
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <ButtonPrimitive
      {...props}
      type={type}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size }), className)}
      style={style}
    >
      {children}
    </ButtonPrimitive>
  )
}
