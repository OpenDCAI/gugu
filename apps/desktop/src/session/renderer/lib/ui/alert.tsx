import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@renderer/utils/utils';

// @@@callout-rule (Refs #6106) — 原来是 `rounded-lg border`(四边盒子)。
// design.md 的 Callout 是「A quiet aside on a colored rule」,Reject 里点名「a card around every
// section, a box drawn to repair weak hierarchy」。同仓 agent-info-card 早就在用单条色线的写法,
// 两套 callout 语言并存 —— 收敛到这一套:**左侧一条 2px 的语义色线** + 一层底色,不画框、不倒角。
const alertVariants = cva(
  "group/alert relative grid w-full gap-0.5 border-l-2 px-3 py-2 text-left text-sm has-data-[slot=alert-action]:relative has-data-[slot=alert-action]:pr-18 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2.5 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current *:[svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'border-border bg-background text-foreground',
        warning:
          'bg-background-warning border-border-warning text-foreground-warning *:data-[slot=alert-description]:text-foreground-warning/90 *:[svg]:text-current',
        destructive:
          'border-border-destructive bg-background text-foreground-destructive *:data-[slot=alert-description]:text-foreground-destructive/90 *:[svg]:text-current',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        'text-sm group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground',
        className
      )}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        'text-xs text-balance text-foreground-muted md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4',
        className
      )}
      {...props}
    />
  );
}

function AlertAction({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-action"
      className={cn('absolute top-2.5 right-3', className)}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription, AlertAction };
