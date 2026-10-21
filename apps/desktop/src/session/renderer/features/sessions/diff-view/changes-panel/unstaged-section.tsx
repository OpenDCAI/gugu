import type { GitChange } from '@gugu/session-core/git';
import { Plus, Undo2 } from '@/lib/icons'
import { observer } from 'mobx-react-lite';
import { toast } from 'sonner';
import { activeDiffEntry } from '@renderer/features/sessions/diff-view/pane-selectors';
import {
  useSessionViewContext,
  useWorkspace,
  useWorkspaceId,
  useWorkspaceSurface,
} from '@renderer/features/sessions/session-view-context';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { EmptyState } from '@renderer/lib/ui/empty-state';
import { HEAD_REF } from '@shared/core/git/types';
import { commitRef } from '@shared/core/git/utils';
import { vcsFailureText } from '../../vcs-failure';
import { ActionCard } from './components/action-card';
import { ChangesListOrTree } from './components/changes-list-or-tree';
import { ChangesViewModeToggle } from './components/changes-view-mode-toggle';
import { CommitCard } from './components/commit-card';
import { SectionHeader } from './components/section-header';
import { useChangesViewMode } from './hooks/use-changes-view-mode';
import { usePrefetchDiffModels } from './hooks/use-prefetch-diff-models';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

export const UnstagedSection = observer(function UnstagedSection() {
  const { translate } = useSessionMessages();
  const { projectId } = useSessionViewContext();
  const workspaceId = useWorkspaceId();
  const sessionView = useWorkspaceSurface();
  const workspace = useWorkspace();
  const git = workspace.gitWorktree;
  const diffView = sessionView.diffView;
  const changesView = diffView?.changesView;

  const changes = git.unstagedFileChanges;
  const hasChanges = changes.length > 0;
  const hasStagedChanges = git.stagedFileChanges.length > 0;

  const _activeDiff = activeDiffEntry(sessionView.activePane);
  const activePath = _activeDiff?.diffGroup === 'disk' ? _activeDiff.path : undefined;

  const prefetch = usePrefetchDiffModels(projectId, workspaceId, 'disk', HEAD_REF);

  const { mode: viewMode, setMode: setViewMode } = useChangesViewMode('unstaged');

  const showConfirmActionModal = useShowModal('confirmActionModal');

  if (!diffView || !changesView) return null;

  const handleSelectChange = (change: GitChange) => {
    sessionView.activePane.open(
      'diff',
      {
        activeFile: {
          path: change.path,
          type: 'disk',
          group: 'disk',
          originalRef: commitRef('HEAD'),
        },
        status: change.status,
      },
      { preview: true }
    );
  };

  const handleDoubleClickChange = (change: GitChange) => {
    sessionView.activePane.open(
      'diff',
      {
        activeFile: {
          path: change.path,
          type: 'disk',
          group: 'disk',
          originalRef: commitRef('HEAD'),
        },
        status: change.status,
      },
      { preview: false }
    );
  };

  const handleDiscardSelection = () => {
    const paths = [...changesView.unstagedSelection];
    showConfirmActionModal({
      title: 'Discard Files Changes',
      variant: 'destructive',
      description:
        'Are you sure you want to discard the changes to the selected files? This can not be undone.',
      onSuccess: () => {
        void (async () => {
          const result = await git.discardFiles(paths);
          if (!result.success) {
            toast.error(vcsFailureText('discard', result.error, translate, 'changes.discardFailed'));
            return;
          }
          changesView.removeUnstagedSelection(paths);
        })();
      },
    });
  };

  const handleDiscardAll = () => {
    showConfirmActionModal({
      title: 'Discard All Changes',
      variant: 'destructive',
      description: 'Are you sure you want to discard all changes? This can not be undone.',
      onSuccess: () =>
        void git.discardAllFiles().then((result) => {
          if (!result.success) {
            toast.error(vcsFailureText('discard', result.error, translate, 'changes.discardFailed'));
          }
        }),
    });
  };

  const handleStageSelection = () => {
    const paths = [...changesView.unstagedSelection];
    void git.stageFiles(paths).then((result) => {
      if (!result.success) {
        toast.error(vcsFailureText('stage', result.error, translate, 'changes.stageFailed'));
        return;
      }
      changesView.removeUnstagedSelection(paths);
    });
  };

  const handleStageAll = () => {
    void git.stageAllFiles().then((result) => {
      if (!result.success) {
        toast.error(vcsFailureText('stage', result.error, translate, 'changes.stageFailed'));
      }
    });
  };

  return (
    <>
      <SectionHeader
        label={translate('changes.changed')}
        collapsed={!changesView.expandedSections.unstaged}
        onToggleCollapsed={() => changesView.toggleExpanded('unstaged')}
        count={changes.length}
        selectionState={changesView.unstagedSelectionState}
        onToggleAll={() => changesView.toggleAllUnstaged()}
        actions={<ChangesViewModeToggle value={viewMode} onChange={setViewMode} label={translate('changes.changed')} />}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {!hasChanges && (
          <EmptyState
            label={translate('changes.workingTreeClean')}
            description={translate('changes.workingTreeCleanHint')}
          />
        )}
        {hasChanges && (
          <ActionCard
            selectedCount={changesView.unstagedSelection.size}
            selectionActions={
              <>
                <Button
                  variant="link"
                  size="xs"
                  onClick={handleDiscardSelection}
                  title={translate('changes.discardSelected')}
                  className="text-foreground-destructive"
                >
                  <Undo2 className="size-3" />
                  {translate('changes.discard')}
                </Button>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={handleStageSelection}
                  title={translate('changes.stageSelected')}
                >
                  <Plus className="size-3" />
                  {translate('changes.stage')}
                </Button>
              </>
            }
            generalActions={
              <>
                <Button
                  variant="link"
                  size="xs"
                  disabled={!hasChanges}
                  onClick={handleDiscardAll}
                  title={translate('changes.discardAllChanges')}
                  className="text-foreground-destructive"
                >
                  <Undo2 className="size-3" />
                  {translate('changes.discardAll')}
                </Button>
                <Button
                  variant="outline"
                  size="xs"
                  disabled={!hasChanges}
                  onClick={handleStageAll}
                  title={translate('changes.stageAllChanges')}
                >
                  <Plus className="size-3" />
                  {translate('changes.stageAll')}
                </Button>
              </>
            }
          />
        )}
        <div className="min-h-0 flex-1 px-1">
          <ChangesListOrTree
            viewMode={viewMode}
            changes={changes}
            rootPath={workspace.path}
            isSelected={(path) => changesView.unstagedSelection.has(path)}
            onToggleSelect={(path) => changesView.toggleUnstagedItem(path)}
            activePath={activePath}
            onSelectChange={handleSelectChange}
            onDoubleClickChange={handleDoubleClickChange}
            onPrefetch={(change) => prefetch(change.path)}
          />
        </div>
        {hasChanges && !hasStagedChanges && <CommitCard autoStage />}
      </div>
    </>
  );
});
