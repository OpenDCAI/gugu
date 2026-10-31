import { messageForUser } from '@/lib/userFacingError';
import { Circle, CircleCheck, Plus, X } from '@/lib/icons'
import { Github } from 'lucide-react'
import {
  GitHubCredentialSourceBadge,
  GitHubDefaultAccountBadge,
} from '@renderer/features/projects/components/github-account-select';
import { sortGitHubAccountsByDefault } from '@renderer/features/projects/components/github-account-select-model';
import { useToast } from '@renderer/lib/hooks/use-toast';
import {
  useGitHubAccounts,
  useRemoveGitHubAccount,
  useSetDefaultGitHubAccount,
} from '@renderer/lib/hooks/useGithubAccounts';
import { useLibraryHost } from '@renderer/features/library/library-host';
import { rpc } from '@renderer/lib/ipc';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { PRODUCT_NAME } from '@shared/app-identity';
import type { GitHubAccountSummary } from '@shared/github';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';

export function GitHubAccountsSection() {
  const { data: accounts = [], isLoading } = useGitHubAccounts();
  const sortedAccounts = sortGitHubAccountsByDefault(accounts);
  const showConnectGitHub = useShowModal('githubConnectModal');
  const { translate } = useSessionMessages();

  return (
    <section className="space-y-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-foreground">GitHub</p>
        </div>
        <TooltipProvider delay={150}>
          <Tooltip>
            <TooltipTrigger render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => showConnectGitHub({})}
                aria-label={translate('github.add')}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            } />
            <TooltipContent side="top">{translate('github.add')}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {isLoading ? (
        <div className="text-foreground-muted flex items-center gap-2 py-3 text-sm">
          <LoadingIndicator size="inline" />
          {translate('github.loading')}
        </div>
      ) : sortedAccounts.length === 0 ? (
        <div className="flex items-center gap-3 rounded-lg border border-foreground/10 bg-foreground/[0.02] p-3 dark:bg-foreground/[0.03]">
          <div className="bg-background-2/50 flex h-9 w-9 shrink-0 items-center justify-center rounded-md">
            <Github className="text-foreground-muted h-4 w-4" />
          </div>
          <p className="text-foreground-muted min-w-0 flex-1 text-sm">{translate('github.none')}</p>
        </div>
      ) : (
        <GitHubAccountRows accounts={sortedAccounts} />
      )}
    </section>
  );
}

export function GitHubAccountRows({
  accounts,
  readOnly = false,
}: {
  accounts: GitHubAccountSummary[];
  /** 那台机器此刻做不了事(离线 / server 太旧,#6264):照旧列着,「设为默认」「移除」一起灰。 */
  readOnly?: boolean;
}) {
  const setDefaultMutation = useSetDefaultGitHubAccount();
  const removeMutation = useRemoveGitHubAccount();
  const showConfirmRemove = useShowModal('confirmActionModal');
  const { toast } = useToast();
  const host = useLibraryHost();
  const { translate } = useSessionMessages();

  const setDefaultAccount = async (account: GitHubAccountSummary) => {
    const result = await setDefaultMutation.mutateAsync(account.accountId);
    if (!result.success) {
      toast({
        title: translate('github.setDefaultFailed'),
        description: messageForUser(result.error),
        variant: 'destructive',
      });
      return;
    }
    toast({
      title: translate('github.defaultUpdated'),
      description: translate('github.defaultUsageHint', { login: account.login }),
    });
  };

  const removeAccount = async (account: GitHubAccountSummary) => {
    const result = await removeMutation.mutateAsync(account.accountId);
    if (!result.success) {
      toast({
        title: translate('github.removeFailed'),
        description: messageForUser(result.error),
        variant: 'destructive',
      });
      return;
    }
    toast({
      title: translate('github.removed'),
      description: translate('github.removedDetail', { login: account.login }),
    });
  };

  const confirmRemove = async (account: GitHubAccountSummary) => {
    let description = translate('github.removeConfirmDescription', { appName: PRODUCT_NAME });
    try {
      // 「有几个项目在用它」数的是本机的项目;账号在别的机器上时(#6264)那台机器的项目这里数不到,不数。
      if (host.remote) throw new Error('remote');
      const count = await rpc.projects.countProjectsUsingGithubAccount(account.accountId);
      if (count > 0) {
        description = translate('github.removeConfirmInUse', {
          projects: translate('github.projectCount', { count }),
        });
      }
    } catch {}

    showConfirmRemove({
      title: translate('github.removeConfirmTitle', { login: account.login }),
      description,
      confirmLabel: translate('github.remove'),
      onSuccess: () => void removeAccount(account),
    });
  };

  return (
    <TooltipProvider delay={150}>
      <div className="space-y-2">
        {accounts.map((account) => (
          <GitHubAccountRow
            key={account.accountId}
            account={account}
            setDefaultPending={setDefaultMutation.isPending || readOnly}
            removePending={removeMutation.isPending || readOnly}
            onSetDefault={() => void setDefaultAccount(account)}
            onRemove={() => void confirmRemove(account)}
          />
        ))}
      </div>
    </TooltipProvider>
  );
}

function GitHubAccountRow({
  account,
  setDefaultPending,
  removePending,
  onSetDefault,
  onRemove,
}: {
  account: GitHubAccountSummary;
  setDefaultPending: boolean;
  removePending: boolean;
  onSetDefault: () => void;
  onRemove: () => void;
}) {
  const { translate } = useSessionMessages();
  return (
    <div className="flex items-center gap-3 rounded-lg bg-background/60 p-3">
      {account.avatarUrl ? (
        <img
          src={account.avatarUrl}
          alt={account.login}
          className="h-9 w-9 shrink-0 rounded-full border border-foreground/10"
        />
      ) : (
        <div className="bg-background-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-foreground/10">
          <Github className="text-foreground-muted h-4 w-4" />
        </div>
      )}
      {/* @@@raw account identity — GitHub login 与 host 是账号数据,原样显示。 */}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <p className="truncate text-sm font-medium text-foreground">@{account.login}</p>
          {account.isDefault && <DefaultGitHubAccountBadge login={account.login} />}
          <GitHubCredentialSourceBadge source={account.credentialSource} />
        </div>
        <p className="text-foreground-muted truncate text-xs">{account.host}</p>
      </div>
      <Tooltip>
        {account.isDefault ? (
          <TooltipTrigger render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              aria-disabled={true}
              onClick={() => {
                if (account.isDefault) return;
                onSetDefault();
              }}
              aria-label={translate('github.isDefaultLabel', { login: account.login })}
            >
              <CircleCheck className="text-foreground" />
            </Button>
          } />
        ) : (
          <TooltipTrigger render={<span className="inline-flex" />}>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={setDefaultPending}
              onClick={onSetDefault}
              aria-label={translate('github.setDefaultLabel', { login: account.login })}
            >
              <Circle className="text-foreground-muted" />
            </Button>
          </TooltipTrigger>
        )}
        <TooltipContent side="top">
          {account.isDefault
            ? translate('github.defaultAccount')
            : translate('github.setAsDefault')}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={removePending}
            onClick={onRemove}
            aria-label={translate('github.removeAccountLabel', { login: account.login })}
          >
            <X />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{translate('github.removeAccount')}</TooltipContent>
      </Tooltip>
    </div>
  );
}

export function DefaultGitHubAccountBadge({ login }: { login: string }) {
  const { translate } = useSessionMessages();
  return (
    <Tooltip>
      <TooltipTrigger className="inline-flex h-4.5 items-center leading-none">
        <GitHubDefaultAccountBadge />
      </TooltipTrigger>
      <TooltipContent side="top">
        {translate('github.defaultUsageHint', { login })}
      </TooltipContent>
    </Tooltip>
  );
}
