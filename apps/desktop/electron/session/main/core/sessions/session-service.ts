import { err, ok, type Result } from '@gugu/session-shared';
import { eq } from 'drizzle-orm';
import { projectManager } from '@main/core/projects/project-manager';
import {
  workspaceBootstrapService,
  type WorkspaceBootstrapResult,
} from '@main/core/workspaces/workspace-bootstrap-service';
import { workspaceRegistry } from '@main/core/workspaces/workspace-registry';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { sessionProvisionedChannel } from '@shared/core/sessions/provisionEvents';
import type {
  CreateSessionError,
  CreateSessionParams,
  CreateSessionSuccess,
  ProvisionSessionResult,
  ProvisionWorkspaceError,
} from '@shared/core/sessions/create-session';
import { createSession } from './operations/createSession';
import { mapSessionRowToSession } from './utils';
import { enqueueCreationTurns } from './session-life-creation';
import type { TeardownSessionError } from './provision-session-error';
import { sessionWorkspaceManager } from './session-workspace-manager';

type ProvisionResult = ProvisionSessionResult & { sshConnectionId?: string };

/**
 * 一条会话的运行时挂载:它的工作区(文件系统、git、监视器)加上挂在会话上的 provider(会话本身、它的终端)。
 * 按会话 id 记;多条会话可以挂在同一个工作区上(工作区按引用计数)。
 */
/**
 * A never-run ACP session's first messages become its first pending rows once its workspace exists (which starts it):
 * a task page that created its own session provisions it right after creation. Idempotent (stable message ids);
 * the other creation entries admit theirs where they launch.
 */
async function admitFirstMessages(sessionId: string): Promise<void> {
  const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!row) throw new Error(`Session not found: ${sessionId}`);
  const session = mapSessionRowToSession(row);
  if (session.runtime === 'acp' && session.initialQueue?.length) enqueueCreationTurns(session);
}

export class SessionService {
  private readonly _mountPromises = new Map<string, Promise<ProvisionResult>>();

  async createSession(params: CreateSessionParams): Promise<Result<CreateSessionSuccess, CreateSessionError>> {
    return createSession(params);
  }

  /**
   * Provisions the workspace a session runs in: ensures the path is on disk, acquires the workspace
   * (running lifecycle scripts), builds the session's providers and registers the mount. Idempotent —
   * fast-paths when already mounted. Emits `session:provisioned` on success so the renderer can react
   * regardless of which path (renderer or automation) triggered it.
   */
  async provisionWorkspace(
    sessionId: string
  ): Promise<Result<ProvisionResult, ProvisionWorkspaceError>> {
    const [row] = await db
      .select({ projectId: sessions.projectId })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!row) throw new Error(`Session not found: ${sessionId}`);
    const { projectId } = row;

    const mountedWorkspaceId = sessionWorkspaceManager.getWorkspaceId(sessionId);
    const mountedWorkspace = mountedWorkspaceId ? workspaceRegistry.get(mountedWorkspaceId) : undefined;
    if (mountedWorkspaceId && mountedWorkspace) {
      const provisionResult: ProvisionResult = { path: mountedWorkspace.path, workspaceId: mountedWorkspaceId };
      events.emit(sessionProvisionedChannel, { sessionId, projectId, ...provisionResult });
      await admitFirstMessages(sessionId);
      return ok(provisionResult);
    }

    const result = await workspaceBootstrapService.ensureWorkspaceSetupForSession(sessionId);
    if (!result.success) return err(result.error);

    await this._register(sessionId, projectId, result.data);

    const provisionResult: ProvisionResult = {
      path: result.data.path,
      workspaceId: result.data.workspaceId,
    };
    events.emit(sessionProvisionedChannel, { sessionId, projectId, ...provisionResult });
    await admitFirstMessages(sessionId);
    return ok(provisionResult);
  }

  /**
   * Restore the in-memory mount required by session-page wake paths.
   * Concurrent callers share one normal provisioning operation.
   */
  async ensureSessionMounted(sessionId: string): Promise<ProvisionResult> {
    const inFlight = this._mountPromises.get(sessionId);
    if (inFlight) return inFlight;

    const promise = (async () => {
      const result = await this.provisionWorkspace(sessionId);
      if (!result.success) {
        throw new Error(`Session ${sessionId} workspace provisioning failed: ${result.error.type}`);
      }
      const mounted = sessionWorkspaceManager.getSession(sessionId);
      const workspace = workspaceRegistry.get(result.data.workspaceId);
      if (!mounted || !workspace) {
        throw new Error(`Session ${sessionId} workspace mount did not become ready`);
      }
      return { ...result.data, path: workspace.path };
    })();
    this._mountPromises.set(sessionId, promise);
    try {
      return await promise;
    } finally {
      if (this._mountPromises.get(sessionId) === promise) this._mountPromises.delete(sessionId);
    }
  }

  private async _register(
    sessionId: string,
    projectId: string,
    data: WorkspaceBootstrapResult
  ): Promise<void> {
    const project = projectManager.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    await sessionWorkspaceManager.registerSession(sessionId, data, projectId, project.ctx);

    await db
      .update(sessions)
      .set({ workspaceId: data.workspaceId })
      .where(eq(sessions.id, sessionId));
  }

  async teardown(
    sessionId: string,
    mode: Parameters<typeof sessionWorkspaceManager.teardownSession>[1] = 'terminate'
  ): Promise<Result<void, TeardownSessionError>> {
    return sessionWorkspaceManager.teardownSession(sessionId, mode);
  }
}

export const sessionService = new SessionService();
