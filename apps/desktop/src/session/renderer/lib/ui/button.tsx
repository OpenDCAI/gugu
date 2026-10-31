import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@renderer/utils/utils';

// The unlayered shell button reset otherwise replaces this entire transition declaration.
const shellSafeTransition =
  '!transition-[background-color,border-color,color,opacity,box-shadow,transform,filter] !duration-[var(--dur-fast)] ease-out motion-reduce:!transition-none';

const buttonVariants = cva(
  `group/button inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-clip-padding text-sm font-normal whitespace-nowrap ${shellSafeTransition} select-none disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4`,
  {
    variants: {
      variant: {
        // @@@state-ladder-mix (#2322) 两条配方,按底色实不实分:
        //   · 实色/实底(default、destructive)走**透明度阶梯** hover .88 → 按下 .78,
        //     不换底色、不缩放(product spec「反馈的克制」;与咕咕主体的
        //     .gg-fill 同一配方)。default 以前 hover 换成 primary-button-background-hover,
        //     那是另一种色,与主体那半边对不上。
        //   · 透明/浅底(secondary、ghost)走**叠色三件套** row-hover/press/selected;outline 有实底,悬浮 / 按下叠层(见下)。
        // 改动前**没有任何一个 variant 有按下态** —— 这是 spec 明令的六态里缺的那一态。
        default:
          'bg-primary-button-background text-primary-button-foreground hover:opacity-[.88] active:opacity-[.78] border border-primary-button-border',
        // outline 自己有一块实底(bg-background):悬浮 / 按下要叠在它上面(state-*-layer,见 index.css
        // @@@state-ladder-mix),❌ `hover:bg-row-hover` 把实底换成 4% 的半透明 —— 压在图上的按钮一悬浮就透了。
        outline:
          'border-border bg-background hover:state-hover-layer active:state-press-layer hover:text-foreground aria-expanded:bg-row-selected aria-expanded:text-foreground',
        secondary:
          'bg-background-2 text-foreground-muted hover:bg-row-hover active:bg-row-press aria-expanded:bg-row-selected aria-expanded:text-foreground-muted',
        ghost:
          'hover:bg-row-hover active:bg-row-press hover:text-foreground text-foreground-muted aria-expanded:bg-row-selected aria-expanded:text-foreground',
        destructive:
          'bg-background-destructive border border-border-destructive text-foreground-destructive hover:bg-background-error-hover active:opacity-[.78]',
        link: 'text-foreground-info',
      },
      size: {
        default:
          'h-8 gap-1.5 px-2.5 in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        xs: "h-6 gap-1 px-2 text-xs in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-7 gap-1 px-2.5 in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5',
        lg: 'h-10 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3',
        icon: 'size-8',
        'icon-xs':
          "size-6 in-data-[slot=button-group]:rounded-md [&_svg:not([class*='size-'])]:size-3",
        'icon-sm':
          'size-7 in-data-[slot=button-group]:rounded-md',
        'icon-md':
          'size-8 in-data-[slot=button-group]:rounded-md',
        'icon-lg': 'size-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

const Button = React.forwardRef<
  HTMLButtonElement,
  ButtonPrimitive.Props & VariantProps<typeof buttonVariants>
>(function Button({ className, variant = 'default', size = 'default', ...props }, ref) {
  return (
    <ButtonPrimitive
      ref={ref}
      data-slot="button"
      data-variant={variant}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
});

export { Button, buttonVariants };
