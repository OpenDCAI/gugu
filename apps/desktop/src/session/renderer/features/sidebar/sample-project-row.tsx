import { observer } from 'mobx-react-lite';
import { FolderClosed } from '@/lib/icons';
import { Chip } from '@/components/ui/Chip';
import { isScreenView, showBesideOnScreen, showOnScreen } from '@renderer/app/screen-layout-actions';
import { screenLayout } from '@renderer/app/screen-layout';
import { SampleNewProjectButton } from '@renderer/features/sample-project/sample-new-project-button';
import { useSampleProject } from '@renderer/features/sample-project/use-sample-project';
import { appState, sidebarStore } from '@renderer/lib/stores/app-state';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { ProjectRowTitle } from './project-row-parts';
import { SidebarMenuAction, SidebarMenuRow, sidebarGroupInsetX } from './sidebar-primitives';
import { sidebarRowContentInsetPx, sidebarRowInsetPx } from './sidebar-row-metrics';
import { SidebarTwistyLane } from './sidebar-twisty';

/**
 * 项目列表最后:示例项目那一行(#709,账号上的键说它在才有),和用户自己一个项目都没有时那一句空状态。
 * 那一行和项目行同一套列(车道、文件夹、名字),名字后面一枚「示例」;点它马上打开那一块 —— 内容在包里,❌ 读网络。
 */
export const SampleProjectSidebar = observer(function SampleProjectSidebar() {
  const { translate } = useSessionMessages();
  const sample = useSampleProject();
  const empty = sidebarStore.sidebarProjects.length === 0;
  return (
    <>
      {/* 和项目行同一层列表留白(虚拟列表里那一层),选中底色才和项目行一样收在两边。 */}
      {sample.shown ? (
        <div className={sidebarGroupInsetX}>
          <SampleProjectRow />
        </div>
      ) : null}
      {empty && sample.settled ? (
        <div className="flex flex-col items-start gap-2 py-2 pr-3" style={{ paddingInlineStart: `${sidebarRowContentInsetPx('project')}px` }} data-projects-empty="">
          <p className="m-0 text-sm text-foreground-muted">{translate(sample.shown ? 'projects.sample.emptyWithSample' : 'projects.sample.empty')}</p>
          <SampleNewProjectButton />
        </div>
      ) : null}
    </>
  );
});

const SampleProjectRow = observer(function SampleProjectRow() {
  const { translate } = useSessionMessages();
  const name = translate('projects.sample.name');
  const focused = screenLayout.focusedBlockId ? screenLayout.blocks.get(screenLayout.focusedBlockId) : undefined;
  const active = focused?.kind === 'sample-project' && isScreenView(appState.navigation.currentViewId);
  const open = (beside: boolean) => {
    // ⌘ 点 = 拼到正看着那块右边,和项目行同一个手势。
    if (beside && isScreenView(appState.navigation.currentViewId)) showBesideOnScreen({ kind: 'sample-project' });
    else showOnScreen({ kind: 'sample-project' });
  };
  return (
    <SidebarMenuRow
      className="group/row flex h-9 items-center justify-between gap-1 pr-1"
      style={{ paddingInlineStart: `${sidebarRowInsetPx('project')}px` }}
      data-active={active || undefined}
      isActive={active}
      data-tour="sample-project"
      tabIndex={0}
      role="treeitem"
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => open(event.metaKey || event.ctrlKey)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') open(false);
      }}
    >
      <SidebarTwistyLane expanded={false} label={name} />
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <FolderClosed className="size-4 shrink-0" />
        <SidebarMenuAction aria-label={translate('sidebar.openProject', { project: name })} className="truncate font-medium transition-colors select-none">
          <ProjectRowTitle name={name} keepChildren>
            <Chip>{translate('projects.sample.tag')}</Chip>
          </ProjectRowTitle>
        </SidebarMenuAction>
      </div>
    </SidebarMenuRow>
  );
});
