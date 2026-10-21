'use client';

import { Toggle as TogglePrimitive } from '@base-ui/react/toggle';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@renderer/utils/utils';

// @@@state-ladder-mix ⚠️ Base UI 的 `data-pressed` 在 Toggle 上表达的是「开着」(持久选中),不是「正被按住」——
// 本轮批量迁移一度把它当按下档改成了 row-press,那会让「开着」看起来像手指还没松开。开态属于
// **容器级激活**(spec:tab/分段选中=实底色块,与行选中两种语义),所以留在 --muted 族;真正的按下
// 另走 `active:`。
const toggleVariants = cva(
  "group/toggle inline-flex border items-center text-foreground-muted data-pressed:text-foreground justify-center gap-1 rounded-lg  font-normal whitespace-nowrap transition-[color,background-color,box-shadow] hover:bg-row-hover active:bg-row-press hover:text-foreground data-pressed:bg-background-2 data-pressed:hover:state-hover-layer data-pressed:active:state-press-layer disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        default: 'bg-transparent',
        outline: 'border border-border',
      },
      size: {
        default: 'h-8 min-w-8 px-2 text-sm',
        sm: 'h-7 min-w-7 px-1.5 text-xs',
        xs: 'h-6 min-w-6 px-1 text-xs',
        'icon-sm': 'h-7 w-7 px-0!',
        'icon-xs': 'h-6 w-6 px-0!',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

function Toggle({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Toggle, toggleVariants };
