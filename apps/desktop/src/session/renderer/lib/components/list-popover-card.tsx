import { type ReactNode } from 'react';
import { cn } from '@renderer/utils/utils';

export function ListPopoverCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="absolute right-6 bottom-4 left-6">
      <div
        // 它压在列表内容之上 ⇒ 是**浮层**,走与 popover.tsx 同一条配方:
        // 实色底 + --radius-surface + 一层 lift,❌ 不再叠一圈描边。
        className={cn(
          'flex items-center gap-2 rounded-surface bg-background-quaternary px-3 py-2 text-sm shadow-lift',
          className
        )}
      >
        {children}
      </div>
    </div>
  );
}
