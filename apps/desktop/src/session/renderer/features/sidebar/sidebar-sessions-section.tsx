import { SquarePen } from '@/lib/icons'
import { observer } from 'mobx-react-lite';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/utils/utils';
import { SidebarMoreRow } from './sidebar-more-row';
import { SidebarSessionItem } from './sidebar-session-item';
import {
  SidebarGroup,
  SidebarMenu,
  sidebarGroupHeaderClass,
  sidebarHeaderDropTargetClass,
  sidebarHeaderIconButtonClass,
} from './sidebar-primitives';
import { SidebarStateHeader } from './sidebar-state-header';
import { SidebarGroupToggle } from './sidebar-group-toggle';
import { useSessionDropTarget } from './use-session-drop-target';
import { moveSessionUnder } from '@renderer/features/sessions/set-session-parent-flow';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

// spec session-page「任务分区」: sessions created 按任务 (standalone tasks, no project) list here,
// fully equal to project sessions. ✏️ opens the centered 新建任务 page (spec 任务分区 ✏️,
// owner: 创建任务 = 居中整页 composer); 会话内「侧边任务」 creates silently.
export const SidebarSessionsSection = observer(function SidebarSessionsSection() {
  const entries = sidebarStore.standaloneSessionEntries;
  const groups = sidebarStore.standaloneSessionGroups;
  const more = sidebarStore.standaloneMore;
  const { navigate } = useNavigate();
  const { translate } = useSessionMessages();
  // 挂在别的会话下面的一条(不在任何项目里的那种)拖回这个分区头 = 回到根 —— 与项目行同一个动作(见 project-item)。
  const unnestDrop = useSessionDropTarget();
  const unnestHere = unnestDrop.bind(
    (dragged) => sidebarStore.parentOf(dragged.sessionId) !== null && sidebarStore.rootRowOf(dragged.sessionId) === null,
    (child) => moveSessionUnder(child, null, sidebarStore.parentOf(child.sessionId))
  );

  return (
    <SidebarGroup className="group/sessions mb-0 flex shrink-0 flex-col">
      <div
        className={cn(sidebarGroupHeaderClass, unnestDrop.over && sidebarHeaderDropTargetClass)}
        data-unnest-target={unnestDrop.over || undefined}
        data-sessions-section-header=""
        {...unnestHere}
      >
        <SidebarGroupToggle
          label={translate('sidebar.tasks')}
          count={sidebarStore.standaloneRootCount}
          collapsed={sidebarStore.sessionsCollapsed}
          onToggle={() => sidebarStore.toggleSessionsCollapsed()}
          ariaLabel={
            sidebarStore.sessionsCollapsed
              ? translate('sidebar.expandTasks')
              : translate('sidebar.collapseTasks')
          }
        />
        {/* 三个分区头的右侧动作共用同一种视觉(sidebarHeaderIconButtonClass);
            ❌ 别在这里另配一档 hover 底色 —— 项目头的两个按钮就在上面几行,差一档就看得出来。 */}
        <span className="hidden items-center gap-1 group-hover/sessions:flex">
          <Tooltip>
            <TooltipTrigger render={
              <button
                type="button"
                aria-label={translate('sidebar.newTask')}
                onClick={() => navigate('new-session')}
                className={sidebarHeaderIconButtonClass}
              >
                <SquarePen />
              </button>
            } />
            <TooltipContent>{translate('sidebar.newTask')}</TooltipContent>
          </Tooltip>
        </span>
      </div>
      {!sidebarStore.sessionsCollapsed &&
        (entries.length === 0 ? (
          // px-5 = 内容列(list body 12 + 8):空态那句话与它替代掉的那些会话行左缘同列。
          <div className="animate-in fade-in px-5 pb-2 text-xs text-foreground-muted duration-[var(--dur-med,180ms)]">
            {translate('sidebar.noTasks')}
          </div>
        ) : (
          <SidebarMenu className="animate-in fade-in pb-1 duration-[var(--dur-med,180ms)]">
            {groups.map(({ group, entries: bucket }) => (
              <div key={group ?? 'idle'}>
                {group && (
                  <div className="h-6">
                    <SidebarStateHeader group={group} count={bucket.length} variant="section" />
                  </div>
                )}
                {bucket.map(
                  ({ projectId, sessionId, depth, parentProjectId, hasChildren, needsAttention, join }) => (
                    <SidebarSessionItem
                      key={sessionId}
                      projectId={projectId}
                      sessionId={sessionId}
                      rowVariant="section"
                      depth={depth}
                      parentProjectId={parentProjectId}
                      hasChildren={hasChildren}
                      expanded={sidebarStore.expandedSessionIds.has(sessionId)}
                      needsAttention={needsAttention}
                      onToggle={() => sidebarStore.toggleSessionExpanded(sessionId)}
                      join={join}
                    />
                  )
                )}
              </div>
            ))}
            {more && <SidebarMoreRow {...more} />}
          </SidebarMenu>
        ))}
    </SidebarGroup>
  );
});
