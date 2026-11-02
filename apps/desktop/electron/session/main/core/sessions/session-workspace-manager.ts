import { LifecycleMap } from '@gugu/session-shared';
import { ok, type Result } from '@gugu/session-shared';
import type { IExecutionContext } from '@gugu/session-core/exec';
import { killTmuxSession, makeTmuxSessionName } from '@main/core/pty/tmux-session-name';
import { getSessionLeafIds } from '@main/core/sessions/session-targets';
import type { WorkspaceBootstrapResult } from '@main/core/workspaces/workspace-bootstrap-service';
import { workspaceRegistry, type TeardownMode } from '@main/core/workspaces/workspace-registry';
import { HookCore, type Hookable } from '@main/lib/hookable';
import { log } from '@main/lib/logger';
import { makePtySessionId } from '@shared/core/pty/ptySessionId';
import type { SessionBootstrapStatus } from '@shared/core/sessions/create-session';
import type { WorkspaceType as SharedWorkspaceType } from '@shared/core/workspaces/workspaces';
import type {
  ProvisionResult,
  SessionMount,
} from '../projects/project-provider';
import { withTimeout } from '../projects/utils';
import {
  formatProvisionSessionError,
  formatTeardownSessionError,
  SESSION_TIMEOUT_MS,
  toTeardownError,
  type ProvisionSessionError,
  type TeardownSessionError,
} from './provision-session-error';

export type WorkspaceHint = {
  id: string;
  type: SharedWorkspaceType;
  path?: string;
};

type StoredSession = ProvisionResult & { projectId: string; ctx: IExecutionContext };

export type SessionManagerHooks = {
  'session:provisioned': (info: {
    projectId: string;
    sessionId: string;
    branchName: string | undefined;
    workspaceId: string;
  }) => void | Promise<void>;
  'session:torn-down': (info: {
    projectId: string;
    sessionId: string;
    workspaceId: string;
    // @@@sessionpage TASKPAGE-FUSION — which teardown this was: what happened to the RUNTIME, not whether
    // the session still exists. App/project shutdown uses `terminate` too when tmux is off, and that session is
    // still there. A subscriber that projects session existence elsewhere (gugu: agent 联系人) must take death
    // from persisted task inventory, never from this mode (#6168).
    mode: SessionTeardownMode;
  }) => void | Promise<void>;
};

/**
 * Task-level teardown intent. Wider than {@link TeardownMode} because archive needs to
 * reap the running agent like `terminate` while keeping the workspace like `detach`:
 *
 * - `detach`: leave tmux sessions and agent processes running so the task can be
 *   remounted later (used on app/project shutdown when tmux is enabled).
 * - `terminate`: reap tmux sessions + agent processes and destroy the workspace
 *   (worktree removal, teardown script). Used by delete.
 * - `archive`: reap tmux sessions + agent processes like `terminate`, but keep the
 *   workspace/worktree (and the persisted `sessions.provider_session_id`) so the task stays
 *   restorable. Without this, archiving a tmux-backed task leaked its session and agent
 *   process indefinitely (#2689).
 */
export type SessionTeardownMode = TeardownMode | 'archive';

/** teardown 要问「这条会话上还有什么在跑」,而 ACP 那半边只有 id 能问。 */
export type SessionIdentity = { projectId: string; sessionId: string };

/**
 * 停掉这个任务在 ACP 运行时里的会话。
 *
 * 为什么是**注入**而不是 import:ACP 运行时的 host 在模块加载时就建自己的 scope,而本模块是 session-main
 * 的中心件 —— 静态引它等于让每个碰过任务生命周期的模块都拖起那套东西。宿主组合根本来就同时认识两边
 * (它装 `setEmdashPlatformRelease` 那批钩子也是这个形状),由它把这条腿递进来。
 */
export type SessionAcpSessionStopper = (session: SessionIdentity, mode: Exclude<SessionTeardownMode, 'detach'>) => Promise<void>;

let stopAcpSessionsForSession: SessionAcpSessionStopper | null = null;

export function setSessionAcpSessionStopper(stopper: SessionAcpSessionStopper | null): void {
  stopAcpSessionsForSession = stopper;
}

export async function executeTeardown(
  mount: SessionMount,
  workspaceId: string,
  mode: SessionTeardownMode,
  session: SessionIdentity
): Promise<void> {
  if (mode === 'detach') {
    // Keep the tmux sessions and agent processes alive for a later remount.
    await mount.sessions.detachAll();
    await mount.terminals.detachAll();
  } else {
    // 'terminate' and 'archive' both reap the tmux sessions and agent processes.
    await mount.sessions.destroyAll();
    await mount.terminals.destroyAll();
    // @@@4467 任务结束有**两条腿**。上面那条是 `SessionMount` 手里的 PTY 会话;ACP 会话不在它手里 ——
    // 它们活在 ACP worker 的 session manager 里,只认自己的 `stopSession`。少了这条腿,归档在用户眼里
    // 结束了,而那条会话的**平台令牌从没被结清**:那份带中转令牌的 0600 settings 文档留在盘上,
    // 续期定时器每两分钟替一条不存在的会话续命(#4467 实测 3/3)。
    // ❌ 不在这里另写一套结清:结清挂在 `stopSession` 上(runtime 的 removeRecord 通知宿主 release),
    // 一个 producer 一个真相 —— 这里只负责让这条腿也走一遍它自己的 stop。
    if (stopAcpSessionsForSession) {
      await stopAcpSessionsForSession(session, mode);
    } else {
      // 没接上 = 宿主组合根漏了接线,不是「这个任务没有 ACP 会话」。响亮记一笔:静默跳过会让
      // 「归档后令牌没结清」以「日志安静」的形态活下去,而这正是 #4467 的病灶形状。
      log.error('SessionManager: no ACP session stopper is wired; session teardown left its ACP arm undone', {
        projectId: session.projectId,
        sessionId: session.sessionId,
      });
    }
  }
  // Only 'terminate' destroys the workspace (worktree + teardown script). 'archive'
  // keeps the worktree alive, same as 'detach', so Restore can resume the task.
  await workspaceRegistry.teardown(workspaceId, mode === 'terminate' ? 'terminate' : 'detach');
}

export async function cleanupDetachedSessions(
  projectId: string,
  sessionId: string,
  ctx: IExecutionContext
): Promise<void> {
  const { terminalIds } = await getSessionLeafIds(sessionId);
  const sessionIds = [sessionId, ...terminalIds].map((leafId) =>
    makePtySessionId(projectId, sessionId, leafId)
  );
  await Promise.all(
    sessionIds.map((ptySessionId) => killTmuxSession(ctx, makeTmuxSessionName(ptySessionId)))
  );
}

class SessionWorkspaceManager {
  private readonly _hooks = new HookCore<SessionManagerHooks>((name, e) =>
    log.error(`SessionManager: ${String(name)} hook error`, e)
  );
  private readonly _lifecycle = new LifecycleMap<StoredSession, ProvisionSessionError, TeardownSessionError>(
    {
      postTeardown: (sessionId, stored) => {
        this._sessionsByProject.get(stored.projectId)?.delete(sessionId);
        // LifecycleMap's postTeardown carries no mode, so teardownSession parks it here for the hook.
        // Absent (a teardown routed some other way) → the safe default is the one that really ends the
        // session: subscribers already reconcile against live state, so a spurious "detach" would be the
        // reading that silently keeps dead things alive.
        const mode = this._teardownModes.get(sessionId) ?? 'terminate';
        this._teardownModes.delete(sessionId);
        this._hooks.callHookBackground('session:torn-down', {
          projectId: stored.projectId,
          sessionId,
          workspaceId: stored.persistData.workspaceId,
          mode,
        });
      },
    }
  );
  private readonly _sessionsByProject = new Map<string, Set<string>>();
  /** conversationId → the mode of the teardown currently in flight (read + cleared by postTeardown). */
  private readonly _teardownModes = new Map<string, SessionTeardownMode>();

  readonly hooks: Hookable<SessionManagerHooks> = this._hooks;

  /**
   * Registers a session's fully-provisioned mount into the lifecycle map.
   * Idempotent — if the session is already mounted, returns immediately.
   * Fires `session:provisioned` hook for telemetry, git watchers, PR sync.
   */
  async registerSession(
    sessionId: string,
    result: WorkspaceBootstrapResult,
    projectId: string,
    ctx: IExecutionContext
  ): Promise<void> {
    const stored: StoredSession = {
      sessionMount: result.sessionMount,
      persistData: {
        workspaceId: result.workspaceId,
      },
      projectId,
      ctx,
    };

    // Use provision() for deduplication: if already active, returns existing immediately.
    await this._lifecycle.provision(sessionId, async () => ok(stored));

    const byProject = this._sessionsByProject.get(projectId) ?? new Set<string>();
    byProject.add(sessionId);
    this._sessionsByProject.set(projectId, byProject);

    this._hooks.callHookBackground('session:provisioned', {
      projectId,
      sessionId,
      branchName: result.sessionMount.sessionBranch,
      workspaceId: result.workspaceId,
    });
  }

  async teardownSession(
    sessionId: string,
    mode: SessionTeardownMode = 'terminate'
  ): Promise<Result<void, TeardownSessionError>> {
    this._teardownModes.set(sessionId, mode);
    const result = this._lifecycle.teardown(
      sessionId,
      async ({ sessionMount, persistData, projectId, ctx }) => {
        try {
          await withTimeout(
            executeTeardown(sessionMount, persistData.workspaceId, mode, { projectId, sessionId }),
            SESSION_TIMEOUT_MS
          );
          return ok();
        } catch (e) {
          log.error('SessionManager: failed to teardown session', { sessionId, error: String(e) });
          await cleanupDetachedSessions(projectId, sessionId, ctx).catch((cleanupError) => {
            log.warn('SessionManager: fallback cleanup failed', {
              sessionId,
              error: String(cleanupError),
            });
          });
          return { success: false as const, error: toTeardownError(e) };
        }
      }
    );

    return result ?? ok();
  }

  async teardownAllForProject(projectId: string, mode: TeardownMode): Promise<void> {
    const sessionIds = Array.from(this._sessionsByProject.get(projectId) ?? []);
    if (mode === 'detach') {
      // Detach sessions but leave workspaces alive; provider.cleanup() will call
      // workspaceRegistry.teardownAllForProject to handle workspace teardown.
      await Promise.all(
        sessionIds.flatMap((id) => {
          const stored = this._lifecycle.get(id);
          if (!stored) return [];
          return [
            stored.sessionMount.sessions.detachAll(),
            stored.sessionMount.terminals.detachAll(),
          ];
        })
      );
      // Remove entries from lifecycle maps without running workspace teardown.
      this._sessionsByProject.delete(projectId);
      await Promise.all(
        sessionIds.map((id) => this._lifecycle.teardown(id, async () => ok()) ?? Promise.resolve(ok()))
      );
    } else {
      // teardownSession handles _sessionsByProject cleanup in onFinally.
      await Promise.all(sessionIds.map((id) => this.teardownSession(id, 'terminate')));
    }
  }

  getSession(sessionId: string): SessionMount | undefined {
    return this._lifecycle.get(sessionId)?.sessionMount;
  }

  getWorkspaceId(sessionId: string): string | undefined {
    return this._lifecycle.get(sessionId)?.persistData.workspaceId;
  }

  getPersistData(sessionId: string): ProvisionResult['persistData'] | undefined {
    return this._lifecycle.get(sessionId)?.persistData;
  }

  getBootstrapStatus(sessionId: string): SessionBootstrapStatus {
    const s = this._lifecycle.bootstrapStatus(sessionId);
    if (s.status === 'error')
      return { status: 'error', message: formatProvisionSessionError(s.error) };
    return s;
  }

  getTeardownStatus(sessionId: string): SessionBootstrapStatus {
    const s = this._lifecycle.teardownStatus(sessionId);
    if (s.status === 'error') return { status: 'error', message: formatTeardownSessionError(s.error) };
    return s;
  }
}

export const sessionWorkspaceManager = new SessionWorkspaceManager();
