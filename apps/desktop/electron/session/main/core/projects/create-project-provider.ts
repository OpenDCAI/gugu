import type { IFileSystem } from '@gugu/session-core/files';
import type { IGitRepository, IGitRuntime } from '@gugu/session-core/git';
import { err, ok, type Lease, type Result } from '@gugu/session-shared';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import { GitRepositoryFetchService } from '@main/core/git/repository/fetch-service';
import { GitRepositoryService } from '@main/core/git/repository/service';
import { projectGitHubAccountBackfillService } from '@main/core/github/services/project-github-account-backfill-instance';
import { openFileSystem } from '@main/core/runtime/files-helpers';
import { runtimeManager } from '@main/core/runtime/runtime-manager';
import type { MachineRuntime } from '@main/core/runtime/types';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { gitRepoUpdateChannel } from '@shared/core/git/events';
import { PROJECT_CONFIG_FILE } from '@shared/core/project-settings/project-settings';
import { projectSettingsChangedChannel } from '@shared/core/projects/projectEvents';
import type { LocalProject } from '@shared/projects';
import { ensureEmdashGitExcludedSafe } from './ensure-emdash-excluded';
import { ProjectProvider, type ProjectProviderTransport } from './project-provider';
import { resolveProjectGitless } from './resolve-project-gitless';
import type { ProjectSettingsProvider } from './settings/provider';
import { LocalProjectSettingsProvider } from './settings/providers/local-project-settings-provider';

export type CreateProviderError = { message: string };

export async function createProvider(
  project: LocalProject
): Promise<Result<ProjectProvider, CreateProviderError>> {
  const ctx = new LocalExecutionContext({ root: project.path });
  const runtimeLease = await runtimeManager.acquire();

  try {
    const projectFileSystem = openFileSystem(runtimeLease.value.files);
    if (!projectFileSystem.success) {
      await runtimeLease.release();
      return err({ message: projectFileSystem.error.message });
    }
    const gitless = await resolveProjectGitless(
      project,
      projectFileSystem.data,
      runtimeLease.value.files.path
    );
    const settings = new LocalProjectSettingsProvider(
      project.id,
      project.path,
      // gugu #2358: 非 git 项目 baseRef=null → 无默认分支回退(undefined)。
      gitless ? undefined : (project.baseRef ?? undefined),
      projectFileSystem.data
    );
    await runLegacyProjectSettingsMigration(
      settings,
      runtimeLease.value.git,
      project.path,
      gitless
    );
    // Both explicitly gitless projects and repositories whose metadata was
    // removed mount the ordinary directory without acquiring a Git lease.
    const repoLease = gitless ? undefined : await runtimeLease.value.git.openRepository(project.path);
    try {
      const provider = buildProvider(
        project.id,
        project.path,
        {
          kind: 'local',
          ctx,
        },
        runtimeLease.value.files,
        projectFileSystem.data,
        settings,
        () => {},
        runtimeLease,
        repoLease
      );
      await backfillGitHubAccount(provider);
      return ok(provider);
    } catch (error) {
      await repoLease?.release();
      throw error;
    }
  } catch (error) {
    await runtimeLease.release();
    return err(toCreateProviderError(error));
  }
}

function toCreateProviderError(error: unknown): CreateProviderError {
  return { message: error instanceof Error ? error.message : String(error) };
}

async function runLegacyProjectSettingsMigration(
  settings: LocalProjectSettingsProvider,
  git: IGitRuntime,
  repoPath: string,
  // gugu #2358: 非 git 项目(baseRef=null)必须走无 git 句柄的 ensure —— 见下。
  gitless: boolean
): Promise<void> {
  // gugu #2328: worktree lease 只为给迁移传 git 句柄;迁移已完成(本地 DB 标记)时不再
  // 为一个必然 no-op 的 ensure 开 worktree。
  // gugu #2358: 非 git 项目根本不是 git 仓,openWorktree 会抛 `fatal: not a git repository`。
  // 迁移唯一要 git 句柄的是 isFileCleanlyTracked(仅当存在共享配置文件时才查),非 git 项目无此文件 →
  // 无句柄直接 ensure 即可(仍会写迁移收敛标记,不会每次 mount 重试)。
  if (gitless || !(await settings.needsLegacyConfigMigration())) {
    await settings.ensure();
    return;
  }
  const lease = await git.openWorktree(repoPath);
  try {
    await settings.ensure({ git: lease.value });
  } finally {
    await lease.release();
  }
}

async function backfillGitHubAccount(provider: ProjectProvider): Promise<void> {
  try {
    const result = await projectGitHubAccountBackfillService.backfillProject(provider);
    // gugu #2328(GAP #4): backfill 转后台后 mount 返回先于回填落库,renderer 可能已读走
    // 无 githubAccountId 的设置——落库成功即广播变更,让读方缓存失效。
    if (result.status === 'updated') {
      events.emit(projectSettingsChangedChannel, { projectId: provider.projectId });
    }
  } catch (error) {
    log.warn('createProvider: failed to backfill project GitHub account', {
      projectId: provider.projectId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function buildProvider(
  projectId: string,
  repoPath: string,
  transportMeta: Pick<ProjectProviderTransport, 'kind' | 'ctx'>,
  files: MachineRuntime['files'],
  projectFileSystem: IFileSystem,
  settings: ProjectSettingsProvider,
  dispose: () => void | Promise<void>,
  runtimeLease: Lease<MachineRuntime>,
  // gugu #2358: 非 git 项目没有 repo lease —— 三个 git 服务全部缺省。
  repoLease: Lease<IGitRepository> | undefined
): ProjectProvider {
  // Keep the project's `.gugu/` runtime state (attachments, uploads) out of the
  // user's `git status`. Best effort and non-blocking.
  if (repoLease) ensureEmdashGitExcludedSafe(projectFileSystem, repoPath, projectId);

  const gitRepository = repoLease ? new GitRepositoryService(repoLease.value, settings) : undefined;
  const transport: ProjectProviderTransport = {
    ...transportMeta,
    fileSystem: projectFileSystem,
    projectConfigPath: files.path.join(repoPath, PROJECT_CONFIG_FILE),
    resolveProjectPath: (relativePath) => files.path.join(repoPath, relativePath),
    configPathForDirectory: (directoryPath) => files.path.join(directoryPath, PROJECT_CONFIG_FILE),
    settings,
  };
  // gugu #2358: 非 git 项目无 git 仓 → 不建 fetch 服务、不订阅 repo 更新(否则底层 openWorktree 抛错)。
  const gitRepositoryFetchService = gitRepository
    ? new GitRepositoryFetchService(gitRepository, () => gitRepository.getBaseRemote())
    : undefined;
  gitRepositoryFetchService?.start();
  const unsubscribeRepoUpdates = repoLease
    ? repoLease.value.subscribe((update) => {
        events.emit(gitRepoUpdateChannel, { projectId, update });
      })
    : undefined;

  const releaseProjectLeases = async () => {
    unsubscribeRepoUpdates?.();
    await repoLease?.release();
    await runtimeLease.release();
  };

  const provider = new ProjectProvider(
    projectId,
    repoPath,
    transport,
    gitRepository,
    gitRepositoryFetchService,
    runtimeLease.value.git,
    async () => {
      await releaseProjectLeases();
      await dispose();
    }
  );
  return provider;
}
