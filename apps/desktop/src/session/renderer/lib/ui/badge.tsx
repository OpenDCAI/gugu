import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@renderer/utils/utils';

const badgeVariants = cva(
  // @@@radius-scale + @@@type-role (Refs #6106) — Badge 是全站被复制最多的基元:
  // 它是胶囊,胶囊语言就会散到整个产品。半径表里 --radius-capsule 只给 switch / 头像 / 状态点,
  // 徽标落 sm(6px)那一档。字号从一次性的像素值收到 --text-tiny(11px)。
  'group/badge inline-flex h-4.5 w-fit shrink-0 text-tiny items-center justify-center gap-1 overflow-hidden rounded-sm border border-transparent px-1.5 py-0.5 font-medium whitespace-nowrap transition-all has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-border-destructive [&>svg]:pointer-events-none [&>svg]:size-3!',
  {
    variants: {
      variant: {
        default: 'bg-background text-foreground [a]:hover:bg-row-hover',
        secondary: 'bg-background-2 text-foreground-muted [a]:hover:bg-row-hover',
        destructive:
          'bg-background-destructive text-foreground-destructive [a]:hover:bg-background-error-hover',
        outline: 'border-border text-foreground [a]:hover:bg-row-hover [a]:hover:text-foreground-muted',
        ghost: 'hover:bg-row-hover hover:text-foreground-muted',
        link: 'text-foreground-info underline-offset-4 hover:underline',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

function Badge({
  className,
  variant = 'default',
  render,
  ...props
}: useRender.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: 'span',
    props: mergeProps<'span'>(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: 'badge',
      variant,
    },
  });
}

export { Badge, badgeVariants };
