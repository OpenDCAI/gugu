import { err, ok, type Result } from '@gugu/session-shared';
import { eq } from 'drizzle-orm';
import { projectManager } from '@main/core/projects/project-manager';
import type { ProjectProvider, SessionMount } from '@main/core/projects/project-provider';
import { runtimeManager } from '@main/core/runtime/runtime-manager';
import {
  buildSessionFromWorkspace,
  emitSessionProvisionProgress,
  type MountedSession,
} from '@main/core/sessions/session-builder';
import { db as appDb, type AppDb } from '@main/db/client';
import { sessions, workspaces } from '@main/db/schema';
import type { ProvisionWorkspaceError } from '@shared/core/sessions/create-session';
import { log } from '@main/lib/logger';
import type { WorkspaceType } from '@shared/core/workspaces/workspaces';
import { isRetiredRemoteWorkspace } from './resolve-workspace-kind';
import { createWorkspaceFactory } from './workspace-factory';
import { workspaceGitContext, type WorkspaceGitContext } from './workspace-git-context';
import { workspaceRegistry } from './workspace-registry';

export type WorkspaceBootstrapResult = {
  path: string;
  workspaceId: string;
  sessionMount: SessionMount;
};

/**
 * 项目还没在这个进程里打开时,当场打开(与渲染层 / 启动时 `openAllEmdashProjects` 同一个入口,并发打开同一个项目只开一次)。
 * 返回 null = 打不开(库里没有、目录没了)。
 */
export type OpenProjectOnDemand = (projectId: string) => Promise<ProjectProvider | null>;

async function openProjectOnDemand(projectId: string): Promise<ProjectProvider | null> {
  const { openProject } = await import('@main/core/projects/operations/openProject');
  const opened = await openProject(projectId);
  if (!opened.success) {
    log.warn('ensureWorkspaceSetupForSession: project could not be opened on demand', { projectId, error: opened.error });
    return null;
  }
  return projectManager.getProject(projectId) ?? null;
}

export class WorkspaceBootstrapService {
  constructor(
    private readonly db: AppDb,
    private readonly openOnDemand: OpenProjectOnDemand = openProjectOnDemand
  ) {}

  /**
   * Resolves where a session runs, acquires that workspace (running lifecycle
   * scripts), and builds the session's providers.
   *
   * A session always runs in a workspace that already exists — the project's own working
   * tree. No git setup is performed: the product does not create branches or worktrees for
   * a session, and a session that wants isolation creates its own from inside the session.
   */
  async ensureWorkspaceSetup(
    workspaceRow: {
      id: string;
      type: WorkspaceType;
      kind?: string | null;
      location?: 'local' | 'remote' | null;
      path: string | null;
    },
    session: MountedSession,
    project: ProjectProvider
  ): Promise<Result<WorkspaceBootstrapResult, ProvisionWorkspaceError>> {
    if (isRetiredRemoteWorkspace(workspaceRow)) {
      return err({
        type: 'setup-failed',
        stepKind: 'byoi-config',
        stepErrorType: 'retired',
        message: '这条会话用的「自带机器」/ SSH 工作区已下线,不能再运行',
      });
    }

    // Everything else runs in the directory its row names (the project's repository workspace,
    // `ensureRepositoryWorkspace`, writes it with the row). A row without one says nowhere to run.
    // #7341 挂在项目下的文件夹也走这一格:会话就在那一行记着的路径里开工,git 跟着那个文件夹走。
    if (!workspaceRow.path) return err({ type: 'no-intent' });
    return this._acquireAndBuild(
      workspaceRow.id,
      session,
      project,
      workspaceRow.path,
      workspaceGitContext(project, { kind: workspaceRow.kind, path: workspaceRow.path })
    );
  }

  /**
   * Public entry point for the RPC controller.
   * Loads the session + workspace rows from DB, resolves the project,
   * and delegates to `ensureWorkspaceSetup`.
   */
  async ensureWorkspaceSetupForSession(
    sessionId: string
  ): Promise<Result<WorkspaceBootstrapResult, ProvisionWorkspaceError>> {
    const [row] = await this.db
      .select({
        id: sessions.id,
        title: sessions.title,
        projectId: sessions.projectId,
        workspaceId: sessions.workspaceId,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!row?.workspaceId) return err({ type: 'missing-workspace' });

    const [wsRow] = await this.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, row.workspaceId))
      .limit(1);
    if (!wsRow) return err({ type: 'missing-workspace' });

    // ⚠️ 不能假定项目已经打开:咕咕 server 没有渲染层,项目靠启动时 `openAllEmdashProjects` 一个个打开,
    // 而重启前那些 agent(tmux 里活着)拿着旧卡来敲门、云端投递来唤醒会话,都可能赶在它打开之前(#6264,
    // 2026-09-25 d22:重启后 6 秒内来敲门的两条会话报 `Project … not found`,MCP 回 401,44 个咕咕工具就此失效)。
    const project =
      projectManager.getProject(row.projectId) ?? (await this.openOnDemand(row.projectId));
    if (!project) throw new Error(`Project ${row.projectId} not found`);

    return this.ensureWorkspaceSetup(wsRow, { id: row.id, title: row.title }, project);
  }

  /**
   * Acquires the workspace via the registry (runs lifecycle scripts on first
   * acquire) then builds task providers. Returns a `WorkspaceBootstrapResult`.
   */
  private async _acquireAndBuild(
    workspaceId: string,
    session: MountedSession,
    project: ProjectProvider,
    workDir: string,
    git: WorkspaceGitContext
  ): Promise<Result<WorkspaceBootstrapResult, ProvisionWorkspaceError>> {
    emitSessionProvisionProgress({
      sessionId: session.id,
      projectId: project.projectId,
      step: 'initialising-workspace',
      message: 'Initialising workspace…',
    });

    // #5331 转圈那一段的两大发就在这里:拿工作区(建 worktree + 首次 acquire 跑 lifecycle 脚本)
    // 与搭 provider(其中包含起会话)。用户从头到尾看到的是同一个转圈,而这两段从前一个读数都没有。
    const provisionStartedAt = Date.now();
    let acquired;
    try {
      acquired = await workspaceRegistry.acquire(
        workspaceId,
        project.projectId,
        createWorkspaceFactory(workspaceId, {
          session,
          workDir,
          projectId: project.projectId,
          projectPath: project.repoPath,
          workspaceRuntime: { manager: runtimeManager },
          settings: project.settings,
          logPrefix: 'WorkspaceBootstrapService',
          ...git,
        })
      );
    } catch (e) {
      return err({
        type: 'setup-failed',
        stepKind: 'workspace-acquire',
        stepErrorType: 'error',
        message: String(e),
      });
    }

    const acquireMs = Date.now() - provisionStartedAt;

    emitSessionProvisionProgress({
      sessionId: session.id,
      projectId: project.projectId,
      step: 'starting-sessions',
      message: 'Preparing task…',
    });

    const buildStartedAt = Date.now();
    let buildSucceeded = false;
    try {
      const buildResult = await buildSessionFromWorkspace(
        session,
        acquired.workspace,
        project.projectId,
        project.repoPath,
        project.settings
      );
      buildSucceeded = true;
      log.info('WorkspaceBootstrapService:provision stages', {
        sessionId: session.id,
        projectId: project.projectId,
        acquireMs,
        buildMs: Date.now() - buildStartedAt,
        totalMs: Date.now() - provisionStartedAt,
      });
      return ok({
        path: workDir,
        workspaceId,
        sessionMount: buildResult.sessionMount,
      });
    } catch (e) {
      return err({
        type: 'setup-failed',
        stepKind: 'build-providers',
        stepErrorType: 'error',
        message: String(e),
      });
    } finally {
      if (!buildSucceeded) {
        await workspaceRegistry.teardown(workspaceId, 'terminate').catch(() => {});
      }
    }
  }
}

export const workspaceBootstrapService = new WorkspaceBootstrapService(appDb);
