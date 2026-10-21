import { cn } from '@renderer/utils/utils';

/**
 * 多行列表行。行**不靠分隔线**分隔 —— 四十行四十条发丝线是个笼子
 * (design.md:「Rows breathe on rhythm and a hover fill … not on dividers」),
 * 节奏交给 py + hover 叠色。
 *
 * ⚠️ 这里从前还有一个 `isLast?: boolean`,标着 @deprecated「不再有效…下次路过时删掉传参」。
 * 2026-09-22 路过了(Refs #6104):唯一的调用点(prompt-library-view)一直在算那个下标并传进来,
 * 而这里收下之后一个字都没用 —— 一个不影响渲染的参数比没有参数更贵:读的人得自己去确认它是死的。
 */
export function MultiLineListItem({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className="flex flex-col gap-2 py-1">
      <div
        className={cn(
          'flex relative items-start gap-3 rounded-lg p-3 py-4 hover:bg-row-hover transition-colors group',
          className
        )}
      >
        {children}
      </div>
    </div>
  );
}
