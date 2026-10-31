import { Github } from '@/lib/icons'
import { Badge } from '@renderer/lib/ui/badge';
import { SelectItem } from '@renderer/lib/ui/select';
import type { SessionMessageKey } from '@renderer/localization/messages';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { GitHubAccountSummary, GitHubCredentialSource } from '@shared/github';

// "GitHub CLI" and "OAuth" are proper nouns shown verbatim in both locales; the
// two descriptive sources are translated.
const GITHUB_SOURCE_VERBATIM: Partial<Record<GitHubCredentialSource, string>> = {
  cli: 'GitHub CLI',
  emdash_oauth: 'OAuth',
};

const GITHUB_SOURCE_KEYS: Partial<Record<GitHubCredentialSource, SessionMessageKey>> = {
  device_flow: 'projects.github.sourceDeviceFlow',
  secure_storage: 'projects.github.sourceSavedToken',
};

export function GitHubAccountSelectItem({ account }: { account: GitHubAccountSummary }) {
  return (
    <SelectItem value={account.accountId} className="py-2">
      <GitHubAccountSelectLabel account={account} />
    </SelectItem>
  );
}

export function GitHubAccountSelectLabel({ account }: { account: GitHubAccountSummary }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 text-left">
      {account.avatarUrl ? (
        <img
          src={account.avatarUrl}
          alt={account.login}
          className="h-4 w-4 shrink-0 rounded-full"
        />
      ) : (
        <Github className="text-foreground-muted h-4 w-4 shrink-0" />
      )}
      <span className="min-w-0 truncate">@{account.login}</span>
      <span className="text-foreground-muted shrink-0 text-xs">{account.host}</span>
      {account.isDefault ? <GitHubDefaultAccountBadge /> : null}
    </div>
  );
}

export function GitHubDefaultAccountBadge() {
  const { translate } = useSessionMessages();
  return (
    <Badge
      variant="secondary"
      className="rounded-md border-foreground/10 bg-background-2 text-foreground"
    >
      {translate('projects.github.default')}
    </Badge>
  );
}

export function GitHubCredentialSourceBadge({ source }: { source: GitHubCredentialSource }) {
  const { translate } = useSessionMessages();
  const key = GITHUB_SOURCE_KEYS[source];
  return (
    <Badge
      variant="outline"
      className="rounded-md border-foreground/10 bg-transparent text-foreground-muted"
    >
      {key ? translate(key) : GITHUB_SOURCE_VERBATIM[source]}
    </Badge>
  );
}
