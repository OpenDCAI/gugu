import { FolderClosed, Plus, ShieldAlert, Trash2, TriangleAlert } from '@/lib/icons'
import { observer } from 'mobx-react-lite';
import React, { useCallback, useEffect } from 'react';
import { useConfirmDeleteProject } from '@renderer/features/projects/hooks/use-confirm-delete-project';
import {
  isUnregisteredProject,
  type UnregisteredProject,
} from '@renderer/features/projects/stores/project';
import {
  getProjectStore,
  getGitRepositoryStore,
  projectViewKind,
} from '@renderer/features/projects/stores/project-selectors';
import {
  useNavigate,
  useParams,
  useWorkspaceSlots,
} from '@renderer/lib/layout/navigation-provider';
import { appState, sidebarStore } from '@renderer/lib/stores/app-state';
import { showBesideOnScreen } from '@renderer/app/screen-layout-actions';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@renderer/lib/ui/context-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/utils/utils';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { HOME_PROJECT_LABEL } from '@renderer/features/remote-hosts/machine-home';
import { sessionKeyboardNav } from './session-keyboard-nav';
import { ProjectNeedsYouDot, ProjectRowTitle } from './project-row-parts';
import { RemoteHostChip } from './remote-host-chip';
import { SidebarUnreadCount } from './sidebar-list-switch';
import { useSidebarChatSignals } from '@/lib/sidebarChatsBridge';
import { projectGroupsStore } from '@renderer/features/projects/stores/project-groups-store';
import {
  SidebarItemMiniButton,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuRow,
  sidebarDropTargetClass,
} from './sidebar-primitives';
import { useSessionDropTarget } from './use-session-drop-target';
import { moveSessionUnder } from '@renderer/features/sessions/set-session-parent-flow';
import { sidebarRowInsetPx } from './sidebar-row-metrics';
import { SidebarTwistyLane } from './sidebar-twisty';
import type { SessionMessageKey } from '@renderer/localization/messages';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';

// 转圈 tooltip 的三个进行中档位与主面板的阶段清单是同一批语义(pending-project.tsx),
// 复用同一批 key;省略号是这一面自己的("还在跑"),所以在下面拼,不进文案。
const UNREGISTERED_PHASE_KEY: Record<UnregisteredProject['phase'], SessionMessageKey> = {
  'creating-repo': 'projects.pending.creatingRepo',
  cloning: 'projects.pending.cloning',
  registering: 'projects.pending.registering',
  error: 'sidebar.projectPhase.failed',
};

/**
 * 「项目」分区的一行。#6264 别的机器上的项目也是这一行(按 Zed:设备范围属于项目,具体设备属于文件夹):项目行汇总设备数量,
 * 机器前那颗点是连接状态;那台机器没连上时整行灰掉、悬停说清楚,项目照样列着(behavior gugu-server)。
 */
export const SidebarProjectItem = observer(function SidebarProjectItem({
  projectId,
}: {
  projectId: string;
}) {
  const { navigate } = useNavigate();
  const { currentView } = useWorkspaceSlots();
  const { params: projectParams } = useParams('project');
  const { params: sessionParams } = useParams('session');
  const confirmDeleteProject = useConfirmDeleteProject();
  const { translate } = useSessionMessages();

  const project = getProjectStore(projectId);

  const prefetchRepository = useCallback(() => {
    const repo = getGitRepositoryStore(projectId);
    void repo?.localData.load();
    void repo?.remoteData.load();
  }, [projectId]);

  const currentProjectId =
    currentView === 'session'
      ? sessionParams.projectId
      : currentView === 'project'
        ? projectParams.projectId
        : null;
  const currentSessionId = currentView === 'session' ? sessionParams.sessionId : null;

  const isProjectActive = currentProjectId === projectId && !currentSessionId;

  useEffect(() => {
    if (isProjectActive) prefetchRepository();
  }, [isProjectActive, prefetchRepository]);

  const isExpanded = sidebarStore.expandedProjectIds.has(projectId);
  // spec session-page 链6: a collapsed project whose conversations are waiting on the human shows an
  // amber dot on its row — raw status, so viewing a conversation never clears it; it fades only
  // when the "needs you" count returns to zero. When expanded, the per-section header carries it.
  const needsYouCount = sidebarStore.needsYouCountForProject(projectId);
  // gugu-dev#181 项目就是群:行尾挂项目群的未读(含它的话题),壳发过来的那一份;真读了才减。
  const groupChatId = projectGroupsStore.chatIdOf(projectId);
  const groupUnread = useSidebarChatSignals()?.groupUnread.get(groupChatId ?? '') ?? 0;
  // 挂在别的会话下面的一条拖回它自己的项目行 = 回到根(spec session-page「把会话拖成 child」)。
  // 只有它不挂着时本来就显示在这一行的才收:换项目不是这个动作。
  const unnestDrop = useSessionDropTarget();
  const unnestHere = unnestDrop.bind(
    (dragged) => sidebarStore.parentOf(dragged.sessionId) !== null && sidebarStore.rootRowOf(dragged.sessionId) === projectId,
    (child) => moveSessionUnder(child, null, sidebarStore.parentOf(child.sessionId))
  );

  if (!project) return null;
  // #6264 别的机器上的项目:行上标机器名;没连上时整行灰掉(项目照样列着)。
  const machine = remoteHostsStore.machineOfProject(projectId);
  const machineState = machine ? remoteHostsStore.connectionState(machine.id) : null;
  const singleMachineDown = !!machine && machineState !== 'connected';

  const ProjectIcon = FolderClosed;
  // #6264 别的机器的主目录项目叫「~」(后面挨着机器名);还没有主目录项目时由那台机器的任务工作区代位,
  // 在这一行上新建 = 去新建页、预选那台机器(没选项目 = 落在它的主目录项目里)。
  const isHomeRow = sidebarStore.homeLayout.homeRows.has(projectId);
  const deviceIds = [...new Set(sidebarStore.projectMembersOf(projectId).map((id) => machineRegistry.machineOf(id) ?? null))];
  const machineDown = isHomeRow ? singleMachineDown : deviceIds.every((id) => id !== null && remoteHostsStore.connectionState(id) !== 'connected');
  const deviceLabels = deviceIds.map((id) => id ? remoteHostsStore.device(id)?.label ?? id : translate('projects.folders.thisComputer'));
  const standInDevice = sidebarStore.homeLayout.standIns.get(projectId) ?? null;
  // #7199 个人助理住的那台(用户看不到它住在哪,owner 10-15):它的主目录那一组就是「它派出的任务」—— 组名是它的名字
  // (宿主那一侧把那台的 label 换成了它的名字)、不挂机器名;那台不接人开的任务:❌ 新建、❌ 点进项目页(那里有新建框)、❌ 移除。
  const assistantHome = machine?.assistantHome === true;
  const assistantGroup = assistantHome && isHomeRow;
  // #7341 第二步:并在这一行里的、别的机器上的同一个项目所在的机器。
  const projectLabel = assistantGroup ? machine.label : isHomeRow ? HOME_PROJECT_LABEL : (project.name ?? 'project');
  // spec session-page-remote: 同名歧义以完整路径作次级文本区分——仅当另有同名的一行时显示,常态零噪音。
  const hasNameTwin = !isHomeRow && sidebarStore.hasNameTwin(projectId);
  const openHomeComposer = (deviceId: string) => {
    remoteHostsStore.requestNewSession(deviceId, null);
    navigate('new-session');
  };
  const disambiguationPath = hasNameTwin ? project.data?.path : undefined;
  // spec session-page 微决策: first click selects the project (home view + expand); clicking the
  // already-selected project row toggles its collapse — the row is the second collapse affordance
  // beside the folder/chevron button (why B saw "active project won't collapse": B clicked the row).
  const openProject = (beside = false) => {
    // behavior session-page「键盘导航」: the project row is a station too, so a click moves the cursor
    // onto it — ↓ afterwards continues from here.
    sessionKeyboardNav.syncCursorFromPointer({ kind: 'project', projectId });
    // ⌘ 点 = 项目块拼到正看着那块右边(gugu-dev#181:项目是一块,和会话行同一个手势)。
    const onScreen = appState.navigation.currentViewId === 'session' || appState.navigation.currentViewId === 'project';
    if (beside && onScreen && !standInDevice && !assistantHome) {
      showBesideOnScreen({ kind: 'project', projectId: sidebarStore.rowProjectIdOf(projectId) });
      sidebarStore.ensureProjectExpanded(projectId);
      return;
    }
    if (isProjectActive) {
      sidebarStore.toggleProjectExpanded(projectId);
      return;
    }
    if (standInDevice || assistantHome) {
      sidebarStore.toggleProjectExpanded(projectId);
      return;
    }
    navigate('project', { projectId });
    sidebarStore.ensureProjectExpanded(projectId);
  };

  // The project-row action opens the existing project-scoped composer. It must not eagerly
  // create the session page's backing task; that happens only after the user submits the composer.
  const openNewSession = () => {
    sessionKeyboardNav.syncCursorFromPointer({ kind: 'project', projectId });
    if (standInDevice) return openHomeComposer(standInDevice);
    if (!isProjectActive) navigate('project', { projectId });
    sidebarStore.ensureProjectExpanded(projectId);
  };

  const projectCursor = sessionKeyboardNav.cursor;
  const isProjectCursor = projectCursor?.kind === 'project' && projectCursor.projectId === projectId;

  const renderSpinnerWithTooltip = () => {
    if (!isUnregisteredProject(project)) return null;
    const phaseKey = UNREGISTERED_PHASE_KEY[project.phase];
    const label = phaseKey
      ? project.phase === 'error'
        ? translate(phaseKey)
        : `${translate(phaseKey)}…`
      : `${translate('sidebar.projectPhase.loading')}…`;
    return (
      <Tooltip>
        <TooltipTrigger
          render={<span className="flex size-4 shrink-0 items-center justify-center" />}
          aria-label={translate('sidebar.projectPhase.loading')}
        >
          {/* 转圈占的是**图标位**,不再套一个 24px 迷你钮 —— 那个钮当初兼着「点它折叠」,
              折叠现在归车道里的箭头,钮就只剩一个比图标大的盒子,会把这一行的图标顶偏。 */}
          <LoadingIndicator size="inline" className="text-foreground/60" />
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    );
  };

  return (
    // 代位的是那台机器的任务工作区,移除它会让那些会话无处可挂:这一行没有「移除」菜单。
    <ContextMenu disabled={!!standInDevice || assistantHome}>
      <ContextMenuTrigger>
        <SidebarMenuRow
          // @@@sidebar-row-metrics — 与会话行同一套列:[车道][图标][标题]。
          // 原来是 `px-1` + 迷你钮内的 4px 把字形顶到 20px 那条内容列上;现在车道自己占掉前 20px,
          // 文件夹字形落在 32、项目名落在 52 —— 而项目底下那些会话的身份图标也正是 52,
          // 「会话对齐到项目名」这条关系换算过来仍然成立(数见 sidebar-row-metrics.ts)。
          className={cn('group/row flex h-9 items-center justify-between gap-1 pr-1', unnestDrop.over && sidebarDropTargetClass)}
          style={{ paddingInlineStart: `${sidebarRowInsetPx('project')}px` }}
          data-unnest-target={unnestDrop.over || undefined}
          {...unnestHere}
          data-active={isProjectActive || undefined}
          isActive={isProjectActive}
          isCursor={isProjectCursor}
          data-project-row={projectId}
          data-remote-device={isHomeRow ? machine?.id : undefined}
          data-offline={machineDown || undefined}
          tabIndex={0}
          role="treeitem"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(event) => openProject(event.metaKey || event.ctrlKey)}
          onKeyDown={(e) => {
            // Arrows belong to the session navigation listener (see sidebar-session-item for
            // why the old sibling walk could not work here either).
            if (e.key === 'Enter') openProject();
          }}
        >
          {/* 折叠箭头与会话行同一个原语、同一条车道(见 sidebar-twisty.tsx)。
              原来这里是另一套:在**图标位上**让 folder 与 chevron 交叉淡入淡出。那套不位移,
              但与会话行不同形 —— 同一条侧栏两种折叠惯用法(owner 2026-09-07:「项目行的折叠要统一」)。
              换过来之后文件夹图标常驻不再消失,箭头有自己的位置。 */}
          <SidebarTwistyLane
            expanded={isExpanded}
            label={`${isExpanded ? 'Collapse' : 'Expand'} ${projectLabel}`}
            onToggle={
              project.state === 'unregistered'
                ? undefined
                : () => sidebarStore.toggleProjectExpanded(projectId)
            }
          />
          <div className="flex min-w-0 flex-1 items-center gap-1">
            {project.state === 'unregistered' ? (
              renderSpinnerWithTooltip()
            ) : (
              <ProjectIcon className={cn('size-4 shrink-0', machineDown && 'opacity-60')} />
            )}
            <SidebarMenuAction
              aria-label={`Open project ${projectLabel}`}
              className={cn(
                'truncate font-medium transition-colors select-none',
                (projectViewKind(getProjectStore(projectId)) === 'bootstrapping' || machineDown) &&
                  'text-foreground-tertiary-passive',
                isHomeRow && machine && 'flex-initial'
              )}
            >
              <ProjectRowTitle name={isHomeRow ? projectLabel : project.name}>
                {disambiguationPath ? (
                  <span title={disambiguationPath} className="text-foreground-tertiary-passive min-w-0 max-w-[40%] shrink-[3] truncate text-xs">
                    {disambiguationPath}
                  </span>
                ) : null}
                {projectViewKind(project) === 'path_not_found' && (
                  <Tooltip>
                    <TooltipTrigger>
                      <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-foreground-destructive" />
                    </TooltipTrigger>
                    <TooltipContent>{translate('sidebar.projectMissing')}</TooltipContent>
                  </Tooltip>
                )}
                {projectViewKind(project) === 'permission_blocked' && (
                  <Tooltip>
                    <TooltipTrigger>
                      <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-foreground-warning" />
                    </TooltipTrigger>
                    <TooltipContent>{translate('sidebar.projectUnreadable')}</TooltipContent>
                  </Tooltip>
                )}
              </ProjectRowTitle>
            </SidebarMenuAction>
            {isHomeRow && machine && !assistantGroup ? <RemoteHostChip deviceId={machine.id} /> : null}
            {!isHomeRow && deviceIds.length > 1 ? (
              <span className="shrink-0 text-xs font-normal text-foreground-passive" title={deviceLabels.join(' · ')} data-testid="project-device-count">
                {translate('projects.folders.deviceCount', { count: deviceIds.length })}
              </span>
            ) : null}
            {!isExpanded && <ProjectNeedsYouDot count={needsYouCount} />}
          </div>
          <SidebarUnreadCount count={groupUnread} />
          {assistantHome ? null : (
            <Tooltip>
              <TooltipTrigger
                className="h-6"
                render={
                  <SidebarItemMiniButton
                    type="button"
                    aria-label={translate('sidebar.newSessionIn', { project: projectLabel })}
                    className={
                      'opacity-0 transition-opacity duration-[var(--dur-fast,120ms)] group-hover/row:opacity-100'
                    }
                    onPointerEnter={() => prefetchRepository()}
                    onClick={(e) => {
                      e.stopPropagation();
                      openNewSession();
                    }}
                    disabled={project.state === 'unregistered'}
                  >
                    <Plus className="h-4 w-4" />
                  </SidebarItemMiniButton>
                }
              />
              <TooltipContent>{translate('sidebar.newSession')}</TooltipContent>
            </Tooltip>
          )}
        </SidebarMenuRow>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          variant="destructive"
          onClick={() => {
            void confirmDeleteProject({
              projectId,
              projectLabel: project.name ?? translate('projects.fallbackName'),
              onDeleted: () => {
                if (isProjectActive) navigate('home');
              },
            });
          }}
        >
          <Trash2 className="size-4" />
          {translate('projects.titlebar.remove')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

interface BaseProjectItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  isActive: boolean;
}

export function BaseProjectItem({ isActive, className, ...props }: BaseProjectItemProps) {
  return (
    <SidebarMenuButton
      className={cn('justify-between flex item px-1 py-1', className)}
      isActive={isActive}
      {...props}
    />
  );
}
