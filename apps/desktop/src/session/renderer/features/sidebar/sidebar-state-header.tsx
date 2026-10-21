import { SIDEBAR_STATE_GROUP_META, type SidebarStateGroup } from './session-groups';
import { sidebarRowContentInsetPx } from './sidebar-row-metrics';
import { sidebarCountClass } from './sidebar-primitives';
import { cn } from '@renderer/utils/utils';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

// @@@sessionpage otty-state — small AGENT-STATE section label under a project (spec session-page:
// project → state section → conversation). Non-interactive: the header carries the state + count
// (the "N need you" at-a-glance signal); conversation rows below stay title + time only.
export function SidebarStateHeader({
  group,
  count,
  variant = 'tree',
}: {
  group: SidebarStateGroup;
  count: number;
  variant?: 'tree' | 'section';
}) {
  const meta = SIDEBAR_STATE_GROUP_META[group];
  const { translate } = useSessionMessages();
  const label = {
    'needs-you': translate('sidebar.needsYou'),
    working: translate('sidebar.working'),
  }[group];
  return (
    // @@@sidebar-row-metrics — 左缘对齐的是会话行的**内容列**(身份图标/标题),不是行的左内距:
    // 行上多了一条恒宽的折叠箭头车道,组头不跟着让开的话,这条竖线就断了。数只有一个出处。
    <div
      className="flex h-full animate-in items-center gap-1.5 pr-2 duration-[var(--dur-med,180ms)] fade-in"
      style={{ paddingInlineStart: `${sidebarRowContentInsetPx(variant)}px` }}
    >
      {/* @@@sidebar-type-scale (owner 2026-09-05) — 咕咕的字号刻度只有 14 / 12 两档,
          这一档归 12(text-xs)。原来是 11 像素的任意值 —— 11 不在刻度上,是就地拍的数字。
          ❌ 别再往这里写方括号像素字号之类的字面量:一写就是新开一档。 */}
      <span className={cn('text-xs font-medium leading-none select-none', meta.className)}>
        {label}
      </span>
      {/* @@@sidebar-type-scale — 计数同样归 12(text-xs)。原来 text-[10px] 不在 14/12 刻度上。 */}
      <span className={sidebarCountClass}>{count}</span>
    </div>
  );
}
