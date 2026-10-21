import { sidebarStore } from '@renderer/lib/stores/app-state';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { SidebarMenuAction, SidebarMenuRow } from './sidebar-primitives';

// @@@sessionpage — "Show more / Show less" toggle for the idle families folded away in a project or the
// Tasks section (spec session-page: idle families beyond the cap collapse behind this row, Codex's 展开显示).
export function SidebarMoreRow({
  foldKey,
  expanded,
  hiddenCount,
}: {
  /** 项目 id,或「任务」分区的键(sidebarStore.standaloneMore)。 */
  foldKey: string;
  expanded: boolean;
  hiddenCount: number;
}) {
  const { translate } = useSessionMessages();
  const label = expanded
    ? translate('sidebar.showLess')
    : translate('sidebar.showMore', { count: hiddenCount });
  return (
    <SidebarMenuRow
      className="group/row flex items-center px-1 py-1 h-8 pl-8"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => sidebarStore.toggleIdleExpanded(foldKey)}
    >
      <SidebarMenuAction aria-label={label} className="text-foreground-passive">
        {label}
      </SidebarMenuAction>
    </SidebarMenuRow>
  );
}
