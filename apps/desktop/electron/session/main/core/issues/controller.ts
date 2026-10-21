import { err } from '@gugu/session-shared';
import { checkSourceConnection as checkProviderConnection } from '@main/core/integrations/connection-statuses';
import { projectManager } from '@main/core/projects/project-manager';
import type {
  IssueContextResult,
  IssueListResult,
  IssueProviderType,
} from '@shared/issue-providers';
import { createRPCController } from '@shared/lib/ipc/rpc';
import type { IssueContextOpts, IssueQueryOpts, IssueSearchOpts } from './issue-provider';
import { getIssueProvider } from './registry';

const DEFAULT_CAPABILITIES = {
  requiresProjectPath: false,
  requiresRepositoryUrl: false,
  supportsIssueContext: false,
} as const;

async function withResolvedRemote<T extends IssueQueryOpts>(opts: T): Promise<T> {
  if (!opts.projectId) return opts;
  const project = projectManager.getProject(opts.projectId);
  if (!project) return opts;
  // gugu #2358: 非 git 项目无远端 → 不做远端/仓库 URL 解析,原样返回。
  if (!project.gitRepository) return opts;

  const remote = await project.gitRepository.getBaseRemote().catch(() => undefined);
  const selectedRemote = opts.remote?.trim() || remote;
  const providedRepositoryUrl = opts.repositoryUrl?.trim();

  const remoteRepositoryUrl =
    !providedRepositoryUrl && selectedRemote
      ? (await project.gitRepository.getRemotes().catch(() => [])).find(
          (candidate) => candidate.name === selectedRemote
        )?.url
      : undefined;
  const repositoryUrl = providedRepositoryUrl ?? remoteRepositoryUrl;

  return { ...opts, remote: selectedRemote, repositoryUrl };
}

export const issueController = createRPCController({
  checkConnection: async (provider: IssueProviderType) => {
    const issueProvider = getIssueProvider(provider);
    if (!issueProvider) {
      return {
        connected: false,
        error: `Unknown provider: ${provider}`,
        capabilities: DEFAULT_CAPABILITIES,
      };
    }

    return checkProviderConnection(issueProvider);
  },

  searchIssues: async (
    provider: IssueProviderType,
    opts: IssueSearchOpts
  ): Promise<IssueListResult> => {
    const issueProvider = getIssueProvider(provider);
    if (!issueProvider) {
      return err({ type: 'generic', message: `Unknown provider: ${provider}` });
    }

    return issueProvider.searchIssues(await withResolvedRemote(opts));
  },

  getIssueContext: async (
    provider: IssueProviderType,
    opts: IssueContextOpts
  ): Promise<IssueContextResult> => {
    const issueProvider = getIssueProvider(provider);
    if (!issueProvider) {
      return err({ type: 'generic', message: `Unknown provider: ${provider}` });
    }

    if (!issueProvider.getIssueContext) {
      return err({ type: 'generic', message: `${provider} does not support issue context.` });
    }

    return issueProvider.getIssueContext(await withResolvedRemote(opts));
  },
});
