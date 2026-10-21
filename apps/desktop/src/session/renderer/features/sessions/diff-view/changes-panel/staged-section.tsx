import type { GitChange } from '@gugu/session-core/git';
import { Minus } from 'lucide-react'
import { observer } from 'mobx-react-lite';
import { toast } from 'sonner';
import { activeDiffEntry } from '@renderer/features/sessions/diff-view/pane-selectors';
import {
  useSessionViewContext,
  useWorkspace,
  useWorkspaceId,
  useWorkspaceSurface,
} from '@renderer/features/sessions/session-view-context';
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

export const StagedSection = observer(function StagedSection() {
  const { translate } = useSessionMessages();
  const { projectId } = useSessionViewContext();
  const workspaceId = useWorkspaceId();
  const sessionView = useWorkspaceSurface();
  const workspace = useWorkspace();
  const git = workspace.gitWorktree;
  const diffView = sessionView.diffView;
  const changesView = diffView?.changesView;

  const changes = git.stagedFileChanges;
  const hasChanges = changes.length > 0;

  const _activeDiff = activeDiffEntry(sessionView.activePane);
  const activePath = _activeDiff?.diffGroup === 'staged' ? _activeDiff.path : undefined;

  const prefetch = usePrefetchDiffModels(projectId, workspaceId, 'staged', HEAD_REF);

  const { mode: viewMode, setMode: setViewMode } = useChangesViewMode('staged');

  if (!diffView || !changesView) return null;

  const handleSelectChange = (change: GitChange) => {
    sessionView.activePane.open(
      'diff',
      {
        activeFile: {
          path: change.path,
          type: 'git',
          group: 'staged',
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
          type: 'git',
          group: 'staged',
          originalRef: commitRef('HEAD'),
        },
        status: change.status,
      },
      { preview: false }
    );
  };

  const handleUnstageSelection = () => {
    const paths = [...changesView.stagedSelection];
    void git.unstageFiles(paths).then((result) => {
      if (!result.success) {
        toast.error(vcsFailureText('unstage', result.error, translate, 'changes.unstageFailed'));
        return;
      }
      changesView.removeStagedSelection(paths);
    });
  };

  const handleUnstageAll = () => {
    void git.unstageAllFiles().then((result) => {
      if (!result.success) {
        toast.error(vcsFailureText('unstage', result.error, translate, 'changes.unstageFailed'));
      }
    });
  };

  return (
    <>
      <SectionHeader
        label={translate('changes.staged')}
        count={changes.length}
        selectionState={changesView.stagedSelectionState}
        onToggleAll={() => changesView.toggleAllStaged()}
        actions={<ChangesViewModeToggle value={viewMode} onChange={setViewMode} label={translate('changes.staged')} />}
        collapsed={!changesView.expandedSections.staged}
        onToggleCollapsed={() => changesView.toggleExpanded('staged')}
      />
      {!hasChanges && (
        <EmptyState
          label={translate('changes.nothingStaged')}
          description={translate('changes.nothingStagedHint')}
        />
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {hasChanges && changesView.stagedSelection.size > 0 && (
          <ActionCard
            selectedCount={changesView.stagedSelection.size}
            selectionActions={
              <Button
                variant="outline"
                size="xs"
                onClick={handleUnstageSelection}
                title={translate('changes.unstageSelected')}
              >
                <Minus className="size-3" />
                {translate('changes.unstage')}
              </Button>
            }
            generalActions={
              <Button
                variant="ghost"
                size="xs"
                disabled={!hasChanges}
                onClick={handleUnstageAll}
                title={translate('changes.unstageAllFiles')}
              >
                <Minus className="size-3" />
                {translate('changes.unstageAll')}
              </Button>
            }
          />
        )}
        <div className="min-h-0 flex-1 px-1">
          <ChangesListOrTree
            viewMode={viewMode}
            changes={changes}
            rootPath={workspace.path}
            isSelected={(path) => changesView.stagedSelection.has(path)}
            onToggleSelect={(path) => changesView.toggleStagedItem(path)}
            activePath={activePath}
            onSelectChange={handleSelectChange}
            onDoubleClickChange={handleDoubleClickChange}
            onPrefetch={(change) => prefetch(change.path)}
          />
        </div>
        {hasChanges && <CommitCard />}
      </div>
    </>
  );
});
