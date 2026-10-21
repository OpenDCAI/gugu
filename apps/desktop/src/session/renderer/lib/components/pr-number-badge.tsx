import { cn } from '@renderer/utils/utils';

export function PrNumberBadge({ number, className }: { number: number; className?: string }) {
  return (
    // PR 号是标识符也是计数 —— 与同一行的分支名(pr-merge-line 用 font-mono)同族。
    // 原来这里写死 font-sans,同一条信息两半用两种字。
    <span className={cn('font-mono text-tiny tracking-tight text-foreground-muted shrink-0', className)}>
      #{number}
    </span>
  );
}
