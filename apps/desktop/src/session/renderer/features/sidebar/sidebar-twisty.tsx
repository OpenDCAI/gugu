import { ChevronRight } from '@/lib/icons';
import { cn } from '@renderer/utils/utils';

/**
 * @@@sidebar-twisty — 侧栏折叠箭头,**项目行与会话行共用这一个**。
 *
 * 两条纪律写在这里,不写在调用点:
 *
 * ① **车道恒宽,叶子行也让。** 占位的是外层 span、可点的是里面的 button —— 没有子项的行
 *    因此不会渲染出一个点不动的按钮,而标题落在哪一列与「这一行有没有子项」无关。
 *    箭头原来是行内第一个 flex 子元素、只有有子项的行才长出来,于是那一行比左右邻居往右缩
 *    20px(owner 2026-09-07 实机:「放那里成缩进了」)。
 *
 * ② **静止时不显形。** 只在行悬停 / 键盘光标停在这一行 / 它自己拿到焦点时淡入(照 owner
 *    给的参考件:飞书文档侧栏)。一整列常驻箭头会跟标题抢注意力;「这一行底下还有东西」
 *    由展开出来的子行自己说。
 *
 * 项目行原先是另一套写法 —— 在图标位上让 folder 与 chevron 交叉淡入淡出。那套不位移,但与
 * 会话行不同形,同一条侧栏里两种折叠惯用法(owner 2026-09-07:「项目行的折叠要统一」)。
 * ❌ 别再在调用点手写第二个箭头:behavior ui-interaction-states「同一交互=同一反馈」。
 *
 * 车道的宽度是 `SIDEBAR_TWISTY_LANE_PX`(16px 钮 + 行的 gap-1),几何见 sidebar-row-metrics.ts。
 */
export function SidebarTwistyLane({
  expanded,
  onToggle,
  label,
}: {
  expanded: boolean;
  /** 省略 = 这一行没有可展开的东西:车道照占,不渲染按钮。 */
  onToggle?: () => void;
  label: string;
}) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      {onToggle ? (
        <button
          type="button"
          className="flex size-4 items-center justify-center rounded-sm text-foreground-tertiary-passive opacity-0 transition-opacity duration-[var(--dur-fast,120ms)] ease-out group-hover/row:opacity-100 group-data-[nav-cursor=true]/row:opacity-100 focus:opacity-100 hover:bg-row-hover hover:text-foreground active:bg-row-press"
          aria-label={label}
          aria-expanded={expanded}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
        >
          {/* 一个字形转 90°,不是两个字形互换 —— 才有得过渡
              (behavior ui-interaction-states「尺寸变化必须过渡」同族)。 */}
          <ChevronRight
            className={cn(
              'size-3.5 transition-transform duration-[var(--dur-fast,120ms)] ease-out',
              expanded && 'rotate-90'
            )}
          />
        </button>
      ) : null}
    </span>
  );
}
