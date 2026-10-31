import { ArrowDown, ArrowUp, RefreshCcw } from '@/lib/icons'
import { GitBranch } from '@/lib/icons'
import { observer } from 'mobx-react-lite';
import {
  getProjectStore,
  getGitRepositoryStore,
  projectDisplayName,
} from '@renderer/features/projects/stores/project-selectors';
import { getSessionPageStore } from '@renderer/features/sessions/stores/session-selectors';
import { useSessionViewContext, useWorkspace } from '@renderer/features/sessions/session-view-context';
import { useGitActions } from '@renderer/features/sessions/use-git-actions';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { getBranchTooltipText, getPublishTooltipText } from './git-status-tooltips';

export const GitStatusSection = observer(function GitStatusSection() {
  const workspace = useWorkspace();
  const git = workspace.gitWorktree;
  const headDisplay = git.headDisplay ?? null;
  const headKind = git.headKind ?? 'branch';
  return (
    <TooltipProvider>
      <div className="flex flex-col gap-2 border-t border-border p-2">
        <div className="flex items-center justify-between gap-2 text-foreground-muted">
          <Tooltip>
            <TooltipTrigger className="flex min-w-0 items-center gap-2">
              <GitBranch className="size-3 shrink-0" />
              <span className="truncate text-xs">{headDisplay}</span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {getBranchTooltipText(headDisplay, headKind)}
            </TooltipContent>
          </Tooltip>
          {/* 拉取 / 推送 / 发布这一排靠仓库层面的读数(上游、remote 列表);别的机器上的会话没有这一层,
              推送走提交按钮里的「提交并推送」(由那台机器按它自己的上游推)。 */}
          {workspace.gitRepository ? <RepositoryActions headDisplay={headDisplay} headKind={headKind} /> : null}
        </div>
      </div>
    </TooltipProvider>
  );
});

const RepositoryActions = observer(function RepositoryActions({
  headDisplay,
  headKind,
}: {
  headDisplay: string | null;
  headKind: 'branch' | 'detached' | 'unborn';
}) {
  const { projectId, sessionId } = useSessionViewContext();
  const workspaceId = getSessionPageStore(projectId, sessionId)?.workspaceId;
  const isDetached = headKind === 'detached';
  const projectName = projectDisplayName(getProjectStore(projectId)) ?? 'repository';
  const repositoryStore = getGitRepositoryStore(projectId);
  const showAddRemoteModal = useShowModal('addRemoteModal');

  const {
    hasUpstream,
    aheadCount,
    behindCount,
    fetch,
    pull,
    push,
    publish,
    isPublishing,
    isFetching,
    isPulling,
    isPushing,
  } = useGitActions(projectId, sessionId);
  const shouldOfferAddRemote = (repositoryStore?.remotes.length ?? 0) === 0;
  const pullDisabled = isPulling || behindCount === 0;
  const pushDisabled = isPushing || aheadCount === 0;
  const publishDisabled = isPublishing || !headDisplay;

  const handlePublishClick = () => {
    if (publishDisabled || isDetached || !workspaceId) return;
    if (shouldOfferAddRemote) {
      showAddRemoteModal({
        projectId,
        projectName,
        branchName: headDisplay,
        workspaceId,
      });
      return;
    }
    publish();
  };

  return (
          <div className="flex items-center gap-1">
            {hasUpstream && !isDetached ? (
              <>
                <Tooltip>
                  <TooltipTrigger render={<span className="inline-flex" />}>
                    <Button
                      variant="outline"
                      size="icon-xs"
                      disabled={isFetching}
                      onClick={() => fetch()}
                    >
                      <RefreshCcw className="size-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{isFetching ? 'Fetching...' : 'Fetch changes'}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger render={
                    <Button
                      variant="outline"
                      size="icon-xs"
                      className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                      aria-disabled={pullDisabled || undefined}
                      onClick={() => {
                        if (pullDisabled) return;
                        pull();
                      }}
                    >
                      <ArrowDown className="size-3" />
                    </Button>
                  } />
                  <TooltipContent>
                    {isPulling
                      ? 'Pulling...'
                      : behindCount === 0
                        ? 'Nothing to pull'
                        : 'Pull changes'}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger render={
                    <Button
                      variant="outline"
                      size="icon-xs"
                      className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                      aria-disabled={pushDisabled || undefined}
                      onClick={() => {
                        if (pushDisabled) return;
                        push();
                      }}
                    >
                      <ArrowUp className="size-3" />
                    </Button>
                  } />
                  <TooltipContent>
                    {isPushing
                      ? 'Pushing...'
                      : aheadCount === 0
                        ? 'Nothing to push'
                        : 'Push changes'}
                  </TooltipContent>
                </Tooltip>
              </>
            ) : (
              !isDetached && (
                <Tooltip>
                  <TooltipTrigger render={
                    <Button
                      variant="outline"
                      size="xs"
                      className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                      aria-disabled={publishDisabled || undefined}
                      onClick={handlePublishClick}
                    >
                      <ArrowUp className="size-3" />
                      {isPublishing
                        ? 'Publishing...'
                        : shouldOfferAddRemote
                          ? 'Add Remote'
                          : 'Publish'}
                    </Button>
                  } />
                  <TooltipContent>
                    {getPublishTooltipText({
                      isPublishing,
                      headDisplay,
                      headKind,
                      shouldOfferAddRemote,
                    })}
                  </TooltipContent>
                </Tooltip>
              )
            )}
          </div>
  );
});
