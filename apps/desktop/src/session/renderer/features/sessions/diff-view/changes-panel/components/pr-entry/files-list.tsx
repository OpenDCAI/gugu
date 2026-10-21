import type { GitChange } from '@gugu/session-core/git';
import { observer } from 'mobx-react-lite';
import { usePrefetchDiffModels } from '@renderer/features/sessions/diff-view/changes-panel/hooks/use-prefetch-diff-models';
import { activeDiffEntry } from '@renderer/features/sessions/diff-view/pane-selectors';
import {
  useSessionViewContext,
  useWorkspace,
  useWorkspaceId,
  useWorkspaceSurface,
} from '@renderer/features/sessions/session-view-context';
import { commitRef, refsEqual } from '@shared/core/git/utils';
import { getPrNumber, type PullRequest } from '@shared/core/pull-requests/pull-requests';
import { useChangesViewMode } from '../../hooks/use-changes-view-mode';
import { ChangesListOrTree } from '../changes-list-or-tree';

export const PrFilesList = observer(function PrFilesList({ pr }: { pr: PullRequest }) {
  const { projectId } = useSessionViewContext();
  const workspaceId = useWorkspaceId();
  const workspace = useWorkspace();
  const sessionView = useWorkspaceSurface();
  const prStore = sessionView.prStore!;
  const { mode: viewMode } = useChangesViewMode('pr');

  const prNumber = getPrNumber(pr) ?? undefined;
  const baseRef = commitRef(pr.baseRefOid);
  const modifiedRef = commitRef(pr.headRefOid);
  const prFiles = prStore.getFiles(pr).data ?? [];

  const prefetchPrDiff = usePrefetchDiffModels(projectId, workspaceId, 'pr', baseRef, modifiedRef);

  const _activeDiff = activeDiffEntry(sessionView.activePane);
  const activePath =
    _activeDiff?.diffGroup === 'pr' &&
    _activeDiff.prNumber === prNumber &&
    refsEqual(_activeDiff.originalRef, baseRef) &&
    refsEqual(_activeDiff.modifiedRef ?? modifiedRef, modifiedRef)
      ? _activeDiff.path
      : undefined;

  const handleSelectChange = (change: GitChange) => {
    sessionView.activePane.open(
      'diff',
      {
        activeFile: {
          path: change.path,
          type: 'git',
          group: 'pr',
          originalRef: baseRef,
          modifiedRef,
          prNumber,
          prBaseOid: pr.baseRefOid,
          prHeadOid: pr.headRefOid,
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
          group: 'pr',
          originalRef: baseRef,
          modifiedRef,
          prNumber,
          prBaseOid: pr.baseRefOid,
          prHeadOid: pr.headRefOid,
        },
        status: change.status,
      },
      { preview: false }
    );
  };

  return (
    <ChangesListOrTree
      viewMode={viewMode}
      className="py-3"
      changes={prFiles}
      rootPath={workspace.path}
      activePath={activePath}
      onSelectChange={handleSelectChange}
      onDoubleClickChange={handleDoubleClickChange}
      onPrefetch={(change) => prefetchPrDiff(change.path)}
    />
  );
});
