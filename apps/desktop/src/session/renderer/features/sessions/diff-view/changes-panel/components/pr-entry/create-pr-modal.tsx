import type { GitBranchRef } from '@gugu/session-core/git';
import { ChevronDown, CircleAlert } from '@/lib/icons'
import { GitBranch, GitPullRequest } from 'lucide-react'
import { observer } from 'mobx-react-lite';
import { useMemo, useState } from 'react';
import { getGitRepositoryStore } from '@renderer/features/projects/stores/project-selectors';
import { BranchDisplay } from '@renderer/lib/components/branch-display';
import { ProjectBranchSelector } from '@renderer/lib/components/project-branch-selector';
import { RemoteSelectContent } from '@renderer/lib/components/remote-select-content';
import { rpc } from '@renderer/lib/ipc';
import { type BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Alert, AlertDescription, AlertTitle } from '@renderer/lib/ui/alert';
import { ComboboxTrigger, ComboboxValue } from '@renderer/lib/ui/combobox';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { Select, SelectTrigger } from '@renderer/lib/ui/select';
import { Separator } from '@renderer/lib/ui/separator';
import { SplitButton } from '@renderer/lib/ui/split-button';
import { Textarea } from '@renderer/lib/ui/textarea';
import { log } from '@renderer/utils/logger';
import { pullRequestErrorMessage } from '@shared/core/pull-requests/pull-requests';
import { parseRepositoryRef } from '@shared/repository-ref';
import { formatPushErrorDetail } from '../../../../utils';
import { resolveInitialBaseBranch } from './base-branch';
import { getTargetRemotes, resolveCreatePrTargetRemote } from './target-remote';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { workspaceRpc } from '@renderer/features/sessions/workspace-backend/workspace-backend';

export type CreatePrModalArgs = {
  projectId: string;
  sessionId: string;
  repositoryUrl: string;
  branchName: string;
  draft: boolean;
  workspaceId: string;
};

type Props = BaseModalProps<void> & CreatePrModalArgs;

export const CreatePrModal = observer(function CreatePrModal({
  projectId,
  sessionId: _sessionId,
  repositoryUrl,
  branchName,
  draft,
  workspaceId,
  onSuccess,
}: Props) {
  const { translate } = useSessionMessages();
  const [title, setTitle] = useState(branchName);
  const [description, setDescription] = useState('');
  const [selectedBaseOverride, setSelectedBaseOverride] = useState<GitBranchRef | undefined>();
  const [selectedTargetRemoteName, setSelectedTargetRemoteName] = useState<string | undefined>();
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const repo = getGitRepositoryStore(projectId);
  const defaultBranch = repo?.defaultBranch;
  const isOnRemote = repo?.isBranchOnRemote(branchName) ?? false;
  const aheadCount = repo?.getBranchDivergence(branchName)?.ahead ?? 0;
  const needsPush = !isOnRemote || aheadCount > 0;
  const projectRemoteName = repo?.baseRemote.name ?? 'origin';
  const fallbackRepository = useMemo(() => parseRepositoryRef(repositoryUrl), [repositoryUrl]);
  const targetRemotes = useMemo(
    () =>
      fallbackRepository
        ? getTargetRemotes(repo?.remotes ?? [], { host: fallbackRepository.host })
        : [],
    [fallbackRepository, repo?.remotes]
  );
  const targetRemote = resolveCreatePrTargetRemote({
    options: targetRemotes,
    projectRemoteName,
    selectedRemoteName: selectedTargetRemoteName,
    fallbackRepositoryUrl: repositoryUrl,
  });
  const targetRepositoryUrl =
    targetRemote?.repository.repositoryUrl ?? fallbackRepository?.repositoryUrl ?? null;

  const hasGitHubRemote = Boolean(targetRepositoryUrl);
  const selectedBase =
    selectedBaseOverride ??
    resolveInitialBaseBranch(
      repo?.remoteBranches ?? [],
      undefined,
      defaultBranch,
      targetRemote?.remote.name ?? projectRemoteName
    );

  const handleTargetRemoteChange = (remoteName: string | null) => {
    if (!remoteName) return;
    setSelectedTargetRemoteName(remoteName);
    setSelectedBaseOverride(undefined);
  };

  const doCreate = async (push: boolean) => {
    if (!selectedBase?.branch) {
      setError('Select a base branch before creating the pull request.');
      return;
    }
    if (!title.trim() || !targetRepositoryUrl) return;
    setError(null);
    setIsCreating(true);
    try {
      if (push) {
        const pushResult = await workspaceRpc(projectId).gitWorktree.push(
          projectId,
          workspaceId,
          repo?.pushRemote.name ?? 'origin'
        );
        if (!pushResult.success) {
          log.error('Failed to push branch:', pushResult.error);
          setError(formatPushErrorDetail(pushResult.error, translate));
          return;
        }
      }

      const baseRepository = parseRepositoryRef(targetRepositoryUrl);
      const headRepository = repo?.pushRemote.url ? parseRepositoryRef(repo.pushRemote.url) : null;
      const head =
        baseRepository &&
        headRepository &&
        headRepository.repositoryUrl !== baseRepository.repositoryUrl
          ? `${headRepository.owner}:${branchName}`
          : branchName;

      const result = await rpc.pullRequests.createPullRequest(projectId, {
        repositoryUrl: targetRepositoryUrl,
        headRepositoryUrl: headRepository?.repositoryUrl,
        head,
        base: selectedBase.branch,
        title: title.trim(),
        body: description.trim() || undefined,
        draft,
      });

      if (result.success) {
        onSuccess();
      } else {
        setError(pullRequestErrorMessage(result.error));
      }
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="flex max-h-[70vh] flex-col overflow-hidden">
      <DialogHeader>
        <DialogTitle>{draft ? 'Create Draft PR' : 'Create Pull Request'}</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-4">
        {!hasGitHubRemote && (
          <p className="text-foreground-muted text-sm">
            {translate('pr.noGitHubRemote')}
          </p>
        )}
        {/* 三个字段收进一块密度面板,不各自画框(design.md:prefer a change of density over a
            box —— 2026-09-22,原三个 `rounded-md border border-border` 盒子改这样)。 */}
        <div className="flex flex-col items-center gap-1 rounded-lg bg-background-1 p-1">
          <BranchDisplay
            label={translate('pr.headBranch')}
            branchName={branchName}
            className="rounded-sm"
          />
          {targetRemotes.length > 1 && targetRemote ? (
            <Select value={targetRemote.remote.name} onValueChange={handleTargetRemoteChange}>
              <SelectTrigger
                showChevron={false}
                className="hover:bg-row-hover flex min-h-[58px] w-full items-center justify-between gap-2 rounded-sm p-2 text-left outline-none data-[size=default]:h-auto"
              >
                <div className="flex flex-col gap-0.5 text-left text-sm">
                  <span className="text-xs text-foreground-passive">{translate('pr.target')}</span>
                  <span className="flex items-center gap-1">
                    <GitPullRequest
                      absoluteStrokeWidth
                      strokeWidth={2}
                      className="size-3.5 shrink-0 text-foreground-muted"
                    />
                    <span className="min-w-0 truncate">{targetRemote.remote.name}</span>
                  </span>
                </div>
                <ChevronDown className="size-4 shrink-0 text-foreground-muted" />
              </SelectTrigger>
              <RemoteSelectContent remotes={targetRemotes.map(({ remote }) => remote)} />
            </Select>
          ) : null}
          <ProjectBranchSelector
            projectId={projectId}
            value={selectedBase}
            onValueChange={setSelectedBaseOverride}
            remoteOnly
            remoteName={targetRemote?.remote.name}
            branchLabelRemote="short"
            trigger={
              <ComboboxTrigger className="hover:bg-row-hover flex w-full items-center justify-between gap-2 rounded-sm p-2 text-left outline-none">
                <div className="flex flex-col gap-0.5 text-left text-sm">
                  <span className="text-xs text-foreground-passive">{translate('pr.baseBranch')}</span>
                  <span className="flex items-center gap-1">
                    <GitBranch
                      absoluteStrokeWidth
                      strokeWidth={2}
                      className="size-3.5 shrink-0 text-foreground-muted"
                    />
                    <ComboboxValue placeholder={translate('pr.baseBranchPlaceholder')} />
                  </span>
                </div>
                <ChevronDown className="size-4 shrink-0 text-foreground-muted" />
              </ComboboxTrigger>
            }
          />
        </div>
        <Separator />
        <FieldGroup>
          <Field>
            <FieldLabel>{translate('pr.title')}</FieldLabel>
            <Input
              placeholder={translate('pr.titlePlaceholder')}
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={!hasGitHubRemote}
            />
          </Field>
          <Field>
            <FieldLabel>{translate('pr.description')}</FieldLabel>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={1}
              disabled={!hasGitHubRemote}
            />
          </Field>
        </FieldGroup>
        {error && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertTitle>{translate('pr.createFailed')}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </DialogContentArea>
      <DialogFooter>
        {needsPush ? (
          <SplitButton
            size="sm"
            loading={isCreating}
            loadingLabel="Creating..."
            disabled={!hasGitHubRemote || !selectedBase?.branch || !title.trim()}
            actions={[
              {
                value: 'push-and-create',
                label: draft ? 'Push & Create Draft' : 'Push & Create PR',
                action: () => void doCreate(true),
              },
              {
                value: 'create-only',
                label: draft ? 'Create Draft' : 'Create PR',
                description: 'Skip push and open a PR from the current remote state',
                action: () => void doCreate(false),
              },
            ]}
          />
        ) : (
          <ConfirmButton
            size="sm"
            onClick={() => void doCreate(false)}
            disabled={!hasGitHubRemote || !selectedBase?.branch || !title.trim() || isCreating}
          >
            {isCreating ? 'Creating...' : draft ? 'Create Draft' : 'Create PR'}
          </ConfirmButton>
        )}
      </DialogFooter>
    </div>
  );
});
