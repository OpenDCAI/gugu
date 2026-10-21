import { isUnregisteredProject } from '@renderer/features/projects/stores/project';
import {
  asMounted,
  getProjectManagerStore,
} from '@renderer/features/projects/stores/project-selectors';
import { rpc } from '@renderer/lib/ipc';
import {
  IMPLICIT_SESSION_HOME_PROJECT_ID,
  IMPLICIT_SESSION_HOME_PROJECT_NAME,
} from './session-home-project-constants';

let ensurePromise: Promise<string | undefined> | null = null;

/**
 * 隐藏工作区准备失败是**已知产品错误**，所以这里只抛稳定语义码，不抛成品文案：
 * 文案在 render boundary（新建会话页）按当前 locale 映射。`detail` 是底层原始诊断，
 * 原样带出、不改写，也不进 catalog。
 */
export type ImplicitSessionHomeProjectFailure =
  /** 解析成功但没有可用的工作区 id —— 只能请用户自己选一个项目。 */
  | 'unavailable'
  | 'pending'
  | 'create-failed'
  | 'open-failed';

export class ImplicitSessionHomeProjectError extends Error {
  constructor(
    readonly reason: ImplicitSessionHomeProjectFailure,
    readonly detail?: string
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'ImplicitSessionHomeProjectError';
  }
}

/**
 * Resolve the hidden app-owned project used by the task composer when no
 * repository has been selected. This is an app-owned ordinary directory;
 * running a task must not depend on Git metadata being present.
 */
/**
 * 只管本机:别的机器上没选项目的会话落在那台机器的主目录项目里(#6264,remoteHostsStore.ensureHomeProject)。
 */
export async function ensureImplicitSessionHomeProjectId(): Promise<string | undefined> {
  if (ensurePromise) return ensurePromise;
  const homeId = IMPLICIT_SESSION_HOME_PROJECT_ID;

  const promise = (async () => {
    const projectManager = getProjectManagerStore();
    // Wait for the normal project hydration so an existing task-home project is
    // reused instead of racing a second registration against the initial load.
    await projectManager.load();

    const existing = projectManager.projects.get(homeId);
    if (existing) {
      if (isUnregisteredProject(existing)) {
        // A previous attempt can leave an unregistered error sentinel behind.
        // Remove it so the next attempt can recover instead of returning an id
        // that can never acquire a mounted ProjectSessionsStore.
        if (!projectManager.pendingCreationIds.has(existing.id)) {
          projectManager.removeUnregisteredProject(existing.id);
        } else {
          throw new ImplicitSessionHomeProjectError('pending');
        }
      } else {
        await projectManager.mountProject(existing.id);
        return requireMountedProjectId(projectManager, existing.id);
      }
    }

    const path = await rpc.app.getSessionHomeDir();
    let projectId: string | undefined;
    try {
      projectId = await projectManager.createProject(
        { type: 'local' },
        {
          mode: 'pick',
          path,
          name: IMPLICIT_SESSION_HOME_PROJECT_NAME,
          initGitRepository: false,
          allowNonGit: true,
        },
        homeId
      );
    } catch (error) {
      removeFailedImplicitProject(projectManager, homeId);
      throw error;
    }
    if (!projectId) {
      removeFailedImplicitProject(projectManager, homeId);
      throw new ImplicitSessionHomeProjectError('create-failed');
    }

    // createProject registers the project and starts mounting it, but its
    // completion intentionally does not await the mount. Await the same mount
    // promise here so a resolved helper always yields a usable ProjectSessionsStore.
    await projectManager.mountProject(projectId);
    return requireMountedProjectId(projectManager, projectId);
  })().finally(() => {
    ensurePromise = null;
  });
  ensurePromise = promise;
  return promise;
}

function requireMountedProjectId(
  projectManager: ReturnType<typeof getProjectManagerStore>,
  projectId: string
): string {
  const project = projectManager.projects.get(projectId);
  if (asMounted(project)) return projectId;
  throw new ImplicitSessionHomeProjectError('open-failed', project?.error);
}

function removeFailedImplicitProject(
  projectManager: ReturnType<typeof getProjectManagerStore>,
  homeId: string
): void {
  for (const project of projectManager.projects.values()) {
    if (project.id !== homeId) continue;
    if (isUnregisteredProject(project) && !projectManager.pendingCreationIds.has(project.id)) {
      projectManager.removeUnregisteredProject(project.id);
    }
  }
}

export { IMPLICIT_SESSION_HOME_PROJECT_NAME } from './session-home-project-constants';
