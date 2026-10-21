import type { IntegrationCredentials } from '@gugu/session-plugins/integrations';
import type { IssuesPluginProvider } from '@gugu/session-plugins/issues';
import { err, type Err, ok } from '@gugu/session-shared';
import { log } from '@main/lib/logger';
import type {
  IssueContextResult,
  IssueListError,
  IssueListResult,
  IssueProviderType,
} from '@shared/issue-providers';
import type {
  IssueContextOpts,
  IssueProvider,
  IssueQueryOpts,
  IssueSearchOpts,
} from '../issues/issue-provider';
import {
  clampIssueProviderLimit,
  DEFAULT_SEARCH_LIMIT,
  toIssueProviderCapabilities,
  toLinkedIssue,
} from '../issues/plugin-issue-adapter';
import { integrationConnectionService } from './integration-connection-service';
import { integrationCredentialStore } from './integration-credential-store-instance';

export function createPluginIssueProvider(plugin: IssuesPluginProvider): IssueProvider {
  const provider = plugin.metadata.integrationId as IssueProviderType;
  const capabilities = toIssueProviderCapabilities(plugin);
  const pluginLog = log.child({ integration: provider });

  async function getConnectedHost(): Promise<
    { log: typeof pluginLog; credentials: IntegrationCredentials } | Err<IssueListError>
  > {
    let account;
    try {
      account = await integrationConnectionService.getFreshAccount(provider);
    } catch (error) {
      // The stored authorization could not be renewed; only the user can re-authorize.
      pluginLog.warn('Integration credentials could not be renewed', { error });
      return err({
        type: 'auth_required',
        message: error instanceof Error ? error.message : `${provider} authorization expired.`,
      });
    }
    if (!account) return notConnectedError();
    return { log: pluginLog, credentials: account.credentials };
  }

  function repositoryUrl(opts: IssueQueryOpts): string | undefined {
    const value = opts.repositoryUrl?.trim();
    return value || undefined;
  }

  function notConnectedError(): Err<IssueListError> {
    return err({ type: 'auth_required', message: `${provider} is not connected.` });
  }

  function missingRepositoryError(): Err<IssueListError> {
    return err({ type: 'invalid_input', message: 'Repository URL is required.' });
  }

  return {
    type: provider,
    capabilities,

    isConfigured: () => integrationCredentialStore.isConfigured(provider),

    checkConnection: () => integrationConnectionService.checkConnection(provider, capabilities),

    async searchIssues(opts: IssueSearchOpts): Promise<IssueListResult> {
      const term = String(opts.searchTerm || '').trim();
      if (!term) return ok([]);

      const host = await getConnectedHost();
      if ('success' in host) return host;

      if (capabilities.requiresRepositoryUrl && !repositoryUrl(opts)) {
        return missingRepositoryError();
      }

      const result = await plugin.behavior.issues?.searchIssues(host, {
        limit: clampIssueProviderLimit(opts.limit, DEFAULT_SEARCH_LIMIT),
        searchTerm: term,
        repositoryUrl: repositoryUrl(opts),
      });
      if (!result) return ok([]);
      if (!result.success) return err(result.error);
      return ok(result.data.map((issue) => toLinkedIssue(provider, issue)));
    },

    getIssueContext: plugin.behavior.issues?.getIssue
      ? async (opts: IssueContextOpts): Promise<IssueContextResult> => {
          const term = String(opts.identifier || '').trim();
          if (!term) {
            return err({ type: 'invalid_input', message: 'Issue identifier is required.' });
          }

          const host = await getConnectedHost();
          if ('success' in host) return host;

          const result = await plugin.behavior.issues?.getIssue?.(host, {
            identifier: term,
            repositoryUrl: repositoryUrl(opts),
          });
          if (!result) {
            return err({
              type: 'generic',
              message: `${provider} does not support issue context.`,
            });
          }
          if (!result.success) return err(result.error);
          return ok(toLinkedIssue(provider, result.data));
        }
      : undefined,
  };
}
