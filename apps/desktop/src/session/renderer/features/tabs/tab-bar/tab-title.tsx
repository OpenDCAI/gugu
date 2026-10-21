import { cn } from '@renderer/utils/utils';

export function TabTitle({
  isActive,
  /**
   * 分屏时哪个面板握着焦点。默认 true:只有一列的贴条(草稿工作区面板)没有「另一个面板」
   * 可以夺走焦点。❌ 别改回读 PaneContext —— 那会把这个纯展示组件焊死在 <PaneProvider> 里,
   * 而草稿那条贴条压根没有 pane。
   */
  isFocusedPane = true,
  isPreview,
  hasError,
  maxWidth = 'max-w-[200px]',
  className,
  children,
}: {
  isActive: boolean;
  isFocusedPane?: boolean;
  isPreview?: boolean;
  hasError?: boolean;
  maxWidth?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        'truncate p-1 text-sm opacity-85 group-hover:opacity-100 transition-opacity',
        maxWidth,
        isPreview && 'italic',
        isActive && isFocusedPane && 'opacity-100',
        hasError && 'text-foreground-destructive',
        className
      )}
    >
      {children}
    </span>
  );
}
