import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { useSessionViewContext, useWorkspace, useWorkspaceId, useWorkspaceSurface } from '@renderer/features/sessions/session-view-context';
import { workspaceBackend } from '@renderer/features/sessions/workspace-backend/workspace-backend';
import { nudgeWorkspace } from '@renderer/features/sessions/stores/workspace-nudges';
import { Button } from '@renderer/lib/ui/button';
import { EmptyState } from '@renderer/lib/ui/empty-state';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@renderer/lib/ui/resizable';
import { cn } from '@renderer/utils/utils';
import { GitStatusSection } from './git-status-section';
import { SECTION_HEADER_HEIGHT, usePanelLayout } from './hooks/use-panel-layout';
import { PullRequestsSection } from './pr-section';
import { StagedSection } from './staged-section';
import { UnstagedSection } from './unstaged-section';

export const ChangesPanel = observer(function ChangesPanel({ isVisible }: { isVisible?: boolean }) {
  const sessionView = useWorkspaceSurface();
  const workspace = useWorkspace();
  const { projectId } = useSessionViewContext();
  const workspaceId = useWorkspaceId();
  const diffView = sessionView.diffView;
  const changesView = diffView?.changesView;
  const shown = isVisible ?? sessionView.isChangesPanelVisible;

  // 改动面板切到眼前:让这个工作区的 git status 重算一次(一个目录一个 watch 的平台上,没人盯着的目录里的改动靠这一下)。
  useEffect(() => {
    if (shown) void nudgeWorkspace(projectId, workspaceId);
  }, [shown, projectId, workspaceId]);

  const {
    expanded,
    toggleExpanded,
    panelTransitionClass,
    pointerHandlers,
    unstagedRef,
    stagedRef,
    prRef,
    spacerRef,
    containerRef,
  } = usePanelLayout(changesView ?? null, shown);

  if (!diffView || !changesView) return null;
  if (sessionView.unreachableLabel || !workspace.gitWorktree.hasData || workspace.gitWorktree.problem) {
    return <ChangesPanelState />;
  }

  return (
    <div ref={containerRef} className="flex h-full flex-col">
      <ResizablePanelGroup
        orientation="vertical"
        className="min-h-0 flex-1"
        disableCursor
      >
        <ResizablePanel
          id="changes-unstaged"
          panelRef={unstagedRef}
          collapsible
          collapsedSize={SECTION_HEADER_HEIGHT}
          minSize="150px"
          maxSize="100%"
          defaultSize="33%"
          className={cn('flex flex-col overflow-hidden', panelTransitionClass)}
        >
          <UnstagedSection />
        </ResizablePanel>
        <ResizableHandle disabled={!expanded.unstaged || !expanded.staged} {...pointerHandlers} />
        <ResizablePanel
          id="changes-staged"
          panelRef={stagedRef}
          collapsible
          collapsedSize={SECTION_HEADER_HEIGHT}
          minSize="150px"
          maxSize="100%"
          defaultSize="33%"
          className={cn('flex flex-col overflow-hidden', panelTransitionClass)}
        >
          <StagedSection />
        </ResizablePanel>
        <ResizableHandle
          disabled={!expanded.staged || !expanded.pullRequests}
          {...pointerHandlers}
        />
        <ResizablePanel
          id="changes-pr"
          panelRef={prRef}
          collapsible
          collapsedSize={SECTION_HEADER_HEIGHT}
          minSize="150px"
          maxSize="100%"
          defaultSize="33%"
          className={cn('flex flex-col overflow-hidden', panelTransitionClass)}
        >
          <PullRequestsSection
            onToggleCollapsed={() => toggleExpanded('pullRequests')}
            collapsed={!expanded.pullRequests}
          />
        </ResizablePanel>
        <ResizablePanel
          id="changes-spacer"
          panelRef={spacerRef}
          minSize="0%"
          maxSize="100%"
          defaultSize="0%"
          className="border-t border-border"
        />
      </ResizablePanelGroup>
      <GitStatusSection />
    </div>
  );
});

/** 画不出改动清单时的那一格:那台机器离线 / 还在读 / 改动太多 / 不是 git 仓库 / 读失败(可重试)。❌ 空白一片。 */
const ChangesPanelState = observer(function ChangesPanelState() {
  const { translate } = useSessionMessages();
  const { projectId } = useSessionViewContext();
  const surface = useWorkspaceSurface();
  const git = useWorkspace().gitWorktree;
  const machine = workspaceBackend(projectId).machine;
  const problem = git.problem;
  if (surface.unreachableLabel) return <EmptyState label={surface.unreachableLabel} />;
  if (problem?.kind === 'too-many-files') return <EmptyState label={translate('changes.tooManyChanges')} />;
  if (problem?.kind === 'not-repository') {
    return (
      <EmptyState
        label={
          machine.kind === 'remote'
            ? translate('remoteWorkspace.notRepository', { device: machine.label() })
            : translate('changes.notRepository')
        }
      />
    );
  }
  if (problem?.kind === 'failed') {
    return (
      <EmptyState
        label={problem.message || translate('changes.loadFailed')}
        action={
          <Button size="xs" variant="outline" onClick={() => void git.resync()}>
            {translate('workspace.retry')}
          </Button>
        }
      />
    );
  }
  return (
    <div className="flex h-full items-center justify-center">
      <LoadingIndicator ariaLabel={translate('task.loading')} label={translate('task.loading')} />
    </div>
  );
});
