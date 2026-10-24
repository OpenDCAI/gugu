import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { GitBranchRef, GitRemote } from '@gugu/session-core/git';
import { Github } from 'lucide-react'
import { useMemo } from 'react';
import {
  GitHubAccountSelectItem,
  GitHubAccountSelectLabel,
} from '@renderer/features/projects/components/github-account-select';
import { ProjectBranchSelector } from '@renderer/lib/components/project-branch-selector';
import {
  RemoteSelectContent,
  RemoteSelectItem,
} from '@renderer/lib/components/remote-select-content';
import { useGitHubAccounts } from '@renderer/lib/hooks/useGithubAccounts';
import { Field, FieldDescription, FieldTitle } from '@renderer/lib/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@renderer/lib/ui/select';
import { Switch } from '@renderer/lib/ui/switch';
import type { Project } from '@shared/projects';
import type { FormState, FormUpdate } from '../project-settings-form-model';
import {
  createProjectGitHubAccountSelectState,
  NO_GITHUB_ACCOUNT,
} from './project-github-account-select-state';

const SAME_AS_BASE_REMOTE = '__same_as_base_remote__';

type BaseProjectSettingsSectionProps = {
  projectId: string;
  form: FormState;
  projectType: Project['type'];
  remotes: GitRemote[];
  update: FormUpdate;
};

export function BaseProjectSettingsSection({
  projectId,
  form,
    remotes,
  update,
}: BaseProjectSettingsSectionProps) {
  const { translate } = useSessionMessages();
  const baseRemoteValue = form.baseRemote || 'origin';
  const pushRemoteValue = form.pushRemote || SAME_AS_BASE_REMOTE;
  const selectedBaseRemote = remotes.find((remote) => remote.name === baseRemoteValue);
  const selectedPushRemote = remotes.find((remote) => remote.name === pushRemoteValue);
  const { data: githubAccounts = [] } = useGitHubAccounts();
  const githubAccountSelect = useMemo(
    () => createProjectGitHubAccountSelectState(form.githubAccountId, githubAccounts),
    [form.githubAccountId, githubAccounts]
  );


  return (
    <>
      <Field>
        <FieldTitle>{translate('projects.settings.githubAccount')}</FieldTitle>
        <FieldDescription className="text-foreground-muted">
          {translate('projects.settings.githubAccountDescription')}
        </FieldDescription>
        <Select
          value={githubAccountSelect.selectValue}
          onValueChange={(value) =>
            update('githubAccountId', value === NO_GITHUB_ACCOUNT ? null : (value ?? null))
          }
        >
          <SelectTrigger className="w-full min-w-0">
            {githubAccountSelect.selectedAccount ? (
              <GitHubAccountSelectLabel account={githubAccountSelect.selectedAccount} />
            ) : (
              <div className="flex min-w-0 flex-1 items-center gap-2 text-left">
                <Github className="text-foreground-muted h-4 w-4 shrink-0" />
                {githubAccountSelect.missingAccountId ? (
                  <span className="flex min-w-0 items-center gap-2 truncate">
                    <span className="min-w-0 truncate">
                      {translate('projects.settings.githubAccountUnavailable')}
                    </span>
                    <span className="shrink-0 text-sm text-foreground-muted">
                      {translate('projects.settings.githubAccountDisconnected')}
                    </span>
                  </span>
                ) : (
                  <span className="min-w-0 truncate">
                    {translate('projects.settings.noGithubAccount')}
                  </span>
                )}
              </div>
            )}
          </SelectTrigger>
          <SelectContent align="start" alignItemWithTrigger={false} sideOffset={6}>
            <SelectItem value={NO_GITHUB_ACCOUNT} className="py-2">
              <div className="flex min-w-0 items-center gap-2">
                <Github className="text-foreground-muted h-4 w-4 shrink-0" />
                <span className="relative -top-px shrink-0">
                  {translate('projects.settings.noGithubAccount')}
                </span>
              </div>
            </SelectItem>
            {githubAccountSelect.accounts.map((account) => (
              <GitHubAccountSelectItem key={account.accountId} account={account} />
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field>
        <FieldTitle>{translate('projects.settings.defaultBranch')}</FieldTitle>
        <FieldDescription className="text-foreground-muted">
          {translate('projects.settings.defaultBranchDescription')}
        </FieldDescription>
        <ProjectBranchSelector
          projectId={projectId}
          value={form.defaultBranch ?? undefined}
          onValueChange={(branch: GitBranchRef) => update('defaultBranch', branch)}
        />
      </Field>

      <Field>
        <FieldTitle>{translate('projects.settings.baseRemote')}</FieldTitle>
        <FieldDescription className="text-foreground-muted">
          {translate('projects.settings.baseRemoteDescription')}
        </FieldDescription>
        <Select
          value={baseRemoteValue}
          onValueChange={(value) => update('baseRemote', value ?? '')}
        >
          <SelectTrigger className="w-full min-w-0">
            <div className="flex min-w-0 flex-1 items-center gap-2 text-left">
              <span className="min-w-0 truncate">
                {selectedBaseRemote?.name ?? baseRemoteValue}
              </span>
            </div>
          </SelectTrigger>
          <RemoteSelectContent remotes={remotes} />
        </Select>
      </Field>

      <Field>
        <FieldTitle>{translate('projects.settings.pushRemote')}</FieldTitle>
        <FieldDescription className="text-foreground-muted">
          {translate('projects.settings.pushRemoteDescription')}
        </FieldDescription>
        <Select
          value={pushRemoteValue}
          onValueChange={(value) =>
            update('pushRemote', value === SAME_AS_BASE_REMOTE ? '' : (value ?? ''))
          }
        >
          <SelectTrigger className="w-full min-w-0">
            <div className="flex min-w-0 flex-1 items-center gap-2 text-left">
              <span className="min-w-0 truncate">
                {pushRemoteValue === SAME_AS_BASE_REMOTE
                  ? translate('projects.settings.sameAsBaseRemote')
                  : (selectedPushRemote?.name ?? pushRemoteValue)}
              </span>
            </div>
          </SelectTrigger>
          <SelectContent align="start" alignItemWithTrigger={false} sideOffset={6}>
            <SelectItem value={SAME_AS_BASE_REMOTE} className="py-2">
              <span className="relative -top-px shrink-0 font-medium">
                {translate('projects.settings.sameAsBaseRemote')}
              </span>
            </SelectItem>
            {remotes.map((remote) => (
              <RemoteSelectItem key={remote.name} remote={remote} />
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field orientation="horizontal">
        <div className="flex flex-1 flex-col gap-1">
          <FieldTitle>{translate('projects.settings.enableTmux')}</FieldTitle>
        </div>
        <Switch checked={form.tmux} onCheckedChange={(checked) => update('tmux', checked)} />
      </Field>
    </>
  );
}
