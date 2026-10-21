import type { ComponentProps } from 'react';
import { cn } from '@renderer/utils/utils';
import { MicroLabel } from '../ui/label';

export function CardGrid({ children, className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'grid grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-3',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardGridSection({
  children,
  title,
  className,
  ...props
}: ComponentProps<'div'> & { title: string }) {
  return (
    <div className={cn('flex flex-col gap-2', className)} {...props}>
      <MicroLabel>{title}</MicroLabel>

      <CardGrid>{children}</CardGrid>
    </div>
  );
}

export function CardGridItem({ children, className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'group flex w-full cursor-pointer items-center gap-3 rounded-lg border border-border bg-background-1 hover:state-hover-layer active:state-press-layer p-4 text-left text-foreground transition-all',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}
