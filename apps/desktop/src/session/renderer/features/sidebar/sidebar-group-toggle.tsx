import { ChevronDown } from '@/lib/icons';
import { MicroLabel } from '@renderer/lib/ui/label';
import { cn } from '@renderer/utils/utils';
import { sidebarCountClass, sidebarGroupTitleClass } from './sidebar-primitives';

// 三个分区头(置顶 / 项目 / 任务)的收起开关,只写这一处。收起以后下面一行都不剩,所以收起时
// 标题后带上数量、箭头常显 —— 一眼看得出「这里有东西,只是收起来了」(owner 10-18:置顶收起后以为没有置顶)。
// 数量为 0 不显示。箭头展开时只在悬停整条分区头(sidebarGroupHeaderClass 的 group/ghdr)时出现。
export function SidebarGroupToggle({
  label,
  count,
  collapsed,
  onToggle,
  ariaLabel,
}: {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      className="group/glabel flex cursor-pointer items-center gap-1"
      onClick={onToggle}
      aria-label={ariaLabel}
    >
      {/* @@@sidebar-type-scale (owner 2026-09-05,以 Codex 实测为准) —
          字号:Codex 的同位标题(置顶/项目/最近)实测 13.5px,咕咕原来 11.5px。
          咕咕刻度只有 14/12,13.5 落到 14(text-sm),覆盖掉 MicroLabel 自带的 text-xs。
          颜色:Codex 这一档是 #A8A9A9,咕咕原来用 tertiary-passive → 渲染成 #737373,
          跟正文几乎同色,所以整条栏是平的。改用 foreground-passive → 皮肤下是
          --faint-fg #9A9AA2,与 Codex 的 #A8A9A9 基本重合。
          「标题不比正文小、但明显更浅」正是 Codex 拉开层级的路子。
          10-28:faint 在侧栏底上只有 2.96(浅)/ 3.89(深),不到 4.5 → 静止态改 foreground-muted(5.22 / 6.10),
          仍比行字浅一档;悬停 / 按下到 foreground。 */}
      <MicroLabel
        className={cn(
          sidebarGroupTitleClass,
          'transition-colors group-hover/glabel:text-foreground group-active/glabel:text-foreground'
        )}
      >
        {label}
      </MicroLabel>
      {collapsed && count > 0 && (
        <span className={sidebarCountClass}>{count}</span>
      )}
      <ChevronDown
        className={cn(
          'size-3.5 text-foreground-passive opacity-0 transition-[opacity,rotate] duration-[var(--dur-med)] [transition-timing-function:var(--ease)] group-hover/ghdr:opacity-100',
          collapsed && '-rotate-90 opacity-100'
        )}
      />
    </button>
  );
}
