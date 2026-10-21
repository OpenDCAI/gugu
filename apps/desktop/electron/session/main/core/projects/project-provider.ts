import type { IFileSystem } from '@gugu/session-core/files';
import { projectDirectoryHasNoGit } from './resolve-project-gitless';
import type {
  FetchError,
  GitBranchRef,
  GitHeadModel,
  GitSequences,
  IGitRuntime,
} from '@gugu/session-core/git';
import { ok, type IDisposable, type IReleasable, type Result } from '@gugu/session-shared';
import type { IExecutionContext } from '@gugu/session-core/exec';
import type { GitRepositoryFetchService } from '@main/core/git/repository/fetch-service';
import type { GitRepositoryService } from '@main/core/git/repository/service';
import { previewServerService } from '@main/core/preview-servers/preview-server-service-instance';
import { workspaceRegistry } from '@main/core/workspaces/workspace-registry';
import type { WorkspaceProviderData } from '@shared/core/workspaces/workspace-provider-data';
import type { ProjectRemoteState } from '@shared/projects';
import type { SessionProvider } from '../sessions/types';
import { sessionWorkspaceManager } from '../sessions/session-workspace-manager';
import type { TerminalProvider } from '../terminals/terminal-provider';
import type { ProjectSettingsProvider } from './settings/provider';
import { resolveTmuxEnabled } from './settings/resolve-tmux-enabled';

export type { WorkspaceProviderData };

export type ProvisionResult = {
  sessionMount: SessionMount;
  persistData: {
    workspaceId: string;
  };
};

/** 一条会话挂载出来的运行时:它的会话 provider、终端 provider,以及所在工作区的路径与分支。 */
export interface SessionMount {
  readonly sessionId: string;
  readonly sessionBranch: string | undefined;
  readonly sourceBranch: GitBranchRef | undefined;
  readonly sessionEnvVars: Record<string, string>;
  readonly sessions: SessionProvider;
  readonly terminals: TerminalProvider;
  /** Transport the task workspace runs on; external fork capture is local-only. */
  readonly workspaceKind: 'local';
  /** Absolute workspace path the task's agents run in. */
  readonly sessionPath: string;
}

/**
 * Transport-specific dependencies of a project provider.
 * Pure data — no lifecycle methods.
 */
export type ProjectProviderTransport = {
  readonly kind: string;
  readonly ctx: IExecutionContext;
  readonly fileSystem: IFileSystem;
  readonly projectConfigPath: string;
  /**
   * Transitional desktop-owned path helper. Remove once project config reads/writes
   * are served by the workspace server/core boundary instead of main-process adapters.
   */
  readonly resolveProjectPath: (relativePath: string) => string;
  /**
   * Transitional desktop-owned path helper. Remove with resolveProjectPath when
   * config target resolution moves behind the workspace server/core boundary.
   */
  readonly configPathForDirectory: (directoryPath: string) => string;
  /**
   * Project settings for this transport.
   */
  readonly settings: ProjectSettingsProvider;
};

export class ProjectProvider implements IReleasable, IDisposable {
  readonly type: string;
  readonly projectId: string;
  readonly repoPath: string;
  readonly settings: ProjectSettingsProvider;
  // gugu #2358: 非 git 项目(远程非 git 目录)没有 git 仓 —— 三个 git 服务缺省(undefined)。
  // 消费方必须显式处理缺省(tsc 强制),git 专属功能对这类项目降级为空/不可用。
  readonly gitRepository: GitRepositoryService | undefined;
  readonly fileSystem: IFileSystem;
  readonly projectConfigPath: string;
  readonly gitRepositoryFetchService: GitRepositoryFetchService | undefined;
  /** gugu #2358: true = 项目目录不是 git 仓库,git 服务全缺省。 */
  readonly isGitless: boolean;

  private readonly _ctx: IExecutionContext;
  private readonly _resolveProjectPath: (relativePath: string) => string;
  private readonly _configPathForDirectory: (directoryPath: string) => string;

  constructor(
    projectId: string,
    repoPath: string,
    transport: ProjectProviderTransport,
    gitRepository: GitRepositoryService | undefined,
    gitRepositoryFetchService: GitRepositoryFetchService | undefined,
    private readonly _gitRuntime: IGitRuntime,
    private readonly _releaseProjectLeases: () => void | Promise<void>
  ) {
    this.type = transport.kind;
    this.projectId = projectId;
    this.repoPath = repoPath;
    this._ctx = transport.ctx;
    this.settings = transport.settings;
    this.fileSystem = transport.fileSystem;
    this.projectConfigPath = transport.projectConfigPath;
    this._resolveProjectPath = transport.resolveProjectPath;
    this._configPathForDirectory = transport.configPathForDirectory;
    this.gitRepository = gitRepository;
    this.gitRepositoryFetchService = gitRepositoryFetchService;
    this.isGitless = gitRepository === undefined;
  }

  get ctx(): IExecutionContext {
    return this._ctx;
  }

  /**
   * Transitional desktop-owned path helper. See ProjectProviderTransport.
   */
  resolveProjectPath(relativePath: string): string {
    return this._resolveProjectPath(relativePath);
  }

  /**
   * Transitional desktop-owned path helper. See ProjectProviderTransport.
   */
  configPathForDirectory(directoryPath: string): string {
    return this._configPathForDirectory(directoryPath);
  }

  getRemoteState(): Promise<ProjectRemoteState> {
    // gugu #2358: 非 git 项目无远端。
    if (!this.gitRepository) return Promise.resolve({ hasRemote: false, selectedRemoteUrl: null });
    return this.gitRepository.getRemoteState();
  }

  fetch(): Promise<Result<{ sequences: GitSequences }, FetchError>> {
    // gugu #2358: 非 git 项目无可 fetch —— 返回空序列的成功值。
    if (!this.gitRepositoryFetchService) return Promise.resolve(ok({ sequences: {} }));
    return this.gitRepositoryFetchService.fetch();
  }

  async resolveGitless(): Promise<boolean> {
    return (
      this.isGitless ||
      (await projectDirectoryHasNoGit(this.repoPath, this.resolveProjectPath('.git'), this.fileSystem))
    );
  }

  async getProjectRootHead(): Promise<GitHeadModel> {
    // Non-Git directories have no HEAD. Recheck even when the provider is cached.
    if (await this.resolveGitless()) return { kind: 'unborn', name: '' };
    const lease = await this._gitRuntime.openWorktree(this.repoPath);
    try {
      return await lease.value.getHead();
    } finally {
      await lease.release();
    }
  }

  async release(): Promise<void> {
    this.gitRepositoryFetchService?.stop();
    const results = await Promise.allSettled([
      workspaceRegistry.releaseLeasesForProject(this.projectId),
      this._releaseProjectLeases(),
    ]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  async dispose(): Promise<void> {
    try {
      this.gitRepositoryFetchService?.stop();
      // 与 spawn 同一个答案(resolveTmuxEnabled):跑进 tmux 的会话退出时 detach,❌ 按项目存的种子判成 terminate。
      const mode = (await resolveTmuxEnabled(this.settings, this.projectId)) ? 'detach' : 'terminate';
      await sessionWorkspaceManager.teardownAllForProject(this.projectId, mode);
      await workspaceRegistry.teardownAllForProject(this.projectId, mode);
      await previewServerService.stopForProject(this.projectId);
    } finally {
      await this.release();
    }
  }
}
