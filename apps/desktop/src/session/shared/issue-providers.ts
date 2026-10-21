import type { IssueError } from '@gugu/session-plugins/issues';
import type { IntegrationError } from '@gugu/session-plugins/integrations';
import type { Result } from '@gugu/session-shared';
import type { LinkedIssue } from './core/linked-issue';

export type IssueProviderType = LinkedIssue['provider'];

export type IssueProviderCapabilities = {
  requiresRepositoryUrl: boolean;
  supportsIssueContext: boolean;
};

export type ConnectionStatus = {
  connected: boolean;
  displayName?: string;
  displayDetail?: string;
  /** 那一家的原话(给悬停与排查)。 */
  error?: string;
  /** 那一家分好的类(`IntegrationError['type']`):界面按它用界面语言说。 */
  errorType?: IntegrationError['type'];
  capabilities: IssueProviderCapabilities;
};

export type ConnectionStatusMap = Record<IssueProviderType, ConnectionStatus>;

export type IssueAccountError =
  | { type: 'no_account_selected'; message: string }
  | { type: 'account_disabled'; message: string }
  | { type: 'account_not_found'; host?: string; accountId?: string; message: string }
  | {
      type: 'account_host_mismatch';
      host: string;
      accountId: string;
      accountHost: string;
      message: string;
    }
  | { type: 'token_missing'; host: string; accountId: string; message: string }
  | { type: 'auth_required'; host?: string; message: string };

export type IssueListError = IssueError | IssueAccountError;

export type IssueListResult = Result<LinkedIssue[], IssueListError>;

export type IssueContextResult = Result<LinkedIssue, IssueListError>;
