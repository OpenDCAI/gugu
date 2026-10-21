import { ok } from '@gugu/session-shared';
import { LocalSessionProvider } from '@main/core/sessions/impl/local-session';
import type { SessionProvider } from '@main/core/sessions/types';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import { FileTreeProjector } from '@main/core/files/file-tree/projector';
import { GitRepositoryFetchService } from '@main/core/git/repository/fetch-service';
import { GitRepositoryService } from '@main/core/git/repository/service';
import { previewServerService } from '@main/core/preview-servers/preview-server-service-instance';
import type { RuntimeManager } from '@main/core/runtime/types';
import { workspaceFileIndexService } from '@main/core/search/workspace-file-index-service';
import { appSettingsService } from '@main/core/settings/settings-service';
import { resolveLocalAutomationShell } from '@main/core/terminal-shell/resolver';
import type { ResolvedShellProfile } from '@main/core/terminal-shell/types';
import { LocalTerminalProvider } from '@main/core/terminals/impl/local-terminal-provider';
import { runLifecycleScriptWithPolicy } from '@main/core/terminals/lifecycle-script-coordinator';
import type { TerminalProvider } from '@main/core/terminals/terminal-provider';
import type { Workspace } from '@main/core/workspaces/workspace';
import { LifecycleScriptService } from '@main/core/workspaces/workspace-lifecycle-service';
import { acquireWorkspaceRuntime } from './workspace-runtime';
import { type WorkspaceFactoryResult } from '@main/core/workspaces/workspace-registry';
import { handleGitWorktreeUpdate } from '@main/core/workspaces/workspace-worktree-update';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import type { IFileSystem } from '@gugu/session-core/files';
import { fileChangesChannel, fileTreeProjectionChannel } from '@shared/core/fs/fsEvents';
import {
  PROJECT_CONFIG_FILE,
  PROJECT_CONFIG_FILE_NAMES,
} from '@shared/core/project-settings/project-settings';
import { gitWorktreeUpdateChannel } from '@shared/core/git/events';
import type { MountedSession } from '@main/core/sessions/session-builder';
import { getEffectiveSessionSettings } from '../projects/settings/effective-session-settings';
import type { ProjectSettingsProvider } from '../projects/settings/provider';
import { resolveTmuxEnabled } from '../projects/settings/resolve-tmux-enabled';
import { TEARDOWN_SCRIPT_WAIT_MS } from '../sessions/provision-session-error';
import { getSessionEnvVars } from './workspace-env';

// 导出给 workspace-git-context(#7341:挂上来的文件夹按它自己的目录判 git)。
export type WorkspaceFactoryContext = {
  /** 第一次把这个工作区挂上的那条会话。 */
  session: MountedSession;
  workDir: string;
  projectId: string;
  projectPath: string;
  workspaceRuntime: { manager: Pick<RuntimeManager, 'acquire'> };
  settings: ProjectSettingsProvider;
  logPrefix: string;
  /** gugu #2358: 非 git 项目 —— 不开 git worktree,工作区无 git 服务,agent 直接在目录里跑。 */
  gitless?: boolean;
  /**
   * #7341 拿工作区时按哪个目录复查「还是不是 git」;不给 = `projectPath`(根目录与旧 worktree 行一直如此)。
   * 挂上来的文件夹是它自己的仓库或根本不是仓库,要照它自己的目录判(workspace-git-context.ts)。
   */
  gitProbePath?: string;
  /** Inject an existing repository service (e.g. the project-level singleton). */
  gitRepository?: GitRepositoryService;
  /** Inject an existing fetch service. When absent, the factory creates and manages one.
   *  Lifecycle (start/stop) is only managed by the factory when it creates the instance. */
  gitRepositoryFetchService?: GitRepositoryFetchService;
  extraHooks?: {
    onCreate?: (ws: Workspace) => Promise<void>;
    onDestroy?: (ws: Workspace) => Promise<void>;
    onDetach?: (ws: Workspace) => Promise<void>;
  };
};

/**
 * Returns a factory function suitable for passing to `WorkspaceRegistry.acquire`.
 * Constructs the workspace and wires lifecycle
 * script hooks. Provider-specific hooks (e.g. git watcher) are passed via `extraHooks`.
 */
export function createWorkspaceFactory(
  workspaceId: string,
  context: WorkspaceFactoryContext
): () => Promise<WorkspaceFactoryResult> {
  return async () => {
    const workDir = context.workDir;

    const ctx = new LocalExecutionContext();

    const runtime = await acquireWorkspaceRuntime(
      context.workspaceRuntime,
      workDir,
      context.gitless ?? false,
      context.gitless === undefined ? undefined : (context.gitProbePath ?? context.projectPath)
    );
    const { gitWorktree, fileTree, filesRuntime } = runtime;
    const openedFileSystem = filesRuntime.fileSystem();
    if (!openedFileSystem.success) {
      await runtime.release();
      throw new Error(`Failed to open file system: ${openedFileSystem.error.message}`);
    }
    const fileSystem = openedFileSystem.data;
    // 新名优先,读不到再看改名前那份 —— 队友仓里可能提交的还是旧名字。
    const configPath = await resolveWorkspaceConfigPath(fileSystem, (name) =>
      filesRuntime.path.join(workDir, name)
    );

    // Settings (shared)
    const projectSettings = await context.settings.get();
    const defaultBranch = await context.settings.getDefaultBranch();
    const bootstrapSessionEnvVars = getSessionEnvVars({
      session: context.session,
      sessionPath: workDir,
      projectPath: context.projectPath,
      defaultBranch,
      portSeed: workDir,
    });
    const resolveTmux = () => resolveTmuxEnabled(context.settings, context.projectId);
    const sessionLevelSettings = await getEffectiveSessionSettings({
      projectSettings: context.settings,
      sessionFs: fileSystem,
      sessionConfigPath: configPath,
    });
    const shellSetup = sessionLevelSettings.shellSetup ?? projectSettings.shellSetup;
    const scripts = sessionLevelSettings.scripts;

    // Workspace terminal provider (used only by lifecycle scripts)
    const workspaceTerminals = new LocalTerminalProvider({
      projectId: context.projectId,
      workspaceId,
      scopeId: workspaceId,
      sessionPath: workDir,
      tmux: resolveTmux,
      shellSetup,
      ctx,
      sessionEnvVars: bootstrapSessionEnvVars,
    });

    const lifecycleService = new LifecycleScriptService({
      projectId: context.projectId,
      workspaceId,
      terminals: workspaceTerminals,
    });

    // gugu #2358: 非 git 项目无 gitWorktree/gitRepository → git 服务全缺省。
    const gitRepository = gitWorktree
      ? context.gitRepository ?? new GitRepositoryService(gitWorktree.repository, context.settings)
      : undefined;

    const ownsFetchService = !context.gitRepositoryFetchService && !!gitRepository;
    const gitRepositoryFetchService = gitRepository
      ? context.gitRepositoryFetchService ??
        new GitRepositoryFetchService(gitRepository, () => gitRepository.getBaseRemote())
      : undefined;
    let unsubscribeGitUpdates: (() => void) | undefined;
    let unsubscribeFileChanges: (() => void) | undefined;

    const fileTreeProjector = new FileTreeProjector(fileTree, (update) =>
      events.emit(fileTreeProjectionChannel, {
        projectId: context.projectId,
        workspaceId,
        subscriptionId: update.subscriptionId,
        version: update.version,
        scopes: update.scopes,
      })
    );

    const watchedDirectories = new Set<() => void>();
    const workspace: Workspace = {
      watchDirectory: (dirPath) => {
        const watched = filesRuntime.watchDirectory(dirPath);
        if (!watched.success) return watched;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          watchedDirectories.delete(release);
          watched.data();
        };
        watchedDirectories.add(release);
        return ok(release);
      },
      nudge: () => filesRuntime.nudge(workDir),
      id: workspaceId,
      path: workDir,
      configPath,
      fileSystem,
      fileTree,
      fileTreeProjector,
      gitWorktree,
      settings: context.settings,
      lifecycleService,
      gitRepository,
      gitRepositoryFetchService,
      dispose: async () => {
        unsubscribeGitUpdates?.();
        unsubscribeGitUpdates = undefined;
        fileTreeProjector.dispose();
        unsubscribeFileChanges?.();
        unsubscribeFileChanges = undefined;
        for (const release of [...watchedDirectories]) release();
        await runtime.release();
      },
    };

    const { logPrefix } = context;

    return {
      workspace,

      onCreateSideEffect: (ws) => {
        void workspaceFileIndexService.onWorkspaceActivated(workspaceId, {
          rootPath: ws.path,
          enumerate: (root, options) => {
            const fs = filesRuntime.fileSystem();
            return fs.success ? fs.data.enumerate(root, options) : fs;
          },
        });
        // gugu #2358: 非 git 工作区无 gitWorktree,不订阅 git 更新。
        if (ws.gitWorktree) {
          const gitWorktree = ws.gitWorktree;
          unsubscribeGitUpdates = gitWorktree.subscribe((update) =>
            handleGitWorktreeUpdate(workspaceId, update, (emitted) => {
              events.emit(gitWorktreeUpdateChannel, {
                projectId: context.projectId,
                workspaceId,
                update: emitted,
              });
            })
          );
        }
        // 这条变更流是共享的:编辑器里打开的任何文件(哪怕在 dist/、build/、.claude/ 下)、HTML 预览引用的资源、
        // 项目设置、文件索引都从这里拿。所以 ❌ 拿搜索索引的边界剪它 —— 那会让 dist/ 下打开的页签永远收不到变化;
        // 索引自己在 applyChanges 里照自己的边界再筛一遍。
        // 只剪 .git 与 node_modules:这两处的事件量最大(一次 pnpm install、一次 git gc),而 .git 里的变化另有 git 的
        // watcher 管。写成一条 alternation:@parcel/watcher 对每条 glob 逐 entry 各跑一遍正则。
        // 它不是 coarse 的:Linux 上它只看打开着的文件所在的目录(workspace.watchDirectory)和展开着的目录,
        // 不收 nudge —— 对它的消费者来说 resync 就是重载预览、重读所有页签(见 @@@tree-by-directories)。
        const fileChanges = filesRuntime.watchChanges(workDir, (update) => {
          events.emit(fileChangesChannel, {
            projectId: context.projectId,
            workspaceId,
            update,
          });
          workspaceFileIndexService.onWorkspaceFileChange(workspaceId, update);
        }, {
          ignore: ['**/{.git,node_modules}/**'],
        });
        if (fileChanges.success) {
          unsubscribeFileChanges = fileChanges.data.unsubscribe;
          void fileChanges.data.ready().then((result) => {
            if (!result.success) {
              log.warn('WorkspaceFactory: file change feed failed to become ready', {
                workspaceId,
                error: result.error,
              });
            }
          });
        } else {
          log.warn('WorkspaceFactory: failed to start file change feed', {
            workspaceId,
            error: fileChanges.error,
          });
        }

        if (ownsFetchService) {
          gitRepositoryFetchService?.start();
        }
        void (async () => {
          if (scripts?.setup && (projectSettings.autoRunSetupScriptOnSessionCreation ?? true)) {
            const setupResult = await runLifecycleScriptWithPolicy({
              workspace: ws,
              projectId: context.projectId,
              workspaceId,
              type: 'setup',
              script: scripts.setup,
              shellSetup,
              origin: 'auto-setup',
              policy: {
                respawnAfterExit: true,
                logFailure: true,
                surfaceFailure: true,
                continueOnFailure: true,
              },
              logPrefix,
            });
            if (setupResult.kind !== 'succeeded') return;
          }

          if (scripts?.run && (projectSettings.autoRunRunScriptOnSessionCreation ?? false)) {
            await runLifecycleScriptWithPolicy({
              workspace: ws,
              projectId: context.projectId,
              workspaceId,
              type: 'run',
              script: scripts.run,
              shellSetup,
              origin: 'auto-run',
              policy: {
                respawnAfterExit: true,
                logFailure: true,
                surfaceFailure: true,
                continueOnFailure: true,
              },
              logPrefix,
            });
          }
        })();
      },

      onCreate: context.extraHooks?.onCreate,

      onDestroy: async (ws) => {
        await previewServerService.stopForWorkspace(context.projectId, workspaceId);
        if (ownsFetchService) {
          gitRepositoryFetchService?.stop();
        }
        workspaceFileIndexService.onWorkspaceDeactivated(workspaceId);
        const latestProjectSettings = await context.settings.get();
        const latestSessionSettings = await getEffectiveSessionSettings({
          projectSettings: context.settings,
          sessionFs: ws.fileSystem,
          sessionConfigPath: ws.configPath,
        });
        const latestShellSetup = latestSessionSettings.shellSetup ?? latestProjectSettings.shellSetup;
        const teardownScript = latestSessionSettings.scripts?.teardown;

        if (teardownScript) {
          await runLifecycleScriptWithPolicy({
            workspace: ws,
            projectId: context.projectId,
            workspaceId,
            type: 'teardown',
            script: teardownScript,
            shellSetup: latestShellSetup,
            origin: 'workspace-destroy',
            policy: {
              timeoutMs: TEARDOWN_SCRIPT_WAIT_MS,
              logFailure: true,
              surfaceFailure: false,
              continueOnFailure: true,
            },
            logPrefix,
          });
        }
        await context.extraHooks?.onDestroy?.(ws);
      },

      onDetach: async (ws) => {
        await previewServerService.stopForWorkspace(context.projectId, workspaceId);
        await context.extraHooks?.onDetach?.(ws);
      },
    };
  };
}

type SessionMountOpts = {
  projectId: string;
  sessionId: string;
  workspaceId: string;
  sessionPath: string;
  tmuxEnabled: boolean | (() => Promise<boolean>);
  shellSetup?: string;
  sessionEnvVars: Record<string, string>;
};

async function resolveLocalSessionShellProfile(): Promise<ResolvedShellProfile> {
  const { defaultShell } = await appSettingsService.get('terminal');
  return await resolveLocalAutomationShell({ intent: defaultShell });
}

/**
 * Creates the session-scoped conversation and terminal providers.
 */
export async function buildSessionProviders(
  opts: SessionMountOpts
): Promise<{ sessions: SessionProvider; terminals: TerminalProvider }> {
  const ctx = new LocalExecutionContext();
  const sessionShellProfile = await resolveLocalSessionShellProfile();
  return {
    sessions: new LocalSessionProvider({
      projectId: opts.projectId,
      sessionPath: opts.sessionPath,
      workspaceId: opts.workspaceId,
      tmux: opts.tmuxEnabled,
      shellSetup: opts.shellSetup,
      shellProfile: sessionShellProfile,
      ctx,
      sessionEnvVars: opts.sessionEnvVars,
    }),
    terminals: new LocalTerminalProvider({
      projectId: opts.projectId,
      workspaceId: opts.workspaceId,
      scopeId: opts.sessionId,
      sessionPath: opts.sessionPath,
      tmux: opts.tmuxEnabled,
      shellSetup: opts.shellSetup,
      ctx,
      sessionEnvVars: opts.sessionEnvVars,
    }),
  };
}

/**
 * Resolves the task-level environment variables and settings from an already-acquired workspace.
 * Used by providers after `workspaceRegistry.acquire` to avoid duplicating settings reads.
 */
export async function resolveSessionEnv(
  session: MountedSession,
  workspace: Pick<Workspace, 'path' | 'fileSystem' | 'configPath'>,
  projectPath: string,
  settings: ProjectSettingsProvider,
  projectId?: string
): Promise<{
  sessionEnvVars: Record<string, string>;
  tmuxEnabled: boolean | (() => Promise<boolean>);
  shellSetup?: string;
}> {
  const projectSettings = await settings.get();
  const defaultBranch = await settings.getDefaultBranch();
  const sessionLevelSettings = await getEffectiveSessionSettings({
    projectSettings: settings,
    sessionFs: workspace.fileSystem,
    sessionConfigPath: workspace.configPath,
  });
  return {
    sessionEnvVars: getSessionEnvVars({
      session,
      sessionPath: workspace.path,
      projectPath,
      defaultBranch,
      portSeed: workspace.path,
    }),
    tmuxEnabled: () => resolveTmuxEnabled(settings, projectId),
    shellSetup: sessionLevelSettings.shellSetup ?? projectSettings.shellSetup,
  };
}

async function resolveWorkspaceConfigPath(
  fileSystem: Pick<IFileSystem, 'exists'>,
  join: (name: string) => string
): Promise<string> {
  for (const name of PROJECT_CONFIG_FILE_NAMES) {
    const candidate = join(name);
    const found = await fileSystem.exists(candidate);
    if (found.success && found.data) return candidate;
  }
  return join(PROJECT_CONFIG_FILE);
}
